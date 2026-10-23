import type { ContainerSample } from "@fleetscope/collector";
import type { Logger } from "pino";

/**
 * The parts of the Docker Engine stats response we read
 * (https://docs.docker.com/reference/api/engine/version/v1.47/#tag/Container/operation/ContainerStats).
 * Everything is optional because the shape differs between cgroup v1, cgroup v2 and platforms.
 */
export interface DockerStats {
  read?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    stats?: Record<string, number>;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

const MB = 1024 * 1024;

/**
 * CPU use in percent of one core (so 200 means two cores busy), the way `docker stats` shows it:
 * `cpu_delta / system_delta * online_cpus * 100`. The deltas are between this reading and
 * `precpu_stats`, the reading Docker took one second earlier, so this is the average over the last
 * second. Returns 0 when there is no usable previous reading (the first moments of a container).
 */
export function cpuPercent(stats: DockerStats): number {
  const total = stats.cpu_stats?.cpu_usage?.total_usage;
  const previousTotal = stats.precpu_stats?.cpu_usage?.total_usage;
  const system = stats.cpu_stats?.system_cpu_usage;
  const previousSystem = stats.precpu_stats?.system_cpu_usage;
  if (
    total === undefined ||
    previousTotal === undefined ||
    system === undefined ||
    previousSystem === undefined
  ) {
    return 0;
  }
  const cpuDelta = total - previousTotal;
  const systemDelta = system - previousSystem;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  const cpus =
    stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  return (cpuDelta / systemDelta) * cpus * 100;
}

/**
 * Memory in MB without the page cache, which is what `docker stats` shows: usage minus
 * `inactive_file` (cgroup v2), minus `total_inactive_file` or else `cache` (cgroup v1). Returns
 * `null` if Docker gave no usage figure.
 */
export function memoryMb(stats: DockerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (usage === undefined) return null;
  const detail = stats.memory_stats?.stats ?? {};
  const cache = detail.inactive_file ?? detail.total_inactive_file ?? detail.cache ?? 0;
  return Math.max(0, usage - (cache < usage ? cache : 0)) / MB;
}

/** Bytes received and sent since the container started, summed over its network interfaces. */
export function networkTotals(stats: DockerStats): { rx: number; tx: number } | null {
  if (!stats.networks) return null;
  let rx = 0;
  let tx = 0;
  for (const nic of Object.values(stats.networks)) {
    rx += nic.rx_bytes ?? 0;
    tx += nic.tx_bytes ?? 0;
  }
  return { rx, tx };
}

export interface StatsPollerOptions {
  /** Reads one stats response for the container (`container.stats({ stream: false })`). */
  readStats: () => Promise<DockerStats>;
  /** Where samples go. Can be given later with `attach()`; samples taken before that are held. */
  onSample?: (sample: ContainerSample) => void;
  logger: Logger;
  /** Time between readings. Default 2000. */
  intervalMs?: number;
  /** Longest `stop()` waits for a reading. Default 2500. */
  stopTimeoutMs?: number;
}

export interface StopOptions {
  /**
   * Make sure the session gets a last reading (default true): wait for the one in progress, or take
   * a fresh one if none is. Pass false to just cancel, e.g. when the browser never came up.
   */
  finalSample?: boolean;
}

/**
 * Reads a container's stats every `intervalMs` and reports CPU %, memory, and network bytes since
 * the previous reading. The container is new for every session, so its network counters start at
 * zero and the first sample covers everything since startup.
 *
 * Every session gets at least one sample, however short:
 *  - polling can start as soon as the container is serving, before the session exists; samples wait
 *    until `attach()` gives them somewhere to go;
 *  - `stop()` is awaited before the session ends, and finishes with a last reading. If a reading is
 *    already in progress it waits for that one instead of starting a second, overlapping one.
 * After `stop()` returns nothing is ever emitted, and no timer is left running.
 */
export class StatsPoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private state: "idle" | "running" | "stopping" | "closed" = "idle";
  private stopping: Promise<void> | null = null;
  private sink: ((sample: ContainerSample) => void) | null;
  private held: ContainerSample[] = [];
  private previousNet = { rx: 0, tx: 0 };
  private warnedNoNetwork = false;
  private peakMem = 0;
  private count = 0;

  constructor(private readonly options: StatsPollerOptions) {
    this.sink = options.onSample ?? null;
  }

  /** Highest memory reading so far, in MB (0 before the first sample). */
  get peakMemMb(): number {
    return this.peakMem;
  }

  /** Samples taken so far (including ones still held for `attach()`). */
  get sampleCount(): number {
    return this.count;
  }

  /** Sends samples to `sink`, starting with any taken while nobody was listening. */
  attach(sink: (sample: ContainerSample) => void): void {
    this.sink = sink;
    for (const sample of this.held.splice(0)) sink(sample);
  }

  /** Takes the first reading right away and then one every interval. */
  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.schedule(0);
  }

  /** Stops polling; see the class comment for what is guaranteed. Safe to call twice. */
  stop(options: StopOptions = {}): Promise<void> {
    this.stopping ??= this.shutDown(options.finalSample ?? true);
    return this.stopping;
  }

  private async shutDown(finalSample: boolean): Promise<void> {
    const wasRunning = this.state === "running";
    this.state = "stopping";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (finalSample && wasRunning) {
      // The reading in progress counts as the last one; only if there is none do we take another.
      const reading = this.inFlight ?? this.poll();
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([
        reading,
        new Promise<void>((resolve) => {
          giveUp = setTimeout(resolve, this.options.stopTimeoutMs ?? 2500);
        }),
      ]);
      clearTimeout(giveUp);
    }
    // A reading that is still running now (we gave up on it) will find the door closed.
    this.state = "closed";
  }

  private schedule(delayMs: number): void {
    if (this.state !== "running") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state !== "running") return;
      const startedAt = Date.now();
      this.inFlight = this.poll().finally(() => {
        this.inFlight = null;
        // Every interval from the start of the last reading, not from its end: a reading takes
        // about a second (Docker averages over one second), and we do not want to drift.
        this.schedule(Math.max(0, (this.options.intervalMs ?? 2000) - (Date.now() - startedAt)));
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    let stats: DockerStats;
    try {
      stats = await this.options.readStats();
    } catch (error) {
      // The container is gone (session ended, browser killed) or Docker is busy. Not fatal.
      if (this.state !== "closed") {
        this.options.logger.debug({ err: error }, "container stats unavailable");
      }
      return;
    }
    if (this.state === "closed") return;

    const mem = memoryMb(stats);
    const net = networkTotals(stats);
    if (mem === null || net === null) {
      if (!this.warnedNoNetwork) {
        this.warnedNoNetwork = true;
        this.options.logger.warn(
          { hasMemory: mem !== null, hasNetwork: net !== null },
          "Docker stats lack memory or network figures, container samples are skipped",
        );
      }
      return;
    }
    const sample: ContainerSample = {
      cpuPct: cpuPercent(stats),
      memMb: mem,
      // Counters only go up; a lower reading means the container restarted, so count from zero.
      netRxBytes: net.rx >= this.previousNet.rx ? net.rx - this.previousNet.rx : net.rx,
      netTxBytes: net.tx >= this.previousNet.tx ? net.tx - this.previousNet.tx : net.tx,
    };
    this.previousNet = net;
    this.peakMem = Math.max(this.peakMem, mem);
    this.count++;
    if (this.sink) this.sink(sample);
    else this.held.push(sample);
  }
}
