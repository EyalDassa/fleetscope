import {
  INGEST_PATH,
  type IngestAcceptedResponse,
  type IngestErrorResponse,
} from "@fleetscope/schema";
import type { FastifyError, FastifyPluginAsync } from "fastify";
import type { IngestBuffer } from "../ingest/buffer";
import { checkBatch } from "../ingest/validate";

export interface EventsRouteOptions {
  buffer: IngestBuffer;
  /** Milliseconds since the epoch; tests pass a fake clock. */
  now: () => number;
}

/** 1000 events are about 300 KB; this leaves room for long targets and messages. */
export const INGEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** What `Retry-After` tells a collector when the buffer is full. */
export const RETRY_AFTER_SECONDS = 2;

/**
 * POST /v1/events (the contract is in packages/schema, `ingest.ts`)
 *   202 { accepted, duplicates }   queued; it reaches ClickHouse within about a second
 *   400 { error, issues? }         malformed JSON, schema violation, or ts too far in the future
 *   413 { error }                  more than 1000 events, or a body over 2 MB
 *   503 { error } + Retry-After    the buffer is full, or the server is shutting down
 */
export const eventsRoutes: FastifyPluginAsync<EventsRouteOptions> = async (app, options) => {
  // Fastify's own errors (bad JSON, wrong content type, body too large) get the same shape as ours.
  // This handler only covers the routes of this plugin.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "ingest request failed");
      return reply.code(500).send({ error: "internal error" } satisfies IngestErrorResponse);
    }
    return reply.code(status).send({ error: error.message } satisfies IngestErrorResponse);
  });

  app.post(INGEST_PATH, { bodyLimit: INGEST_BODY_LIMIT_BYTES }, async (request, reply) => {
    const checked = checkBatch(request.body, options.now());
    if (!checked.ok) {
      return reply.code(checked.status).send(checked.body);
    }

    const offered = options.buffer.offer(checked.events);
    if (!offered.ok) {
      const error =
        offered.reason === "full"
          ? "ingest buffer is full, retry later"
          : "server is shutting down, retry later";
      request.log.warn({ reason: offered.reason, events: checked.events.length }, "ingest refused");
      return reply
        .code(503)
        .header("retry-after", String(RETRY_AFTER_SECONDS))
        .send({ error } satisfies IngestErrorResponse);
    }

    return reply.code(202).send({
      accepted: offered.accepted,
      duplicates: offered.duplicates,
    } satisfies IngestAcceptedResponse);
  });
};
