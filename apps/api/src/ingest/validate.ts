import {
  EventBatch,
  type FleetEvent,
  type IngestErrorResponse,
  MAX_BATCH_SIZE,
} from "@fleetscope/schema";

/** An event whose `ts` is further ahead of the server clock than this is rejected. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** A 1000-event batch can have thousands of issues; the answer only carries the first ones. */
export const MAX_REPORTED_ISSUES = 20;

export type CheckedBatch =
  | { ok: true; events: FleetEvent[] }
  | { ok: false; status: 400 | 413; body: IngestErrorResponse };

/**
 * Everything the API checks before it accepts a batch:
 *  1. at most MAX_BATCH_SIZE events (413, checked first so a huge batch is not parsed in full),
 *  2. every event matches the schema (400, with the zod issues),
 *  3. no event is more than MAX_FUTURE_SKEW_MS ahead of `now` (400, naming the indexes).
 *
 * The schema cannot do (3): it has no clock. It also bounds `ts` to a plausible range
 * [2020, 2100), but a `ts` in the year 2090 would still create partitions nobody expects.
 */
export function checkBatch(body: unknown, now: number): CheckedBatch {
  if (Array.isArray(body) && body.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      status: 413,
      body: { error: `batch has ${body.length} events, the limit is ${MAX_BATCH_SIZE}` },
    };
  }

  const parsed = EventBatch.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      // zod paths may contain symbols; the response only allows strings and numbers.
      path: issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
      message: issue.message,
    }));
    const shown = issues.slice(0, MAX_REPORTED_ISSUES);
    const more =
      issues.length > shown.length
        ? ` (showing the first ${shown.length} of ${issues.length})`
        : "";
    return {
      ok: false,
      status: 400,
      body: { error: `invalid event batch${more}`, issues: shown },
    };
  }

  const limit = now + MAX_FUTURE_SKEW_MS;
  const tooLate: number[] = [];
  parsed.data.forEach((event, index) => {
    if (event.ts > limit) tooLate.push(index);
  });
  if (tooLate.length > 0) {
    const listed = tooLate.slice(0, MAX_REPORTED_ISSUES);
    const minutes = MAX_FUTURE_SKEW_MS / 60_000;
    return {
      ok: false,
      status: 400,
      body: {
        error: `${tooLate.length} event(s) have a ts more than ${minutes} minutes in the future (indexes ${listed.join(", ")}${listed.length < tooLate.length ? ", ..." : ""})`,
        issues: listed.map((index) => ({
          path: [index, "ts"],
          message: `ts is more than ${minutes} minutes ahead of the server clock`,
        })),
      },
    };
  }

  return { ok: true, events: parsed.data };
}
