import { describe, expect, it } from "vitest";
import { cpuPercent, type DockerStats, memoryMb, networkTotals } from "./stats";

const MB = 1024 * 1024;

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
