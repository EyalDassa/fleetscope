import {
  EventBatch,
  type FleetEvent,
  type IngestErrorResponse,
  MAX_BATCH_SIZE,
  RETENTION_DAYS,
} from "@fleetscope/schema";

/** An event whose `ts` is further ahead of the server clock than this is rejected. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

/**
 * The oldest `ts` the API accepts: midnight UTC at the start of the day `RETENTION_DAYS - 1` days
 * ago (so 2026-09-24T00:00Z when it is 2026-10-23).
 *
 * The raw tables have `TTL toDate(ts) + INTERVAL 30 DAY`, which works on whole days: an event is
 * deleted when its day is 30 days old, at midnight. An event from 30 days ago would be stored and
 * deleted a moment later, so the client would be told 202 for data that is already gone. Refusing
 * it tells the truth, and it also caps one flush at 31 daily partitions (today back to the
 * cutoff, plus tomorrow when the clock skew allows), far below ClickHouse's limit of 100
 * partitions per INSERT (see docs/adr/0002-ingest-dedupe.md).
 */
export function oldestAcceptedTs(now: number): number {
  const startOfToday = now - (now % DAY_MS); // the Unix epoch starts at midnight UTC
  return startOfToday - (RETENTION_DAYS - 1) * DAY_MS;
}

/** A 1000-event batch can have thousands of issues; the answer only carries the first ones. */
export const MAX_REPORTED_ISSUES = 20;

export type CheckedBatch =
  | { ok: true; events: FleetEvent[] }
  | { ok: false; status: 400 | 413; body: IngestErrorResponse };

/** "indexes 1, 3, 7, ..." with at most MAX_REPORTED_ISSUES numbers. */
function listIndexes(indexes: number[]): string {
  const shown = indexes.slice(0, MAX_REPORTED_ISSUES);
  return `indexes ${shown.join(", ")}${shown.length < indexes.length ? ", ..." : ""}`;
}

/**
 * Everything the API checks before it accepts a batch:
 *  1. at most MAX_BATCH_SIZE events (413, checked first so a huge batch is not parsed in full),
 *  2. every event matches the schema (400, with the zod issues),
 *  3. no event is more than MAX_FUTURE_SKEW_MS ahead of `now` (400, naming the indexes),
 *  4. no event is older than the retention window, see `oldestAcceptedTs` (400, naming the indexes).
 *
 * The schema cannot do (3) and (4): it has no clock. It bounds `ts` to [2020, 2100), but a `ts` in
 * the year 2090 or in 2021 would still be a problem.
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

  const newest = now + MAX_FUTURE_SKEW_MS;
  const oldest = oldestAcceptedTs(now);
  const tooNew: number[] = [];
  const tooOld: number[] = [];
  parsed.data.forEach((event, index) => {
    if (event.ts > newest) tooNew.push(index);
    else if (event.ts < oldest) tooOld.push(index);
  });

  if (tooNew.length > 0 || tooOld.length > 0) {
    const problems: string[] = [];
    const issues: Array<{ path: number[] | (string | number)[]; message: string }> = [];
    if (tooNew.length > 0) {
      const minutes = MAX_FUTURE_SKEW_MS / 60_000;
      problems.push(
        `${tooNew.length} event(s) have a ts more than ${minutes} minutes in the future (${listIndexes(tooNew)})`,
      );
      for (const index of tooNew) {
        issues.push({
          path: [index, "ts"],
          message: `ts is more than ${minutes} minutes ahead of the server clock`,
        });
      }
    }
    if (tooOld.length > 0) {
      const since = new Date(oldest).toISOString();
      problems.push(
        `${tooOld.length} event(s) have a ts older than the ${RETENTION_DAYS}-day retention window, which ClickHouse would delete at once (oldest accepted ${since}) (${listIndexes(tooOld)})`,
      );
      for (const index of tooOld) {
        issues.push({
          path: [index, "ts"],
          message: `ts is older than the ${RETENTION_DAYS}-day retention window (oldest accepted ${since})`,
        });
      }
    }
    return {
      ok: false,
      status: 400,
      body: { error: problems.join("; "), issues: issues.slice(0, MAX_REPORTED_ISSUES) },
    };
  }

  return { ok: true, events: parsed.data };
}
