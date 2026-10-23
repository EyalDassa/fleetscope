import Fastify, { type FastifyInstance, LogController } from "fastify";
import { IngestBuffer, type IngestBufferOptions, type WriteBatch } from "./ingest/buffer";
import { eventsRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { v1Routes } from "./routes/v1";

/** Everything the app needs from the outside world. Tests pass fakes. */
export interface AppDeps {
  /** Resolves true when ClickHouse answers. Should not throw; a throw counts as "down". */
  ping: () => Promise<boolean>;
  /**
   * Writes one flush of events to ClickHouse (in production: `insertEvents`). Without it the app
   * has no `POST /v1/events`, which keeps tests of the other routes simple.
   */
  insert?: WriteBatch;
  /** Overrides for the ingest buffer (capacity, flush interval, ...). Mostly for tests. */
  ingest?: Partial<IngestBufferOptions>;
  /** Milliseconds since the epoch, for the skew check and the buffer. Defaults to `Date.now`. */
  now?: () => number;
  /** Jitter source for retry backoff, returns [0, 1). Defaults to `Math.random`. */
  random?: () => number;
  /** pino level, or false to silence logs (unit tests). Defaults to "info". */
  logLevel?: string | false;
  /** How long /healthz waits for ping before reporting ClickHouse as down. Default 1000. */
  healthTimeoutMs?: number;
  /** Where log lines go. Defaults to stdout; tests pass a stream to inspect them. */
  logStream?: { write(line: string): void };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const level = deps.logLevel ?? "info";
  const app = Fastify({
    logger: level === false ? false : { level, ...(deps.logStream && { stream: deps.logStream }) },
    // Orchestrators poll /healthz every few seconds; "incoming request" + "request completed" for
    // each probe would drown the logs. A failing probe is still reported (healthz logs a warning).
    logController: new LogController({
      disableRequestLogging: (request) => request.url.split("?")[0] === "/healthz",
    }),
    // Honour X-Request-Id from a proxy; otherwise Fastify generates one for log correlation.
    requestIdHeader: "x-request-id",
  });

  const buffer = deps.insert
    ? new IngestBuffer({
        write: deps.insert,
        log: app.log,
        now: deps.now,
        random: deps.random,
        options: deps.ingest,
      })
    : undefined;

  if (buffer) {
    app.register(eventsRoutes, { buffer, now: deps.now ?? Date.now });
    app.addHook("onReady", async () => buffer.start());
    // Fastify runs this after the HTTP server has stopped taking requests (and, with
    // `app.close()`, after in-flight requests have finished), so everything accepted gets flushed.
    app.addHook("onClose", async () => buffer.close());
  }

  app.register(healthRoutes, {
    ping: deps.ping,
    timeoutMs: deps.healthTimeoutMs ?? 1000,
    ...(buffer && { ingestStats: () => buffer.stats() }),
  });
  // Versioned API. Query routes arrive with the dashboard (M2).
  app.register(v1Routes, { prefix: "/v1" });

  return app;
}
