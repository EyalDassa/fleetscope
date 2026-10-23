import { StringDecoder } from "node:string_decoder";
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
 * `cpu_delta / system_delta * online_cpus * 100`. The deltas are between this frame and
 * `precpu_stats`, the frame Docker sent about one second earlier, so it is the average over that
 * last second.
 *
 * The very first frame of a stream has no previous frame. If `sinceStart` is given (the container's
 * start time and this frame's time, both from the Docker daemon's clock) the answer is then the
 * container's average since it started, which for a fresh container is the whole launch of the
 * browser. Without it, or when there is nothing to divide by, the answer is 0.
 */
export function cpuPercent(stats: DockerStats, sinceStart?: { startedAtMs: number }): number {
  const total = stats.cpu_stats?.cpu_usage?.total_usage;
  if (total === undefined) return 0;
  const cpus =
    stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

  const previousTotal = stats.precpu_stats?.cpu_usage?.total_usage;
  const system = stats.cpu_stats?.system_cpu_usage;
  const previousSystem = stats.precpu_stats?.system_cpu_usage;
  const hasPrevious =
    previousTotal !== undefined &&
    system !== undefined &&
    previousSystem !== undefined &&
    previousSystem > 0; // the first frame of a stream reports zeros here
  if (hasPrevious) {
    const cpuDelta = total - previousTotal;
    const systemDelta = system - previousSystem;
    if (cpuDelta <= 0 || systemDelta <= 0) return 0;
    return (cpuDelta / systemDelta) * cpus * 100;
  }

  if (!sinceStart || stats.read === undefined) return 0;
  const elapsedNs = (Date.parse(stats.read) - sinceStart.startedAtMs) * 1e6;
  if (!Number.isFinite(elapsedNs) || elapsedNs < 50e6) return 0; // under 50 ms: nothing to average
  return (total / elapsedNs) * 100;
}

/**
 * Memory in MB without the page cache, which is what `docker stats` shows: usage minus
 * `inactive_file` (cgroup v2), minus `total_inactive_file` or else `cache` (cgroup v1). Returns
 * `null` if Docker gave no usage figure. This is the whole container, so it includes the small
 * forwarder process of the browser image.
 */
export function memoryMb(stats: DockerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (usage === undefined) return null;
  const detail = stats.memory_stats?.stats ?? {};
  const cache = detail.inactive_file ?? detail.total_inactive_file ?? detail.cache ?? 0;
  return Math.max(0, usage - (cache < usage ? cache : 0)) / MB;
}

/**
 * Bytes received and sent since the container started, summed over its network interfaces. These
 * are container network bytes, not page bytes: the runner talks to the Playwright server through the
 * same interface, so every protocol message and screenshot is counted along with the page traffic.
 */
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

/**
 * Docker's stats stream is one JSON object per line. This turns the raw chunks into objects. A line
 * that is not valid JSON (a cut-off last line, noise) is skipped.
 */
export async function* parseStatsFrames(
  chunks: AsyncIterable<Buffer | string>,
): AsyncGenerator<DockerStats> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of chunks) {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line !== "") {
        const frame = parseFrame(line);
        if (frame) yield frame;
      }
      newline = pending.indexOf("\n");
    }
  }
  const rest = pending.trim();
  if (rest !== "") {
    const frame = parseFrame(rest);
    if (frame) yield frame;
  }
}

function parseFrame(line: string): DockerStats | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" ? (value as DockerStats) : null;
  } catch {
    return null;
  }
}

/** A running stats stream of one container. `close()` ends it (and the loop over `frames`). */
export interface StatsStream {
  frames: AsyncIterable<DockerStats>;
  close(): void;
}

export interface StatsSamplerOptions {
  /** Opens Docker's stats stream for the container (`container.stats({ stream: true })`). */
  openStream: () => Promise<StatsStream>;
  onSample: (sample: ContainerSample) => void;
  logger: Logger;
  /** Time between samples. Default 2000. */
  intervalMs?: number;
  /** When the container started (epoch ms, Docker's clock): lets the first sample report CPU. */
  containerStartedAtMs?: number;
  /**
   * How long `stop()` waits for a first frame if none has arrived yet. Default 10 000: a first
   * frame normally comes within milliseconds, but a Docker daemon under load has been seen to take
   * 10 s to answer a stats call, and a late sample beats none.
   */
  firstFrameTimeoutMs?: number;
  /** Test hook. */
  now?: () => number;
}

export interface StopOptions {
  /**
   * Take the last sample (default true): the newest frame, if it has not been sampled yet. Pass
   * false to just cancel, e.g. when the session never started.
   */
  finalSample?: boolean;
}

/**
 * Samples one container from Docker's stats stream.
 *
 * Docker sends a frame about every second over one open connection. We keep the newest frame and
 * turn it into a sample every `intervalMs`: the first frame at once, then whenever a frame arrives
 * and the last sample is old enough. `stop()` makes the newest frame the last sample, so there is
 * no slow call at the end of a session: a session of half a second still has a measurement, and
 * the machine being busy only delays frames, it does not make a call that we have to wait for.
 *
 * Samples are stamped with the time their frame arrived. After `stop()` returns nothing is emitted,
 * the stream is closed, and no timer is left running.
 */
export class StatsSampler {
  private state: "idle" | "running" | "closed" = "idle";
  private stream: StatsStream | null = null;
  private loop: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private latest: { frame: DockerStats; at: number } | null = null;
  private lastSampled: { at: number } | null = null;
  private wakeFirstFrame: (() => void) | null = null;
  private previousNet = { rx: 0, tx: 0 };
  private peakMem = 0;
  private count = 0;
  private warnedIncomplete = false;

  constructor(private readonly options: StatsSamplerOptions) {}

  private get isClosed(): boolean {
    return this.state === "closed";
  }

  /** Highest memory sample so far, in MB (0 before the first sample). */
  get peakMemMb(): number {
    return this.peakMem;
  }

  get sampleCount(): number {
    return this.count;
  }

  /** Opens the stream and starts sampling. */
  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.loop = this.run();
  }

  /** Makes the newest frame the last sample (unless asked not to) and shuts everything down. */
  stop(options: StopOptions = {}): Promise<void> {
    this.stopping ??= this.shutDown(options.finalSample ?? true);
    return this.stopping;
  }

  private async run(): Promise<void> {
    try {
      const stream = await this.options.openStream();
      if (this.isClosed) {
        stream.close();
        return;
      }
      this.stream = stream;
      for await (const frame of stream.frames) {
        if (this.isClosed) break;
        this.onFrame(frame);
      }
    } catch (error) {
      // After stop() the stream is closed on purpose and may end with an error; before it, it is news.
      if (!this.isClosed) {
        this.options.logger.warn({ err: error }, "container stats stream ended");
      }
    } finally {
      this.wakeFirstFrame?.();
    }
  }

  private onFrame(frame: DockerStats): void {
    const at = (this.options.now ?? Date.now)();
    this.latest = { frame, at };
    this.wakeFirstFrame?.();
    const interval = this.options.intervalMs ?? 2000;
    // Frames come about a second apart, so "old enough" allows some slack: 2 s of interval means
    // every second frame, not every third when one arrives a little early.
    if (this.lastSampled === null || at - this.lastSampled.at >= interval * 0.75) {
      this.sample(this.latest);
    }
  }

  private sample(reading: { frame: DockerStats; at: number }): void {
    const { frame, at } = reading;
    const mem = memoryMb(frame);
    const net = networkTotals(frame);
    if (mem === null || net === null) {
      if (!this.warnedIncomplete) {
        this.warnedIncomplete = true;
        this.options.logger.warn(
          { hasMemory: mem !== null, hasNetwork: net !== null },
          "Docker stats lack memory or network figures, container samples are skipped",
        );
      }
      this.lastSampled = { at };
      return;
    }
    const started = this.options.containerStartedAtMs;
    const sample: ContainerSample = {
      cpuPct: cpuPercent(frame, started === undefined ? undefined : { startedAtMs: started }),
      memMb: mem,
      // Counters only go up; a lower reading means the container restarted, so count from zero.
      netRxBytes: net.rx >= this.previousNet.rx ? net.rx - this.previousNet.rx : net.rx,
      netTxBytes: net.tx >= this.previousNet.tx ? net.tx - this.previousNet.tx : net.tx,
      readAt: at,
    };
    this.previousNet = net;
    this.lastSampled = { at };
    this.peakMem = Math.max(this.peakMem, mem);
    this.count++;
    this.options.onSample(sample);
  }

  private async shutDown(finalSample: boolean): Promise<void> {
    if (finalSample && this.state === "running") {
      if (this.latest === null) await this.waitForFirstFrame();
      const newest = this.latest;
      if (newest !== null && newest.at !== this.lastSampled?.at) {
        this.sample(newest);
      } else if (newest === null) {
        this.options.logger.warn("session ends without a container sample: no stats frame arrived");
      }
    }
    this.state = "closed";
    this.stream?.close();
    // The loop ends once the stream is closed; do not wait long for a stream that will not.
    await withTimeout(this.loop, 1000);
  }

  private async waitForFirstFrame(): Promise<void> {
    const timeoutMs = this.options.firstFrameTimeoutMs ?? 10_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      this.wakeFirstFrame = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
    this.wakeFirstFrame = null;
  }
}

/** Waits for `promise` but at most `ms`; never rejects. */
async function withTimeout(promise: Promise<unknown> | null, ms: number): Promise<void> {
  if (!promise) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * For a source that can only be read one reading at a time (no stream): reads it back to back and
 * treats every reading as a frame. The runner does not use it, because Docker has a stream; it is
 * here so the older load tests (which feed `readStats`) keep running. Delete it together with
 * `stats.load.test.ts` once those tests are ported to `StatsSampler`.
 */
export class StatsPoller extends StatsSampler {
  constructor(
    options: Omit<StatsSamplerOptions, "openStream"> & { readStats: () => Promise<DockerStats> },
  ) {
    const { readStats, ...rest } = options;
    super({
      ...rest,
      openStream: async () => {
        let closed = false;
        async function* frames(): AsyncGenerator<DockerStats> {
          while (!closed) {
            try {
              const frame = await readStats();
              if (!closed) yield frame;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 100)); // Docker busy or container gone
            }
          }
        }
        return {
          frames: frames(),
          close: () => {
            closed = true;
          },
        };
      },
    });
  }
}
