import Docker from "dockerode";
import type { Logger } from "pino";
import { parseStatsFrames, type StatsStream } from "./stats";

/**
 * Labels on every browser container. `pnpm fleet cleanup` finds containers by `fleetscope.session`
 * (all runs), the end of a run by `fleetscope.run` (only its own, so a second run in another
 * terminal is left alone).
 */
export const LABEL_ENGINE = "fleetscope.engine";
export const LABEL_SESSION = "fleetscope.session";
export const LABEL_RUN = "fleetscope.run";

/** Where Playwright's `run-server` listens inside the container. */
const SERVER_PORT = "3000/tcp";

export interface BrowserContainer {
  id: string;
  /** `ws://127.0.0.1:<port>/`, for `chromium.connect()`. */
  wsEndpoint: string;
  /** Milliseconds from asking Docker for the container until the server answered. */
  startupMs: number;
  /** When Docker started the container (epoch ms, Docker's clock), if it said. */
  startedAtMs: number | undefined;
  /** Opens Docker's stats stream: one frame about every second, over a single connection. */
  openStatsStream(): Promise<StatsStream>;
  /** Force-removes the container (and its anonymous volumes). Safe to call twice. */
  remove(): Promise<void>;
}

export interface StartOptions {
  sessionId: string;
  /** Aborts waiting for the server (Ctrl+C). The container is removed before the error is thrown. */
  signal?: AbortSignal;
  /** How long to wait for the server. Default 60 s. */
  readyTimeoutMs?: number;
}

/**
 * Docker sends the logs of a container without a terminal as a multiplexed stream: every frame is an
 * 8-byte header (stream type 0/1/2, three zero bytes, payload length as a big-endian uint32)
 * followed by the payload. Read raw, the text starts with header bytes that print as odd control characters.
 * This returns just the text. Logs of a container with a terminal have no headers and pass through.
 */
export function demuxLogs(raw: Buffer): string {
  const looksFramed = (at: number) =>
    at + 8 <= raw.length &&
    raw[at] !== undefined &&
    raw[at] <= 2 &&
    raw[at + 1] === 0 &&
    raw[at + 2] === 0 &&
    raw[at + 3] === 0;
  if (!looksFramed(0)) return raw.toString("utf8").trim();

  const parts: string[] = [];
  let offset = 0;
  while (looksFramed(offset)) {
    const size = raw.readUInt32BE(offset + 4);
    // A cut-off last frame still yields the part that arrived.
    parts.push(raw.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  if (offset < raw.length) parts.push(raw.subarray(offset).toString("utf8"));
  return parts.join("").trim();
}

/** True for Docker's "no such container / already being removed" answers. */
function isGone(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 409;
}

/** Our whole use of Docker: start one browser container, find ours, remove ours. */
export class DockerFleet {
  readonly docker: Docker;
  private readonly env: string[];
  private readonly runId: string | undefined;
  private startingNow = 0;

  constructor(
    private readonly image: string,
    private readonly engine: string,
    private readonly logger: Logger,
    options: {
      /** Extra environment for every container, as "NAME=value" (e.g. DEMO_SITE_UPSTREAM). */
      env?: string[];
      /** Marks this fleet's containers as belonging to one run (label `fleetscope.run`). */
      runId?: string;
      docker?: Docker;
    } = {},
  ) {
    this.env = options.env ?? [];
    this.runId = options.runId;
    // With no options dockerode follows DOCKER_HOST, else uses the Linux socket or the Windows pipe.
    this.docker = options.docker ?? new Docker();
  }

  /**
   * How many containers are being created or started right now. A container that Docker is still
   * creating when we sweep for leftovers would appear after the sweep, so the exit-now path waits
   * for this to reach zero.
   */
  get starting(): number {
    return this.startingNow;
  }

  /** Throws if the Docker daemon cannot be reached. */
  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async hasImage(): Promise<boolean> {
    try {
      await this.docker.getImage(this.image).inspect();
      return true;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return false;
      throw error;
    }
  }

  /**
   * Creates and starts a container, then waits until Playwright's server answers over HTTP.
   * (A TCP connect is not enough: Docker Desktop accepts connections on the published port before
   * anything listens inside.)
   */
  async startBrowser(options: StartOptions): Promise<BrowserContainer> {
    this.startingNow++;
    try {
      return await this.createAndStart(options);
    } finally {
      this.startingNow--;
    }
  }

  private async createAndStart(options: StartOptions): Promise<BrowserContainer> {
    const startedAt = performance.now();
    const container = await this.docker.createContainer({
      Image: this.image,
      Env: this.env,
      Labels: {
        [LABEL_ENGINE]: this.engine,
        [LABEL_SESSION]: options.sessionId,
        ...(this.runId && { [LABEL_RUN]: this.runId }),
      },
      ExposedPorts: { [SERVER_PORT]: {} },
      HostConfig: {
        Init: true, // reap Chromium's child processes
        // No IpcMode: "host". Playwright starts Chromium with --disable-dev-shm-usage, so it does not
        // need the host's /dev/shm, and a private IPC namespace keeps sessions apart.
        // Random free host port, reachable from this machine only.
        PortBindings: { [SERVER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
        // Lets the browser reach the demo site running on the host (Docker Desktop and Linux).
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });

    const remove = async (): Promise<void> => {
      try {
        await container.remove({ force: true, v: true });
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    };

    try {
      // Ctrl+C while Docker was creating it: do not bother starting what we are about to remove.
      if (options.signal?.aborted)
        throw new Error("interrupted while the browser container was starting");
      await container.start();
      const info = await container.inspect();
      const binding = info.NetworkSettings.Ports?.[SERVER_PORT]?.[0];
      if (!binding?.HostPort) throw new Error("Docker did not publish the browser server port");
      const base = `127.0.0.1:${binding.HostPort}`;
      await this.waitForServer(container, `http://${base}/`, options);
      const containerStartedAt = Date.parse(info.State?.StartedAt ?? "");
      return {
        id: container.id,
        wsEndpoint: `ws://${base}/`,
        startupMs: performance.now() - startedAt,
        startedAtMs: Number.isFinite(containerStartedAt) ? containerStartedAt : undefined,
        openStatsStream: async () => {
          const stream = (await container.stats({
            stream: true,
          })) as unknown as NodeJS.ReadableStream & {
            destroy(): void;
          };
          return { frames: parseStatsFrames(stream), close: () => stream.destroy() };
        },
        remove,
      };
    } catch (error) {
      await remove().catch((removeError) =>
        this.logger.warn(
          { err: removeError, container: container.id },
          "could not remove container",
        ),
      );
      throw error;
    }
  }

  /**
   * Ids of the containers this tool started (any state), found by label: every run's, or only
   * those of one run.
   */
  async listOwned(scope: { runId?: string } = {}): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [LABEL_SESSION, ...(scope.runId ? [`${LABEL_RUN}=${scope.runId}`] : [])],
      },
    });
    return containers.map((c) => c.Id);
  }

  /**
   * Force-removes labelled containers: all of them, or only those of `scope.runId`. Returns how
   * many were removed.
   */
  async removeAllOwned(scope: { runId?: string } = {}): Promise<number> {
    let removed = 0;
    for (const id of await this.listOwned(scope)) {
      try {
        await this.docker.getContainer(id).remove({ force: true, v: true });
        removed++;
      } catch (error) {
        if (isGone(error)) continue;
        this.logger.warn({ err: error, container: id }, "could not remove container");
      }
    }
    return removed;
  }

  private async waitForServer(
    container: Docker.Container,
    url: string,
    { signal, readyTimeoutMs = 60_000 }: StartOptions,
  ): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = "no answer yet";
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      if (signal?.aborted) throw new Error("interrupted while the browser container was starting");
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      // Every second or so, check the container did not die instead of starting.
      if (attempt % 10 === 9) await this.assertRunning(container);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`browser server did not answer within ${readyTimeoutMs} ms (${lastError})`);
  }

  private async assertRunning(container: Docker.Container): Promise<void> {
    const state = (await container.inspect()).State;
    if (state.Running) return;
    const logs = await container
      .logs({ stdout: true, stderr: true, tail: 20 })
      .then((buffer) => demuxLogs(buffer))
      .catch(() => "");
    throw new Error(
      `browser container exited with code ${state.ExitCode} while starting${logs ? `: ${logs}` : ""}`,
    );
  }
}
