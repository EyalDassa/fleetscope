import type { Collector } from "@fleetscope/collector";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import type { DockerFleet } from "./docker";
import type { RunOptions } from "./options";
import { sessionSeed } from "./rng";
import { runFleet } from "./run";
import { SCENARIO_NAMES } from "./scenarios";
import type { SessionResult, SessionSpec } from "./session-runner";

const logger = pino({ level: "silent" });
const config = loadConfig({});
const fleets = new Map([["chromium", {} as DockerFleet]]) as ReadonlyMap<"chromium", DockerFleet>;

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    engines: ["chromium"],
    sessions: 9,
    concurrency: 3,
    scenario: "mix",
    seed: 5,
    agentId: "test",
    sessionTimeoutMs: 1000,
    ...overrides,
  };
}

function fakeCollector(stats = { pushed: 10, sent: 8, duplicates: 1, dropped: 1, pending: 0 }) {
  const close = vi.fn(async () => undefined);
  const collector = { close, stats: () => stats } as unknown as Collector;
  return { collector, close };
}

function result(spec: SessionSpec): SessionResult {
  return {
    index: spec.index,
    sessionId: `s${spec.index}`,
    engine: spec.engine,
    scenario: spec.scenario,
    status: "success",
    reason: null,
    durationMs: 10,
    startupMs: 5,
    connectMs: 3,
    actions: 5,
    failedActions: 0,
    peakMemMb: 100,
  };
}

describe("runFleet", () => {
  it("runs every session, never more than --concurrency at once", async () => {
    let active = 0;
    let maxActive = 0;
    const { collector } = fakeCollector();
    const out = await runFleet({
      config,
      options: options({ sessions: 10, concurrency: 3 }),
      fleets,
      logger,
      signal: new AbortController().signal,
      collectors: new Map([["chromium", collector]]),
      runSession: async (_deps, spec) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return result(spec);
      },
    });

    expect(out.results).toHaveLength(10);
    expect(out.skipped).toBe(0);
    expect(maxActive).toBe(3);
    expect(new Set(out.results.map((r) => r.index)).size).toBe(10);
  });

  it("gives each session its scenario (round-robin for mix) and a repeatable seed", async () => {
    const specs: SessionSpec[] = [];
    await runFleet({
      config,
      options: options({ sessions: 6, concurrency: 1, seed: 11 }),
      fleets,
      logger,
      signal: new AbortController().signal,
      collectors: new Map([["chromium", fakeCollector().collector]]),
      runSession: async (_deps, spec) => {
        specs.push(spec);
        return result(spec);
      },
    });

    expect(specs.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(specs.slice(0, 3).map((s) => s.scenario))).toEqual(new Set(SCENARIO_NAMES));
    expect(specs.map((s) => s.seed)).toEqual([0, 1, 2, 3, 4, 5].map((i) => sessionSeed(11, i)));
    expect(new Set(specs.map((s) => s.seed)).size).toBe(6);
    expect(specs.every((s) => s.engine === "chromium")).toBe(true);
  });

  it("a fixed --scenario is used for every session", async () => {
    const seen = new Set<string>();
    await runFleet({
      config,
      options: options({ sessions: 4, scenario: "heavy-page-crawl" }),
      fleets,
      logger,
      signal: new AbortController().signal,
      collectors: new Map([["chromium", fakeCollector().collector]]),
      runSession: async (_deps, spec) => {
        seen.add(spec.scenario);
        return result(spec);
      },
    });
    expect([...seen]).toEqual(["heavy-page-crawl"]);
  });

  it("stops starting sessions after an interrupt, lets running ones finish, and counts the skipped", async () => {
    const abort = new AbortController();
    let started = 0;
    const out = await runFleet({
      config,
      options: options({ sessions: 10, concurrency: 2 }),
      fleets,
      logger,
      signal: abort.signal,
      collectors: new Map([["chromium", fakeCollector().collector]]),
      runSession: async (_deps, spec) => {
        started++;
        if (started === 2) abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return result(spec);
      },
    });

    expect(out.results).toHaveLength(2);
    expect(out.skipped).toBe(8);
    expect(started).toBe(2);
  });

  it("flushes and closes the collector, and adds up its delivery numbers", async () => {
    const { collector, close } = fakeCollector({
      pushed: 100,
      sent: 90,
      duplicates: 4,
      dropped: 6,
      pending: 0,
    });
    const out = await runFleet({
      config,
      options: options({ sessions: 2, concurrency: 1 }),
      fleets,
      logger,
      signal: new AbortController().signal,
      collectors: new Map([["chromium", collector]]),
      runSession: async (_deps, spec) => result(spec),
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(out.delivery).toEqual({ pushed: 100, sent: 90, duplicates: 4, dropped: 6, pending: 0 });
  });

  it("still closes the collector if a session blows up", async () => {
    const { collector, close } = fakeCollector();
    await expect(
      runFleet({
        config,
        options: options({ sessions: 3, concurrency: 1 }),
        fleets,
        logger,
        signal: new AbortController().signal,
        collectors: new Map([["chromium", collector]]),
        runSession: async () => {
          throw new Error("docker exploded");
        },
      }),
    ).rejects.toThrow("docker exploded");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
