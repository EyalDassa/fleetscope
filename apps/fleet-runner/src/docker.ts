import Docker from "dockerode";
import type { Logger } from "pino";
import { type ConnectMode, ENGINE_SPECS } from "./engines";
import { parseStatsFrames, type StatsStream } from "./stats";

/**
 * Labels on every container. `pnpm fleet cleanup` finds containers by `fleetscope.session`
 * (all runs), the end of a run by `fleetscope.run` (only its own, so a second run in another
 * terminal is left alone).
 */
export const LABEL_ENGINE = "fleetscope.engine";
export const LABEL_SESSION = "fleetscope.session";
export const LABEL_RUN = "fleetscope.run";
/** `browser` on the browser container, `forwarder` on its sidecar. */
export const LABEL_ROLE = "fleetscope.role";

export interface BrowserContainer {
  id: string;
  /** How to connect to `endpoint`. */
  connectMode: ConnectMode;
  /**
   * What to hand to Playwright: `ws://127.0.0.1:<port>/` for `chromium.connect()` and for
   * `connectOverCDP` of a WebSocket engine, `http://127.0.0.1:<port>` for `connectOverCDP` of an
   * engine that serves `/json/version`.
   */
  endpoint: string;
  /**
   * Milliseconds from asking Docker for the browser container until the browser answered its
   * readiness check. The sidecar starts alongside and is not counted.
   */
  startupMs: number;
  /**
   * The engine's own version if `/json/version` names one in a way Playwright cannot see
   * (Lightpanda's `Lightpanda-Version`: through CDP it claims to be a Chrome). `undefined` otherwise.
   */
  engineVersion: string | undefined;
  /** When Docker started the container (epoch ms, Docker's clock), if it said. */
  startedAtMs: number | undefined;
  /** Opens Docker's stats stream (browser container only): one frame about every second. */
  openStatsStream(): Promise<StatsStream>;
  /**
   * True if the forwarder sidecar is no longer running (it died mid-session), so a failed page load
   * is the runner's infrastructure, not the engine. `false` if it runs or there is no sidecar.
   */
  forwarderExited(): Promise<boolean>;
  /** Force-removes the sidecar first, then the browser (and its volumes). Safe to call twice. */
  remove(): Promise<void>;
}

export interface StartOptions {
  sessionId: string;
  /** Aborts waiting for the server (Ctrl+C). The container is removed before the error is thrown. */
  signal?: AbortSignal;
  /** How long to wait for the server. Default 60 s. */
  readyTimeoutMs?: number;
}

export interface ForwarderOptions {
  /** Sidecar image (`fleetscope/forwarder:1-1`). */
  image: string;
  /** Environment of the sidecar, e.g. `DEMO_SITE_UPSTREAM=host.docker.internal:3100`. */
  env?: string[];
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

/** The sidecar's bind failed because something already listens on that port. */
const PORT_BUSY = /EADDRINUSE|address already in use/i;
const SIDECAR_READY_TIMEOUT_MS = 15_000;

/**
 * Our whole use of Docker: start one browser container and its forwarder sidecar, find ours,
 * remove ours.
 */
export class DockerFleet {
  readonly docker: Docker;
  private readonly env: string[];
  private readonly forwarder: ForwarderOptions | undefined;
  private readonly runId: string | undefined;
  private startingNow = 0;

  constructor(
    private readonly image: string,
    private readonly engine: string,
    private readonly logger: Logger,
    options: {
      /** Extra environment for the browser container, as "NAME=value". */
      env?: string[];
      /**
       * Starts a forwarder sidecar next to every browser (`NetworkMode: container:<browser>`), so
       * `localhost:3100` in the browser reaches the demo site and the forwarder's memory is not in
       * the browser's cgroup. Without it no sidecar is started (unit tests).
       */
      forwarder?: ForwarderOptions;
      /** Marks this fleet's containers as belonging to one run (label `fleetscope.run`). */
      runId?: string;
      docker?: Docker;
    } = {},
  ) {
    this.env = options.env ?? [];
    this.forwarder = options.forwarder;
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

  /** True if the browser image is present locally. */
  async hasImage(image: string = this.image): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return false;
      throw error;
    }
  }

  /**
   * Creates and starts the browser container and its sidecar, then waits until the browser answers
   * its readiness check over HTTP. (A TCP connect is not enough: Docker Desktop accepts connections
   * on the published port before anything listens inside.) The sidecar must be listening too before
   * this returns, but its time is not part of `startupMs`.
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
    const spec = ENGINE_SPECS[this.engine as keyof typeof ENGINE_SPECS];
    if (!spec) throw new Error(`no engine table entry for "${this.engine}"`);
    const serverPort = `${spec.port}/tcp`;
    const startedAt = performance.now();
    const labels = {
      [LABEL_ENGINE]: this.engine,
      [LABEL_SESSION]: options.sessionId,
      ...(this.runId && { [LABEL_RUN]: this.runId }),
    };
    const container = await this.docker.createContainer({
      Image: this.image,
      Env: [...spec.env, ...this.env],
      Labels: { ...labels, [LABEL_ROLE]: "browser" },
      ExposedPorts: { [serverPort]: {} },
      HostConfig: {
        Init: true, // reap Chromium's child processes
        // No IpcMode: "host". Playwright starts Chromium with --disable-dev-shm-usage, so it does not
        // need the host's /dev/shm, and a private IPC namespace keeps sessions apart.
        // Random free host port, reachable from this machine only.
        PortBindings: { [serverPort]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
        // Lets the browser reach the demo site running on the host (Docker Desktop and Linux).
        // It goes on the browser: Docker refuses --add-host together with a shared network namespace.
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });

    let sidecar: Docker.Container | undefined;
    const removeOne = async (target: Docker.Container): Promise<void> => {
      try {
        await target.remove({ force: true, v: true });
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    };
    // Sidecar first, then the browser whose network it shares.
    const remove = async (): Promise<void> => {
      if (sidecar) {
        const target = sidecar;
        await removeOne(target).catch((e) => this.warnRemove(e, target.id));
      }
      await removeOne(container);
    };

    try {
      // Ctrl+C while Docker was creating it: do not bother starting what we are about to remove.
      if (options.signal?.aborted)
        throw new Error("interrupted while the browser container was starting");
      await container.start();
      const info = await container.inspect();
      const binding = info.NetworkSettings.Ports?.[serverPort]?.[0];
      if (!binding?.HostPort) throw new Error("Docker did not publish the browser port");
      const base = `127.0.0.1:${binding.HostPort}`;

      // The sidecar is created while the browser starts. `startupMs` is taken the moment the
      // browser itself answers, whatever the sidecar is doing.
      let startupMs = 0;
      let engineVersion: string | undefined;
      const browserReady = this.waitForServer(
        container,
        `http://${base}${spec.readyPath}`,
        options,
      ).then((body) => {
        startupMs = performance.now() - startedAt;
        engineVersion = readEngineVersion(body);
      });
      const sidecarReady = (async () => {
        if (!this.forwarder) return;
        sidecar = await this.docker.createContainer({
          Image: this.forwarder.image,
          Env: this.forwarder.env ?? [],
          Labels: { ...labels, [LABEL_ROLE]: "forwarder" },
          HostConfig: { NetworkMode: `container:${container.id}` },
        });
        await sidecar.start();
        await this.waitForSidecar(sidecar, options);
      })();
      // Wait for both, so nothing is still starting when we clean up after a failure.
      const [browserResult, sidecarResult] = await Promise.allSettled([browserReady, sidecarReady]);
      if (browserResult.status === "rejected") throw browserResult.reason;
      if (sidecarResult.status === "rejected") throw sidecarResult.reason;

      const containerStartedAt = Date.parse(info.State?.StartedAt ?? "");
      return {
        id: container.id,
        connectMode: spec.connect,
        endpoint: spec.connect === "cdp-http" ? `http://${base}` : `ws://${base}/`,
        startupMs,
        engineVersion,
        startedAtMs: Number.isFinite(containerStartedAt) ? containerStartedAt : undefined,
        openStatsStream: async () => {
          // The browser container only: the sidecar is outside its cgroup on purpose.
          const stream = (await container.stats({
            stream: true,
          })) as unknown as NodeJS.ReadableStream & {
            destroy(): void;
          };
          return { frames: parseStatsFrames(stream), close: () => stream.destroy() };
        },
        forwarderExited: async () => {
          if (!sidecar) return false;
          try {
            return !(await sidecar.inspect()).State.Running;
          } catch {
            return false;
          }
        },
        remove,
      };
    } catch (error) {
      await remove().catch((removeError) => this.warnRemove(removeError, container.id));
      throw error;
    }
  }

  private warnRemove(error: unknown, id: string | undefined): void {
    this.logger.warn({ err: error, container: id }, "could not remove container");
  }

  /**
   * Ids of the containers this tool started (any state, browsers and sidecars), found by label:
   * every run's, or only those of one run.
   */
  async listOwned(scope: { runId?: string } = {}): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [LABEL_SESSION, ...(scope.runId ? [`${LABEL_RUN}=${scope.runId}`] : [])],
      },
    });
    // Sidecars first: they share a browser's network namespace.
    return containers
      .sort((a, b) => Number(isForwarder(b.Labels)) - Number(isForwarder(a.Labels)))
      .map((c) => c.Id);
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
  ): Promise<string> {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = "no answer yet";
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      if (signal?.aborted) throw new Error("interrupted while the browser container was starting");
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        const body = await response.text().catch(() => "");
        if (response.ok) return body;
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

  /**
   * Waits until the forwarder logs that it listens. If its bind fails because the port is taken,
   * the browser image brings its own forwarder (the chromium image before M3): that is an error,
   * because its memory would be inside this browser's samples and not inside the other engines'.
   */
  private async waitForSidecar(sidecar: Docker.Container, { signal }: StartOptions): Promise<void> {
    const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS;
    let logs = "";
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("interrupted while the browser container was starting");
      logs = await sidecar
        .logs({ stdout: true, stderr: true })
        .then((buffer) => demuxLogs(buffer))
        .catch(() => logs);
      // "forward-port: 127.0.0.1:3100 -> host.docker.internal:3100"
      if (/127\.0\.0\.1:\d+ -> /.test(logs)) return;
      const state = (await sidecar.inspect()).State;
      if (!state.Running) {
        // Port 3100 already taken inside the browser: the browser image runs its own forwarder (a
        // stale image). Its memory would be in every sample of this engine and not in the others'.
        if (PORT_BUSY.test(logs)) {
          throw new Error(
            "port 3100 is already taken inside the browser container: the browser image runs its own forwarder (stale image?). Run: pnpm browsers:build",
          );
        }
        throw new Error(
          `forwarder sidecar exited with code ${state.ExitCode}${logs ? `: ${logs}` : ""}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `forwarder sidecar did not start listening within ${SIDECAR_READY_TIMEOUT_MS} ms${logs ? `: ${logs}` : ""}`,
    );
  }
}

/** `Lightpanda-Version` from a `/json/version` body, if there is one. Never throws. */
export function readEngineVersion(body: string): string | undefined {
  try {
    const version = (JSON.parse(body) as Record<string, unknown>)["Lightpanda-Version"];
    return typeof version === "string" && version.trim() !== "" ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isForwarder(labels: Record<string, string> | undefined): boolean {
  return labels?.[LABEL_ROLE] === "forwarder";
}
