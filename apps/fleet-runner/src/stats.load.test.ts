import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DockerStats, StatsPoller } from "./stats";

/**
 * QA, M1: Docker's stats call under load. Measured on this machine (Docker Desktop 29, Windows,
 * the real browser image): one `container.stats({ stream: false })` takes 2.0 s with 4 idle
 * containers, and with 12 sessions running it took p50 3.4 s, p90 6.6 s, max 9.9 s. A real run
 * with --concurrency 12 (24 short sessions) left 11 of 24 sessions without any container sample.
 * StatsPoller.stop() waits at most 2.5 s for the reading in progress, then gives up.
 */

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

afterEach(() => {
  vi.useRealTimers();
});

/** A poller with Docker's real latency and the DEFAULT stop timeout, driven by a fake clock. */
async function sessionOfMs(sessionMs: number, dockerLatencyMs: number) {
  vi.useFakeTimers();
  const samples: unknown[] = [];
  const poller = new StatsPoller({
    readStats: () => new Promise((resolve) => setTimeout(() => resolve(stats), dockerLatencyMs)),
    onSample: (sample) => samples.push(sample),
    logger,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(sessionMs); // the scenario runs
  const stopping = poller.stop(); // session over: the runner awaits this before session.ended
  await vi.advanceTimersByTimeAsync(20_000);
  await stopping;
  return { samples, poller };
}

describe("StatsPoller with Docker's real latency (default settings)", () => {
  it("a 1 s session on an idle machine (reading takes 2.0 s) gets its sample", async () => {
    const { samples } = await sessionOfMs(1000, 2000);
    expect(samples).toHaveLength(1);
  });

  it("a 2 s session where Docker answers in 2.4 s gets its sample", async () => {
    const { samples } = await sessionOfMs(2000, 2400);
    expect(samples.length).toBeGreaterThanOrEqual(1);
  });

  it("a 1 s session where Docker answers in 3.4 s (the median with 12 sessions) just makes it: stop() waits 2.5 s after the session ends", async () => {
    const { samples } = await sessionOfMs(1000, 3400);
    expect(samples).toHaveLength(1);
  });

  // QA-M1-05: the session ends at 1 s, the reading in progress would arrive at 4.5 s (between the
  // median and the p90 with 12 sessions running). stop() gives up at 3.5 s, so the session has no
  // container sample.
  it.fails("QA-M1-05: a 1 s session still gets a container sample when Docker needs 4.5 s per reading", async () => {
    const { samples } = await sessionOfMs(1000, 4500);
    expect(samples).toHaveLength(1);
  });

  it.fails("QA-M1-05: nor when Docker needs 6.6 s (the p90 with 12 sessions running)", async () => {
    const { samples } = await sessionOfMs(1500, 6600);
    expect(samples.length).toBeGreaterThanOrEqual(1);
  });
});
