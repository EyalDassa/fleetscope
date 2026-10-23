import { type CollectedSession, type Collector, createCollector } from "@fleetscope/collector";
import type { Engine } from "@fleetscope/schema";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { DockerFleet } from "./docker";
import { forceShutdown } from "./shutdown";

const logger = pino({ level: "silent" });

/** A real collector over a transport that records what reaches the "API" and can be slow. */
function collectorWith(options: { sendDelayMs?: number } = {}) {
  const received: Array<{
    type: string;
    session_id: string;
    status?: string;
    reason?: string | null;
  }> = [];
  const collector = createCollector({
    apiUrl: "http://127.0.0.1:1",
    source: "real",
    agentId: "test",
    provider: "local-docker",
    engine: "chromium",
    logger,
    heapSampleIntervalMs: 0,
    flushIntervalMs: 60_000, // nothing is sent unless somebody flushes: that is the point
    flushSize: 10_000,
    transport: {
      async send(batch) {
        if (options.sendDelayMs)
          await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
        received.push(...(batch as unknown as typeof received));
        return { status: "accepted", accepted: batch.length, duplicates: 0 };
      },
    },
  });
  return { collector, received };
}

const sessionOptions = {
  scenario: "login-and-search",
  region: "local",
  engineVersion: "chromium 156",
  startupMs: 500,
  connectMs: 100,
};

function fleetThatRemoves(removed = 3, delayMs = 0) {
  const removeAllOwned = vi.fn(async (_scope?: { runId?: string }) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return removed;
  });
  return { fleet: { removeAllOwned } as unknown as DockerFleet, removeAllOwned };
}

function maps(collector: Collector, fleet: DockerFleet) {
  return {
    collectors: new Map<Engine, Collector>([["chromium", collector]]),
    fleets: new Map<Engine, DockerFleet>([["chromium", fleet]]),
  };
}

describe("forceShutdown (second Ctrl+C)", () => {
  it("sends the session.ended of a session that finished but was still queued", async () => {
    const { collector, received } = collectorWith();
    const finished = collector.startSession({ ...sessionOptions, sessionId: "done" });
    await finished.endSession("success"); // like 9ac1cdfe in Eyal's run: finished, still in the queue
    const { fleet } = fleetThatRemoves();

    await forceShutdown({ live: new Set(), runId: "r1", logger, ...maps(collector, fleet) });

    const mine = received.filter((e) => e.session_id === "done").map((e) => e.type);
    expect(mine).toEqual(["session.started", "session.ended"]);
  });

  it("ends the sessions still running as failed/interrupted, so they do not stay 'running' for ever", async () => {
    const { collector, received } = collectorWith();
    const running: CollectedSession[] = [
      collector.startSession({ ...sessionOptions, sessionId: "a" }),
      collector.startSession({ ...sessionOptions, sessionId: "b" }),
    ];
    const { fleet } = fleetThatRemoves();

    await forceShutdown({ live: new Set(running), runId: "r1", logger, ...maps(collector, fleet) });

    const ended = received.filter((e) => e.type === "session.ended");
    expect(ended.map((e) => e.session_id).sort()).toEqual(["a", "b"]);
    for (const e of ended) {
      expect(e.status).toBe("failed");
      expect(e.reason).toBe("interrupted");
    }
    // session.started comes before session.ended for each
    for (const id of ["a", "b"]) {
      const types = received.filter((e) => e.session_id === id).map((e) => e.type);
      expect(types).toEqual(["session.started", "session.ended"]);
    }
  });

  it("a session that is being ended normally at the same time is not ended twice", async () => {
    const { collector, received } = collectorWith();
    const session = collector.startSession({ ...sessionOptions, sessionId: "x" });
    const normal = session.endSession("failed", "interrupted"); // runSession's own ending
    const { fleet } = fleetThatRemoves();

    await forceShutdown({
      live: new Set([session]),
      runId: "r1",
      logger,
      ...maps(collector, fleet),
    });
    await normal;

    expect(received.filter((e) => e.type === "session.ended")).toHaveLength(1);
  });

  it("removes only this run's containers", async () => {
    const { collector } = collectorWith();
    const { fleet, removeAllOwned } = fleetThatRemoves(2);
    await forceShutdown({ live: new Set(), runId: "abc123", logger, ...maps(collector, fleet) });
    expect(removeAllOwned).toHaveBeenCalledTimes(1);
    expect(removeAllOwned).toHaveBeenCalledWith({ runId: "abc123" });
  });

  it("is bounded: a hanging API and a hanging Docker cannot hold up the exit", async () => {
    const { collector } = collectorWith({ sendDelayMs: 60_000 });
    collector.startSession({ ...sessionOptions, sessionId: "slow" });
    const { fleet } = fleetThatRemoves(1, 60_000);

    const t0 = Date.now();
    await forceShutdown({
      live: new Set(),
      runId: "r1",
      logger,
      flushMs: 300,
      cleanupMs: 300,
      ...maps(collector, fleet),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("sweeps again while a container is still being created, until a sweep ran with nothing starting", async () => {
    const { collector } = collectorWith();
    let starting = 2;
    let sweeps = 0;
    const fleet = {
      get starting() {
        return starting;
      },
      removeAllOwned: vi.fn(async () => {
        sweeps++;
        if (sweeps === 2) starting = 1; // one container finished starting and showed up
        if (sweeps === 3) starting = 0;
        return sweeps === 2 ? 1 : 0;
      }),
    } as unknown as DockerFleet;

    await forceShutdown({ live: new Set(), runId: "r1", logger, ...maps(collector, fleet) });

    expect(sweeps).toBeGreaterThanOrEqual(4); // the sweep that finds nothing is the one that ends it
    expect(starting).toBe(0);
  });

  it("stops sweeping at the deadline even if containers keep appearing", async () => {
    const { collector } = collectorWith();
    const fleet = {
      starting: 1,
      removeAllOwned: vi.fn(async () => 1),
    } as unknown as DockerFleet;
    const t0 = Date.now();
    await forceShutdown({
      live: new Set(),
      runId: "r1",
      logger,
      cleanupMs: 400,
      ...maps(collector, fleet),
    });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("copes with nothing to do", async () => {
    const { collector } = collectorWith();
    const { fleet } = fleetThatRemoves(0);
    await expect(
      forceShutdown({ live: new Set(), runId: "r1", logger, ...maps(collector, fleet) }),
    ).resolves.toBeUndefined();
  });

  it("a failing container removal does not stop it", async () => {
    const { collector } = collectorWith();
    const fleet = {
      removeAllOwned: vi.fn(async () => {
        throw new Error("docker is down");
      }),
    } as unknown as DockerFleet;
    await expect(
      forceShutdown({ live: new Set(), runId: "r1", logger, ...maps(collector, fleet) }),
    ).resolves.toBeUndefined();
  });
});
