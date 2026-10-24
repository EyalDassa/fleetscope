import {
  ConfigError,
  createClickHouseClient,
  getSessionTimeline,
  getTimelineSession,
  insertEvents,
  ping,
  toDbConfig,
} from "@fleetscope/db";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";
import { fileDeadLetter } from "./ingest/dead-letter";

let env: ReturnType<typeof loadApiEnv>;
try {
  env = loadApiEnv();
} catch (error) {
  if (error instanceof ConfigError) {
    // The logger needs LOG_LEVEL, which may be what is invalid, so write this one by hand.
    process.stderr.write(`${JSON.stringify({ level: 60, msg: error.message })}\n`);
    process.exit(1);
  }
  throw error;
}

const client = createClickHouseClient(toDbConfig(env));
const app = buildApp({
  ping: () => ping(client, 1000),
  insert: (events, dedupTokens) => insertEvents(client, events, { dedupTokens }),
  getSessionTimeline: (sessionId) => getSessionTimeline(client, sessionId),
  getSession: (sessionId) => getTimelineSession(client, sessionId),
  ingest: { capacity: env.INGEST_BUFFER_CAPACITY },
  deadLetter: fileDeadLetter(env.INGEST_DEADLETTER_DIR),
  logLevel: env.LOG_LEVEL,
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  try {
    // In this order: stop taking requests and flush the ingest buffer (app.close does both, up to
    // 10 s), and only then close the ClickHouse client the flush needs.
    await app.close();
    await client.close();
  } catch (error) {
    app.log.error({ err: error }, "error during shutdown");
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}
