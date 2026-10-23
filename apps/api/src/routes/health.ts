import { SCHEMA_VERSION } from "@fleetscope/schema";
import type { FastifyPluginAsync } from "fastify";
import type { IngestStats } from "../ingest/buffer";

export interface HealthOptions {
  ping: () => Promise<boolean>;
  timeoutMs: number;
  /** Buffer numbers to add to the answer. Absent when the app has no ingest endpoint. */
  ingestStats?: () => IngestStats;
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
 *   200 { status: "ok", clickhouse: "ok", schemaVersion, ingest? }
 *   503 { status: "degraded", clickhouse: "down", ingest? }
 *
 * The status code only says whether ClickHouse answers (liveness). `ingest` is information for
 * people and dashboards: how much is queued, how old the oldest event is, and why the last flush
 * failed (a short error name, not the message, because this endpoint has no authentication).
 */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, options) => {
  app.get("/healthz", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const ingest = options.ingestStats ? { ingest: options.ingestStats() } : {};
    if (await clickhouseIsUp(options.ping, options.timeoutMs)) {
      return { status: "ok", clickhouse: "ok", schemaVersion: SCHEMA_VERSION, ...ingest };
    }
    request.log.warn("healthz: ClickHouse is down");
    return reply.code(503).send({ status: "degraded", clickhouse: "down", ...ingest });
  });
};
