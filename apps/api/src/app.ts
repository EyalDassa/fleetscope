import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health";
import { v1Routes } from "./routes/v1";

/** Everything the app needs from the outside world. Tests pass fakes. */
export interface AppDeps {
  /** Resolves true when ClickHouse answers. Should not throw; a throw counts as "down". */
  ping: () => Promise<boolean>;
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
    disableRequestLogging: (request) => request.url.split("?")[0] === "/healthz",
    // Honour X-Request-Id from a proxy; otherwise Fastify generates one for log correlation.
    requestIdHeader: "x-request-id",
  });

  app.register(healthRoutes, {
    ping: deps.ping,
    timeoutMs: deps.healthTimeoutMs ?? 1000,
  });
  // Versioned API. Ingest and query routes arrive in M1.
  app.register(v1Routes, { prefix: "/v1" });

  return app;
}
