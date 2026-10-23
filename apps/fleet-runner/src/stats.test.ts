import pino from "pino";
import { describe, expect, it } from "vitest";
import { cpuPercent, type DockerStats, memoryMb, networkTotals, StatsPoller } from "./stats";

const MB = 1024 * 1024;
const logger = pino({ level: "silent" });

/** Docker's numbers for a container that used 0.5 of 4 CPUs over the last second. */
const busy: DockerStats = {
  cpu_stats: {
    cpu_usage: { total_usage: 2_500_000_000 },
    system_cpu_usage: 40_000_000_000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 2_000_000_000 },
    system_cpu_usage: 36_000_000_000,
  },
  memory_stats: { usage: 300 * MB, stats: { inactive_file: 50 * MB } },
  networks: {
    eth0: { rx_bytes: 1000, tx_bytes: 400 },
    eth1: { rx_bytes: 24, tx_bytes: 6 },
  },
};

describe("cpuPercent", () => {
  it("is cpu_delta / system_delta * online_cpus * 100", () => {
    // 0.5e9 / 4e9 = 0.125 of the machine, times 4 CPUs, times 100 = 50 (half of one core)
    expect(cpuPercent(busy)).toBeCloseTo(50, 6);
  });

  it("can pass 100 when several cores are busy", () => {
    const stats: DockerStats = structuredClone(busy);
    (stats.cpu_stats?.cpu_usage as { total_usage: number }).total_usage = 6_000_000_000;
    expect(cpuPercent(stats)).toBeCloseTo(400, 6);
  });

  it("is 0 when there is no previous reading yet", () => {
    expect(cpuPercent({ ...busy, precpu_stats: {} })).toBe(0);
    expect(
      cpuPercent({ ...busy, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 } }),
    ).toBeGreaterThanOrEqual(0);
  });

  it("is 0, not negative or NaN, when counters did not move", () => {
    const flat: DockerStats = structuredClone(busy);
    flat.precpu_stats = structuredClone(flat.cpu_stats) as DockerStats["precpu_stats"];
    expect(cpuPercent(flat)).toBe(0);
    expect(cpuPercent({})).toBe(0);
  });

  it("falls back to percpu_usage length, then 1 CPU, when online_cpus is missing", () => {
    const stats: DockerStats = structuredClone(busy);
    (stats.cpu_stats as { online_cpus?: number }).online_cpus = undefined;
    expect(cpuPercent(stats)).toBeCloseTo(12.5, 6); // 1 CPU
    (stats.cpu_stats?.cpu_usage as { percpu_usage?: number[] }).percpu_usage = [1, 1];
    expect(cpuPercent(stats)).toBeCloseTo(25, 6); // 2 CPUs
  });
});

describe("memoryMb", () => {
  it("cgroup v2: usage minus inactive_file", () => {
    expect(memoryMb(busy)).toBeCloseTo(250, 6);
  });

  it("cgroup v1: usage minus total_inactive_file, else minus cache", () => {
    expect(
      memoryMb({
        memory_stats: { usage: 200 * MB, stats: { total_inactive_file: 20 * MB, cache: 90 * MB } },
      }),
    ).toBeCloseTo(180, 6);
    expect(memoryMb({ memory_stats: { usage: 200 * MB, stats: { cache: 90 * MB } } })).toBeCloseTo(
      110,
      6,
    );
  });

  it("does not subtract a cache figure bigger than usage", () => {
    expect(
      memoryMb({ memory_stats: { usage: 10 * MB, stats: { inactive_file: 20 * MB } } }),
    ).toBeCloseTo(10, 6);
  });

  it("is plain usage when there is no cache figure, null when there is no usage", () => {
    expect(memoryMb({ memory_stats: { usage: 64 * MB } })).toBeCloseTo(64, 6);
    expect(memoryMb({ memory_stats: {} })).toBeNull();
    expect(memoryMb({})).toBeNull();
  });
});

describe("networkTotals", () => {
  it("sums rx and tx over all interfaces", () => {
    expect(networkTotals(busy)).toEqual({ rx: 1024, tx: 406 });
  });

  it("is null when Docker reports no networks (host networking)", () => {
    expect(networkTotals({})).toBeNull();
  });
});

describe("StatsPoller", () => {
  function reading(rx: number, tx: number, memMb = 100): DockerStats {
    return {
      ...busy,
      memory_stats: { usage: memMb * MB },
      networks: { eth0: { rx_bytes: rx, tx_bytes: tx } },
    };
  }

  it("emits samples with network deltas (first one counts from zero), then peak memory", async () => {
    const readings = [reading(1000, 100, 120), reading(1500, 160, 300), reading(1500, 160, 200)];
    const samples: { rx: number; tx: number; mem: number }[] = [];
    const poller = new StatsPoller({
      readStats: async () => readings.shift() ?? reading(1500, 160, 200),
      onSample: (s) => samples.push({ rx: s.netRxBytes, tx: s.netTxBytes, mem: s.memMb }),
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await poller.stop();

    expect(samples.slice(0, 3)).toEqual([
      { rx: 1000, tx: 100, mem: 120 },
      { rx: 500, tx: 60, mem: 300 },
      { rx: 0, tx: 0, mem: 200 },
    ]);
    expect(poller.peakMemMb).toBe(300);
    expect(poller.sampleCount).toBeGreaterThanOrEqual(3);
  });

  it("every sample has all four container metrics as finite numbers", async () => {
    const samples: Record<string, number>[] = [];
    const poller = new StatsPoller({
      readStats: async () => busy,
      onSample: (s) => samples.push({ ...s }),
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await poller.stop();
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      for (const value of Object.values(sample)) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("a counter that goes backwards (container restarted) counts from zero", async () => {
    const readings = [reading(5000, 500), reading(100, 10)];
    const samples: number[] = [];
    const poller = new StatsPoller({
      readStats: async () => readings.shift() ?? reading(100, 10),
      onSample: (s) => samples.push(s.netRxBytes),
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await poller.stop();
    expect(samples.slice(0, 2)).toEqual([5000, 100]);
  });

  it("keeps going when a reading fails (container gone or Docker busy)", async () => {
    let calls = 0;
    const samples: number[] = [];
    const poller = new StatsPoller({
      readStats: async () => {
        calls++;
        if (calls === 1) throw new Error("(HTTP code 404) no such container");
        return busy;
      },
      onSample: (s) => samples.push(s.memMb),
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await poller.stop();
    expect(samples.length).toBeGreaterThan(0);
  });

  it("skips readings that lack memory or network instead of inventing numbers", async () => {
    const samples: unknown[] = [];
    const poller = new StatsPoller({
      readStats: async () => ({ cpu_stats: busy.cpu_stats, precpu_stats: busy.precpu_stats }),
      onSample: (s) => samples.push(s),
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await poller.stop();
    expect(samples).toHaveLength(0);
    expect(poller.peakMemMb).toBe(0);
  });

  it("emits nothing after stop()", async () => {
    const samples: unknown[] = [];
    const poller = new StatsPoller({
      readStats: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return busy;
      },
      onSample: (s) => samples.push(s),
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poller.stop();
    const count = samples.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(samples.length).toBe(count);
  });

  it("does not wait forever for a stats call that hangs", async () => {
    const poller = new StatsPoller({
      readStats: () => new Promise<DockerStats>(() => undefined),
      onSample: () => undefined,
      logger,
      intervalMs: 10,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await poller.stop();
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
