import { createCollector } from "@fleetscope/collector";
import type { FleetEvent } from "@fleetscope/schema";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStatsStream, frame } from "./fake-stream";
import { finishSession } from "./session-runner";
import { StatsPoller, StatsSampler, type StatsStream } from "./stats";

const logger = pino({ level: "silent" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Lets promise callbacks (the frame loop) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

/** A sampler on a fake stream and a fake clock that the test moves by hand. */
function setup(options: { intervalMs?: number; firstFrameTimeoutMs?: number } = {}) {
  const fake = fakeStatsStream();
  const samples: Array<{ cpuPct: number; memMb: number; rx: number; tx: number; readAt?: number }> =
    [];
  let clock = 1_000_000;
  const openStream = vi.fn(async () => fake.stream);
  const sampler = new StatsSampler({
    openStream,
    onSample: (s) =>
      samples.push({
        cpuPct: s.cpuPct,
        memMb: s.memMb,
        rx: s.netRxBytes,
        tx: s.netTxBytes,
        readAt: s.readAt,
      }),
    logger,
    now: () => clock,
    ...options,
  });
  /** A frame arriving `atMs` after the start of the test. */
  async function arrive(atMs: number, memMb: number, rx = 0, tx = 0) {
    clock = 1_000_000 + atMs;
    fake.push(
      frame({
        cpuNs: atMs * 1e6,
        previousCpuNs: Math.max(0, atMs - 1000) * 1e6,
        systemNs: 10e9 + atMs * 4e6,
        previousSystemNs: 10e9 + Math.max(0, atMs - 1000) * 4e6,
        memMb,
        rx,
        tx,
      }),
    );
    await settle();
  }
  return { fake, samples, sampler, openStream, arrive, setClock: (ms: number) => (clock = ms) };
}

describe("StatsSampler", () => {
  it("samples the first frame at once, then one frame every 2 s", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await settle();
    for (const [t, mem] of [
      [0, 100],
      [1000, 110],
      [2000, 120],
      [3000, 130],
      [4000, 140],
    ] as const) {
      await arrive(t, mem);
    }
    expect(samples.map((s) => s.memMb)).toEqual([100, 120, 140]);
    await sampler.stop();
  });

  it("a frame that comes a little early still keeps the 2 s rhythm, not 3 s", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(900, 101); // too soon after the first
    await arrive(1700, 102); // 1.7 s: close enough to "every 2 s"
    await arrive(2600, 103);
    expect(samples.map((s) => s.memMb)).toEqual([100, 102]);
    await sampler.stop();
  });

  it("stamps each sample with the time its frame arrived", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(2000, 100);
    expect(samples.map((s) => s.readAt)).toEqual([1_000_000, 1_002_000]);
    await sampler.stop();
  });

  it("reports network bytes as the change since the previous sample (the first counts from zero)", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100, 5000, 700);
    await arrive(1000, 100, 5200, 710); // not sampled, but the counters keep growing
    await arrive(2000, 100, 8000, 900);
    expect(samples.map((s) => [s.rx, s.tx])).toEqual([
      [5000, 700],
      [3000, 200],
    ]);
    await sampler.stop();
  });

  it("the CPU of a later sample is Docker's number for that frame", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(2000, 100); // 1 s of CPU in the last 1 s on 4 cpus, system moved 4 s: 100 % of a core
    expect(samples[1]?.cpuPct).toBeCloseTo(100, 3);
    await sampler.stop();
  });

  it("peak memory is the highest sample", async () => {
    const { sampler, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(2000, 300);
    await arrive(4000, 200);
    expect(sampler.peakMemMb).toBe(300);
    expect(sampler.sampleCount).toBe(3);
    await sampler.stop();
  });

  it("opens one stream only, whatever the session does", async () => {
    const { sampler, openStream, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(2000, 100);
    await sampler.stop();
    expect(openStream).toHaveBeenCalledTimes(1);
  });
});

describe("the last sample (stop)", () => {
  it("is the newest frame when it has not been sampled yet", async () => {
    const { sampler, samples, arrive, fake } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(1000, 150); // newer than the last sample, not yet sampled
    await sampler.stop();
    expect(samples.map((s) => s.memMb)).toEqual([100, 150]);
    expect(fake.closedByConsumer).toBe(true);
  });

  it("is not a duplicate when the newest frame was just sampled", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(2000, 120);
    await sampler.stop();
    expect(samples.map((s) => s.memMb)).toEqual([100, 120]);
  });

  it("takes no slow call at the end: a session that ends 1 ms after the first frame has that frame, instantly", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    const t0 = Date.now();
    await sampler.stop();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(samples).toHaveLength(1);
  });

  it("waits for the first frame when none has arrived yet, and then samples it", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    const stopping = sampler.stop(); // the session is over before Docker said anything
    await sleep(20);
    expect(samples).toHaveLength(0);
    await arrive(0, 100);
    await stopping;
    expect(samples).toHaveLength(1);
  });

  it("gives up on a first frame that never comes, resolving anyway (and says so)", async () => {
    const { sampler, samples } = setup({ firstFrameTimeoutMs: 40 });
    sampler.start();
    await sampler.stop();
    expect(samples).toHaveLength(0);
  });

  it("the load case of QA-M1-05: Docker needs 6.6 s for its first answer, the session ended after 1 s, and it still gets its sample", async () => {
    vi.useFakeTimers();
    const fake = fakeStatsStream();
    const samples: unknown[] = [];
    const sampler = new StatsSampler({
      openStream: () =>
        new Promise<StatsStream>((resolve) => setTimeout(() => resolve(fake.stream), 6600)),
      onSample: (s) => samples.push(s),
      logger,
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(1000); // the scenario runs for 1 s
    const stopping = sampler.stop();
    await vi.advanceTimersByTimeAsync(6600);
    fake.push(frame({ cpuNs: 1, systemNs: 1, memMb: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(samples).toHaveLength(1);
  });

  it("the stream ending on its own keeps the samples so far, and stop still works", async () => {
    const { sampler, samples, arrive, fake } = setup();
    sampler.start();
    await arrive(0, 100);
    fake.fail(new Error("socket hang up"));
    await settle();
    await expect(sampler.stop()).resolves.toBeUndefined();
    expect(samples).toHaveLength(1);
  });

  it("stop() twice is one stop; stop() before start() just closes", async () => {
    const { sampler, openStream } = setup();
    const never = new StatsSampler({ openStream, onSample: () => undefined, logger });
    await never.stop();
    never.start();
    await settle();
    expect(openStream).not.toHaveBeenCalled();

    sampler.start();
    const first = sampler.stop({ finalSample: false });
    expect(sampler.stop()).toBe(first);
    await first;
  });

  it("finalSample: false cancels without waiting or sampling", async () => {
    const { sampler, samples, arrive } = setup();
    sampler.start();
    await arrive(0, 100);
    await arrive(1000, 150);
    await sampler.stop({ finalSample: false });
    expect(samples.map((s) => s.memMb)).toEqual([100]);
  });
});

describe("after stop", () => {
  it("nothing more is emitted, the stream is closed, and no timer is left", async () => {
    vi.useFakeTimers();
    const fake = fakeStatsStream();
    const samples: unknown[] = [];
    const sampler = new StatsSampler({
      openStream: async () => fake.stream,
      onSample: (s) => samples.push(s),
      logger,
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    fake.push(frame({ cpuNs: 1, systemNs: 1, memMb: 100 }));
    await vi.advanceTimersByTimeAsync(0);
    await sampler.stop();

    expect(vi.getTimerCount()).toBe(0);
    fake.push(frame({ cpuNs: 2, systemNs: 2, memMb: 999 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(samples).toHaveLength(1);
    expect(fake.closedByConsumer).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopping while waiting for the first frame leaves no timer either", async () => {
    vi.useFakeTimers();
    const fake = fakeStatsStream();
    const sampler = new StatsSampler({
      openStream: async () => fake.stream,
      onSample: () => undefined,
      logger,
    });
    sampler.start();
    const stopping = sampler.stop();
    await vi.advanceTimersByTimeAsync(10_000); // the first-frame wait runs out
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stream that opens after stop is closed straight away", async () => {
    vi.useFakeTimers();
    const fake = fakeStatsStream();
    const sampler = new StatsSampler({
      openStream: () =>
        new Promise<StatsStream>((resolve) => setTimeout(() => resolve(fake.stream), 500)),
      onSample: () => undefined,
      logger,
      firstFrameTimeoutMs: 100,
    });
    sampler.start();
    const stopping = sampler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(fake.closedByConsumer).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("incomplete frames", () => {
  it("a frame without memory or network figures is skipped, not turned into zeros", async () => {
    const { sampler, samples, fake } = setup();
    sampler.start();
    fake.push({ cpu_stats: { cpu_usage: { total_usage: 1 } } });
    await settle();
    expect(samples).toHaveLength(0);
    await sampler.stop({ finalSample: false });
  });
});

describe("a session of half a second (the bug that started this)", () => {
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
      scenario: "checkout-form",
      region: "local",
      engineVersion: "chromium 156",
      startupMs: 600,
      connectMs: 100,
    });
    return { collector, session, events };
  }

  it("gets a container sample stamped inside the session, and session.ended stays the last event", async () => {
    const { collector, session, events } = recordingCollector();
    const fake = fakeStatsStream();
    const sampler = new StatsSampler({
      openStream: async () => fake.stream,
      onSample: (s) => session.recordContainerSample(s),
      logger,
    });
    sampler.start();
    await sleep(30);
    fake.push(frame({ cpuNs: 1e8, systemNs: 1e10, memMb: 210, rx: 4000, tx: 900 }));
    await sleep(20);
    await finishSession(session, sampler, { status: "success", reason: null });
    await collector.close();

    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "resource.sample",
      "session.ended",
    ]);
    const [started, sample, ended] = events;
    expect(sample?.ts).toBeGreaterThanOrEqual(started?.ts ?? 0);
    expect(sample?.ts).toBeLessThanOrEqual(ended?.ts ?? 0);
  });

  it("the very last frame is sampled before session.ended, not after, even if it is only just in", async () => {
    const { collector, session, events } = recordingCollector();
    const fake = fakeStatsStream();
    const sampler = new StatsSampler({
      openStream: async () => fake.stream,
      onSample: (s) => session.recordContainerSample(s),
      logger,
    });
    sampler.start();
    fake.push(frame({ cpuNs: 1e8, systemNs: 1e10, memMb: 100 }));
    await sleep(20);
    fake.push(frame({ cpuNs: 2e8, systemNs: 2e10, memMb: 180 })); // not sampled by the 2 s rule
    await sleep(20);
    await finishSession(session, sampler, { status: "failed", reason: "x" });
    await collector.close();

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "session.started",
      "resource.sample",
      "resource.sample",
      "session.ended",
    ]);
    const mems = events
      .filter((e) => e.type === "resource.sample")
      .map((e) => (e as { mem_mb: number }).mem_mb);
    expect(mems).toEqual([100, 180]);
  });

  it("a frame that arrives after session.ended is not recorded", async () => {
    const { collector, session, events } = recordingCollector();
    const fake = fakeStatsStream();
    const sampler = new StatsSampler({
      openStream: async () => fake.stream,
      onSample: (s) => session.recordContainerSample(s),
      logger,
    });
    sampler.start();
    fake.push(frame({ cpuNs: 1e8, systemNs: 1e10, memMb: 100 }));
    await sleep(20);
    await finishSession(session, sampler, { status: "success", reason: null });
    fake.push(frame({ cpuNs: 9e8, systemNs: 9e10, memMb: 999 }));
    await sleep(20);
    await collector.close();
    expect(events.at(-1)?.type).toBe("session.ended");
    expect(events.filter((e) => e.type === "resource.sample")).toHaveLength(1);
  });
});

describe("StatsPoller (the one-reading-at-a-time adapter kept for the older load tests)", () => {
  it("turns repeated readings into frames", async () => {
    let reads = 0;
    const samples: number[] = [];
    const poller = new StatsPoller({
      readStats: async () => {
        reads++;
        await sleep(5);
        return frame({ cpuNs: reads * 1e6, systemNs: reads * 1e7, memMb: 100 + reads });
      },
      onSample: (s) => samples.push(s.memMb),
      logger,
      intervalMs: 20,
    });
    poller.start();
    await sleep(80);
    await poller.stop();
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]).toBe(101);
  });
});
