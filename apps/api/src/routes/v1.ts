import type { FastifyPluginAsync } from "fastify";

/**
 * Everything under /v1 that is registered with the prefix. Empty for now: the query routes arrive
 * with the dashboard (M2). `POST /v1/events` is registered in routes/events.ts with the full path
 * from `INGEST_PATH`, so the collector and the API share one constant.
 */
export const v1Routes: FastifyPluginAsync = async (_app) => {};
