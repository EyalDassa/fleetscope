import type { ContainerSample } from "@fleetscope/collector";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStatsStream, frame } from "./fake-stream";
import { StatsSampler } from "./stats";

/**
 * QA, M1: QA-M1-05, container samples when Docker is slow. VERIFIED in the re-test.
 *
 * Measured on the QA machine (Docker Desktop 29, Windows, the real browser image) with the old
 * pull API: one `container.stats({ stream: false })` took 2.0 s with 4 idle containers, and with 12
 * sessions running p50 3.4 s, p90 6.6 s, max 9.9 s. `StatsPoller.stop()` waited 2.5 s for the
 * reading in progress and then dropped it, so a run with --concurrency 12 left 11 of 24 sessions
 * without any container sample. BE-fleet moved to Docker's stats STREAM (`StatsSampler`): the
 * newest frame becomes the last sample, and stop() waits (up to 10 s) only when no frame has
 * arrived at all. These tests replay those latencies against the new sampler, with the DEFAULT
 * settings and a fake clock. The real-Docker check (24 sessions at concurrency 12) is in
 * `real-run.e2e.test.ts`.
 */

const warnings: string[] = [];
const logger = {
  warn: (...args: unknown[]) => warnings.push(String(args.at(-1))),
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

afterEach(() => {
  vi.useRealTimers();
  warnings.length = 0;
});

/**
 * One session of `sessionMs`; Docker delivers its first stats frame `firstFrameMs` after the
 * sampler started, then one per second. Returns the samples and how long stop() took.
 */
async function session(sessionMs: number, firstFrameMs: number) {
  vi.useFakeTimers();
  const fake = fakeStatsStream();
  const samples: ContainerSample[] = [];
  const sampler = new StatsSampler({
    openStream: async () => fake.stream,
    onSample: (sample) => samples.push(sample),
    logger,
  });
  sampler.start();

  let cpuNs = 0;
  const deliver = (n: number) => {
    cpuNs += 300_000_000;
    fake.push(
      frame({
        cpuNs,
        previousCpuNs: cpuNs - 300_000_000,
        systemNs: n * 1e9,
        previousSystemNs: (n - 1) * 1e9 + 1,
        memMb: 200,
      }),
    );
  };
  for (let n = 1; n <= 30; n++) setTimeout(() => deliver(n), firstFrameMs + (n - 1) * 1000);

  await vi.advanceTimersByTimeAsync(sessionMs); // the scenario runs
  const stopping = sampler.stop(); // what the runner awaits before session.ended
  await vi.advanceTimersByTimeAsync(30_000);
  await stopping;
  return { samples, sampler, fake };
}

describe("a session always gets its container sample, whatever Docker's latency (default settings)", () => {
  it.each([
    ["idle machine, first frame at 2.0 s", 1000, 2000],
    ["a reading that used to just make it", 1000, 3400],
    ["QA-M1-05: the old pull API lost the sample at 4.5 s", 1000, 4500],
    ["QA-M1-05: nor at 6.6 s (the p90 with 12 sessions running)", 1500, 6600],
    ["the worst reading measured, 9.9 s", 1000, 9900],
  ])("%s", async (_name, sessionMs, firstFrameMs) => {
    const { samples, fake } = await session(sessionMs, firstFrameMs);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[0]?.memMb).toBe(200);
    expect(samples[0]?.cpuPct).toBeGreaterThan(0);
    expect(fake.closedByConsumer).toBe(true); // the stream is closed again
    expect(warnings).toEqual([]);
  });

  it("a longer session keeps sampling about every 2 s from the frames that arrive every second", async () => {
    const { samples } = await session(9000, 1000);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(samples.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < samples.length; i++) {
      const gap = (samples[i]?.readAt ?? 0) - (samples[i - 1]?.readAt ?? 0);
      expect(gap).toBeGreaterThanOrEqual(900); // the last one may come early (it is the final sample)
      expect(gap).toBeLessThanOrEqual(2100);
    }
  });

  // The remaining limit: if Docker does not deliver ANY frame within 10 s, the session ends without
  // a sample. It must not hang the session, and it must be visible in the log (it used to be silent).
  it("gives up after 10 s without a first frame, bounded, and says so in the log", async () => {
    vi.useFakeTimers();
    const fake = fakeStatsStream();
    const samples: ContainerSample[] = [];
    const sampler = new StatsSampler({
      openStream: async () => fake.stream,
      onSample: (sample) => samples.push(sample),
      logger,
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(500);
    const t0 = Date.now();
    const stopping = sampler.stop();
    await vi.advanceTimersByTimeAsync(11_000);
    await stopping;
    expect(Date.now() - t0).toBeLessThanOrEqual(11_000);
    expect(samples).toHaveLength(0);
    expect(warnings.join("\n")).toContain("without a container sample");
  });
});
