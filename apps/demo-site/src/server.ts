import { buildApp } from "./app";
import { loadDemoSiteEnv } from "./env";

let env: ReturnType<typeof loadDemoSiteEnv>;
try {
  env = loadDemoSiteEnv();
} catch (error) {
  // The logger needs LOG_LEVEL, which may be what is invalid, so write this one by hand.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ level: 60, msg: message })}\n`);
  process.exit(1);
}

const app = await buildApp({ logLevel: env.LOG_LEVEL });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "error during shutdown");
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.DEMO_SITE_PORT, host: env.DEMO_SITE_HOST });
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}
