import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ChaosStore } from "./chaos";
import { registerChaosGate } from "./chaos-gate";
import { chaosPageRoutes } from "./routes/chaos-pages";
import { shopRoutes } from "./routes/shop";
import { SessionStore } from "./session";

/** Everything buildApp can be told from outside. All optional; tests pass fakes. */
export interface AppOptions {
  /** pino level, or false to silence logs (unit tests). Defaults to "info". */
  logLevel?: string | false;
  /** Where log lines go. Defaults to stdout. */
  logStream?: { write(line: string): void };
  /** Waits for `ms` before a slow page answers. Tests replace it so they do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The random source for requests without ?seed. Defaults to Math.random. */
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const level = options.logLevel ?? "info";
  const app = Fastify({
    logger:
      level === false ? false : { level, ...(options.logStream && { stream: options.logStream }) },
    // A health probe every few seconds would drown the logs.
    logController: new LogController({
      disableRequestLogging: (request) => request.url.split("?")[0] === "/healthz",
    }),
    requestIdHeader: "x-request-id",
  });

  // JSON bodies are only used by POST /admin/chaos. An empty body counts as {} so that a
  // client that sends "content-type: application/json" with no body does not get a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = (body as string).trim();
    if (text === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error("Body is not valid JSON") as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  const store = new ChaosStore();
  const sessions = new SessionStore();
  await registerChaosGate(app, {
    store,
    sleep: options.sleep ?? realSleep,
    random: options.random ?? Math.random,
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  await app.register(shopRoutes, { sessions });
  await app.register(chaosPageRoutes);

  return app;
}
