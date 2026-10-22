import { SCHEMA_VERSION } from "@fleetscope/schema";
import type { FastifyPluginAsync } from "fastify";

export interface HealthOptions {
  ping: () => Promise<boolean>;
  timeoutMs: number;
}

/** Resolve true only if `ping` says yes within the timeout; never rejects. */
async function clickhouseIsUp(ping: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([ping().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /healthz
 *   200 { status: "ok", clickhouse: "ok", schemaVersion }
 *   503 { status: "degraded", clickhouse: "down" }
 */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, options) => {
  app.get("/healthz", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (await clickhouseIsUp(options.ping, options.timeoutMs)) {
      return { status: "ok", clickhouse: "ok", schemaVersion: SCHEMA_VERSION };
    }
    request.log.warn("healthz: ClickHouse is down");
    return reply.code(503).send({ status: "degraded", clickhouse: "down" });
  });
};
