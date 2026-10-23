import type { DockerStats, StatsStream } from "./stats";

/**
 * A stand-in for Docker's stats stream that tests feed by hand: `push(frame)` delivers a frame,
 * `end()` ends the stream normally, `fail(error)` ends it with an error. `stream.close()` ends it
 * too, like the real one when the runner is done.
 */
export function fakeStatsStream() {
  const queue: DockerStats[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  let closedByConsumer = false;

  const signal = () => {
    wake?.();
    wake = null;
  };

  async function* frames(): AsyncGenerator<DockerStats> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (failure) throw failure;
      if (finished || closedByConsumer) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const stream: StatsStream = {
    frames: frames(),
    close: () => {
      closedByConsumer = true;
      signal();
    },
  };

  return {
    stream,
    push(frame: DockerStats) {
      queue.push(frame);
      signal();
    },
    end() {
      finished = true;
      signal();
    },
    fail(error: Error) {
      failure = error;
      signal();
    },
    get closedByConsumer() {
      return closedByConsumer;
    },
  };
}

const MB = 1024 * 1024;

/** A stats frame as Docker sends it: cumulative counters, plus the previous frame's CPU numbers. */
export function frame(options: {
  /** Container CPU time so far, in nanoseconds. */
  cpuNs: number;
  /** The same for the previous frame (Docker's `precpu_stats`); 0 for the first frame. */
  previousCpuNs?: number;
  systemNs: number;
  previousSystemNs?: number;
  memMb?: number;
  rx?: number;
  tx?: number;
  /** The daemon's time for the frame, ISO. */
  read?: string;
}): DockerStats {
  return {
    read: options.read,
    cpu_stats: {
      cpu_usage: { total_usage: options.cpuNs },
      system_cpu_usage: options.systemNs,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: options.previousCpuNs ?? 0 },
      system_cpu_usage: options.previousSystemNs ?? 0,
    },
    memory_stats: { usage: (options.memMb ?? 100) * MB },
    networks: { eth0: { rx_bytes: options.rx ?? 0, tx_bytes: options.tx ?? 0 } },
  };
}
