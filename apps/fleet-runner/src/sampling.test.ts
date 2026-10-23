import { createCollector } from "@fleetscope/collector";
import type { FleetEvent } from "@fleetscope/schema";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finishSession } from "./session-runner";
import { type DockerStats, StatsPoller } from "./stats";

const logger = pino({ level: "silent" });
const MB = 1024 * 1024;

const stats: DockerStats = {
  cpu_stats: {
    cpu_usage: { total_usage: 2_500_000_000 },
    system_cpu_usage: 40_000_000_000,
    online_cpus: 4,
  },
  precpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 36_000_000_000 },
  memory_stats: { usage: 200 * MB },
  networks: { eth0: { rx_bytes: 1000, tx_bytes: 100 } },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stats source that, like Docker, takes `delayMs` to answer (Docker averages over a second). */
function slowStats(delayMs: number) {
  const readStats = vi.fn(async () => {
    await sleep(delayMs);
    return stats;
  });
  return readStats;
}

/** A real collector whose events we can read back. */
function recordingCollector() {
  const events: FleetEvent[] = [];
  const collector = createCollector({
    apiUrl: "http://127.0.0.1:1",
    source: "real",
    agentId: "test",
    provider: "local-docker",
    engine: "chromium",
    logger,
    heapSampleIntervalMs: 0,
    flushIntervalMs: 20,
    transport: {
      async send(batch) {
        events.push(...batch);
        return { status: "accepted", accepted: batch.length, duplicates: 0 };
      },
    },
  });
  const session = collector.startSession({
    scenario: "login-and-search",
    region: "local",
    engineVersion: "chromium 155",
    startupMs: 600,
    connectMs: 100,
  });
  return { collector, session, events };
}

const containerSamples = (events: FleetEvent[]) =>
  events.filter((e) => e.type === "resource.sample" && e.origin === "container");

afterEach(() => {
  vi.useRealTimers();
});

describe("every session gets a container sample", () => {
  it("a session shorter than one Docker reading still gets one, and session.ended stays last", async () => {
    const { collector, session, events } = recordingCollector();
    const poller = new StatsPoller({
      readStats: slowStats(300), // a "1 s" reading, scaled down
      onSample: (s) => session.recordContainerSample(s),
      logger,
    });

    poller.start();
    await sleep(100); // the whole scenario takes less than one reading
    await finishSession(session, poller, { status: "success", reason: null });
    await collector.close();

    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "resource.sample",
      "session.ended",
    ]);
    expect(containerSamples(events)).toHaveLength(1);
    expect(poller.sampleCount).toBe(1);
  });

  it("a reading taken before the session exists is held and arrives right after session.started", async () => {
    const poller = new StatsPoller({ readStats: slowStats(20), logger });
    poller.start(); // container is serving; Chromium is still launching
    await sleep(80); // the reading finished while nobody was listening
    expect(poller.sampleCount).toBe(1);

    const { collector, session, events } = recordingCollector();
    poller.attach((s) => session.recordContainerSample(s));
    await finishSession(session, poller, { status: "success", reason: null });
    await collector.close();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session.started");
    expect(types).toContain("resource.sample");
    expect(types.at(-1)).toBe("session.ended");
    expect(types.indexOf("resource.sample")).toBeLessThan(types.indexOf("session.ended"));
  });

  it("a reading that outlives the stop timeout is dropped, never after session.ended", async () => {
    const { collector, session, events } = recordingCollector();
    const poller = new StatsPoller({
      readStats: slowStats(200),
      onSample: (s) => session.recordContainerSample(s),
      logger,
      stopTimeoutMs: 30,
    });
    poller.start();
    await sleep(10);
    await finishSession(session, poller, { status: "failed", reason: "x" });
    await sleep(300); // the late reading comes back now
    await collector.close();

    expect(containerSamples(events)).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("session.ended");
    expect(poller.sampleCount).toBe(0);
  });

  it("a long session keeps its cadence and ends with a last reading", async () => {
    const samples: number[] = [];
    const readStats = slowStats(5);
    const poller = new StatsPoller({
      readStats,
      onSample: () => samples.push(Date.now()),
      logger,
      intervalMs: 40,
    });
    poller.start();
    await sleep(130);
    const before = samples.length;
    expect(before).toBeGreaterThanOrEqual(3); // t = 0, 40, 80, 120
    await poller.stop();
    expect(samples.length).toBeGreaterThanOrEqual(before); // plus a final one unless one was in flight
    expect(readStats.mock.calls.length).toBe(samples.length);
  });
});

describe("stopping while a reading is in flight", () => {
  it("waits for that reading and does not start a second, overlapping one", async () => {
    let finish: (() => void) | undefined;
    const readStats = vi.fn(
      () =>
        new Promise<DockerStats>((resolve) => {
          finish = () => resolve(stats);
        }),
    );
    const samples: unknown[] = [];
    const poller = new StatsPoller({ readStats, onSample: (s) => samples.push(s), logger });
    poller.start();
    await sleep(10);
    expect(readStats).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    expect(stopped).toBe(false); // still waiting for the reading
    finish?.();
    await stopping;

    expect(readStats).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(1);
  });

  it("between readings it takes a fresh last one", async () => {
    const samples: unknown[] = [];
    const readStats = slowStats(1);
    const poller = new StatsPoller({
      readStats,
      onSample: (s) => samples.push(s),
      logger,
      intervalMs: 60_000,
    });
    poller.start();
    await sleep(30); // first reading done, next one a minute away
    expect(samples).toHaveLength(1);
    await poller.stop();
    expect(samples).toHaveLength(2);
    expect(readStats).toHaveBeenCalledTimes(2);
  });

  it("stop right after start still takes a reading", async () => {
    const samples: unknown[] = [];
    const poller = new StatsPoller({
      readStats: slowStats(1),
      onSample: (s) => samples.push(s),
      logger,
    });
    poller.start();
    await poller.stop();
    expect(samples).toHaveLength(1);
  });

  it("finalSample: false just cancels, without waiting for a hanging reading", async () => {
    const poller = new StatsPoller({
      readStats: () => new Promise<DockerStats>(() => undefined),
      onSample: () => undefined,
      logger,
    });
    poller.start();
    await sleep(10);
    const started = Date.now();
    await poller.stop({ finalSample: false });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("stop() twice is the same stop, and stop() before start() reads nothing", async () => {
    const readStats = slowStats(1);
    const never = new StatsPoller({ readStats, onSample: () => undefined, logger });
    await never.stop();
    never.start(); // too late: it is closed
    await sleep(20);
    expect(readStats).not.toHaveBeenCalled();

    const poller = new StatsPoller({ readStats, onSample: () => undefined, logger });
    poller.start();
    await sleep(10);
    const first = poller.stop();
    const second = poller.stop();
    expect(second).toBe(first);
    await first;
  });

  it("a stats source that always fails gives no sample and no crash", async () => {
    const samples: unknown[] = [];
    const poller = new StatsPoller({
      readStats: async () => {
        throw new Error("(HTTP code 404) no such container");
      },
      onSample: (s) => samples.push(s),
      logger,
    });
    poller.start();
    await sleep(10);
    await expect(poller.stop()).resolves.toBeUndefined();
    expect(samples).toHaveLength(0);
  });
});

describe("no timers are left behind", () => {
  it("stop() mid-call: after the reading finishes, nothing is scheduled", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const poller = new StatsPoller({
      readStats: () =>
        new Promise<DockerStats>((resolve) => {
          finish = () => resolve(stats);
        }),
      onSample: () => undefined,
      logger,
      intervalMs: 2000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // the first reading starts and hangs
    const stopping = poller.stop();
    finish?.();
    await stopping;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() that gives up on a hanging reading leaves no timer either", async () => {
    vi.useFakeTimers();
    const readStats = vi.fn(() => new Promise<DockerStats>(() => undefined));
    const poller = new StatsPoller({
      readStats,
      onSample: () => undefined,
      logger,
      stopTimeoutMs: 2500,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(2500);
    await stopping;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readStats).toHaveBeenCalledTimes(1);
  });

  it("stop() before the first reading starts clears the pending timer", async () => {
    vi.useFakeTimers();
    const poller = new StatsPoller({
      readStats: async () => stats,
      onSample: () => undefined,
      logger,
    });
    poller.start();
    expect(vi.getTimerCount()).toBe(1);
    const stopping = poller.stop({ finalSample: false });
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });
});
