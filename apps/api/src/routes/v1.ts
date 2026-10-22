import type { FastifyPluginAsync } from "fastify";

/** Everything under /v1. Empty for now: POST /v1/events and the query routes arrive in M1. */
export const v1Routes: FastifyPluginAsync = async (_app) => {};
