import { z } from "zod";
import { type EventType, type FleetEvent, SCHEMA_VERSION } from "./events";

/**
 * The ingest contract: what `POST /v1/events` accepts and answers (PLAN.md section 5).
 *
 *   202  IngestAcceptedResponse   events were queued (not necessarily in ClickHouse yet)
 *   400  IngestErrorResponse      malformed JSON, schema violation, or `ts` too far in the future
 *   413  IngestErrorResponse      more than MAX_BATCH_SIZE events, or the body is too large
 *   503  IngestErrorResponse      the ingest buffer is full; `Retry-After` says when to retry
 */

/** The ingest endpoint. Used by the API (to register the route) and the collector (to call it). */
export const INGEST_PATH = "/v1/events";

/**
 * `accepted` events were queued for ClickHouse; `duplicates` were dropped because their `event_id`
 * was seen recently (a client retry). `accepted + duplicates` is the number of events sent.
 */
export const IngestAcceptedResponse = z.object({
  accepted: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
});
export type IngestAcceptedResponse = z.infer<typeof IngestAcceptedResponse>;

/** Body of every non-2xx answer. `issues` lists what was wrong when the body failed validation. */
export const IngestErrorResponse = z.object({
  error: z.string(),
  issues: z
    .array(
      z.object({
        /** Where in the body, e.g. `[3, "ts"]` is the `ts` of the fourth event. */
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      }),
    )
    .optional(),
});
export type IngestErrorResponse = z.infer<typeof IngestErrorResponse>;

// newEvent ---------------------------------------------------------------------------------

/** The fields that identify who produced an event. A collector keeps one per session. */
export type EventEnvelope = Pick<
  FleetEvent,
  "session_id" | "source" | "agent_id" | "engine" | "provider"
>;

/** The event with the given `type` (e.g. `"action"` gives `ActionEvent`). */
export type EventOfType<T extends EventType> = Extract<FleetEvent, { type: T }>;

/** What the caller supplies for an event of this type: everything `newEvent` doesn't fill in. */
export type EventFields<T extends EventType> = Omit<
  EventOfType<T>,
  keyof EventEnvelope | "v" | "type" | "event_id" | "ts"
>;

/**
 * Builds an event of the given type: adds `v`, `type`, a fresh `event_id` and `ts` (default: now,
 * in milliseconds) around the envelope and the type-specific fields. The type of `fields` follows
 * `type`, so a missing or misspelled field is a compile error.
 *
 *   newEvent("action", ctx, { seq: 0, action_type: "goto", target: "example.com",
 *                             duration_ms: 120, ok: true, error_code: null })
 *
 * It does not validate values at runtime (bounds, uuid format); the API does that with `EventBatch`.
 */
export function newEvent<T extends EventType>(
  type: T,
  envelope: EventEnvelope,
  fields: EventFields<T>,
  ts: number = Date.now(),
): EventOfType<T> {
  // Only the five envelope fields are copied (a caller may pass a bigger context object), and the
  // generated values come last so `fields` cannot overwrite them.
  const { session_id, source, agent_id, engine, provider } = envelope;
  const event = {
    session_id,
    source,
    agent_id,
    engine,
    provider,
    ...fields,
    v: SCHEMA_VERSION,
    type,
    event_id: crypto.randomUUID(),
    ts,
  };
  return event as unknown as EventOfType<T>;
}
