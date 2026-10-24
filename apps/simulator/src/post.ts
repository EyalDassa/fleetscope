import { EventBatch, type FleetEvent, INGEST_PATH, MAX_BATCH_SIZE } from "@fleetscope/schema";

/**
 * Groups sessions into batches of at most `max` events without splitting a session (so a
 * `session.started` and its `session.ended` travel together and the API never has to hold an orphan).
 * A single session bigger than `max` is split anyway, in order.
 */
export function batchSessions(
  sessions: FleetEvent[][],
  max: number = MAX_BATCH_SIZE,
): FleetEvent[][] {
  const batches: FleetEvent[][] = [];
  let current: FleetEvent[] = [];
  for (const events of sessions) {
    if (current.length > 0 && current.length + events.length > max) {
      batches.push(current);
      current = [];
    }
    if (events.length > max) {
      for (let i = 0; i < events.length; i += max) batches.push(events.slice(i, i + max));
    } else {
      current.push(...events);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Splits a flat list of events into batches of at most `max`. */
export function batchEvents(events: FleetEvent[], max: number = MAX_BATCH_SIZE): FleetEvent[][] {
  const batches: FleetEvent[][] = [];
  for (let i = 0; i < events.length; i += max) batches.push(events.slice(i, i + max));
  return batches;
}

export class PostError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PostError";
  }
}

export interface PostOptions {
  apiUrl: string;
  /** Retries after a 503 (buffer full) or a network error. */
  retries?: number;
  /** Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs one batch. Checks it against the schema first (a bad simulated event is a bug here and
 * should be seen here, not as a 400 from the API). 503 waits for `Retry-After` and tries again; any
 * other non-2xx answer is an error with the API's message.
 */
export async function postBatch(events: FleetEvent[], options: PostOptions): Promise<void> {
  const checked = EventBatch.safeParse(events);
  if (!checked.success) {
    throw new PostError(`simulator produced an invalid batch: ${checked.error.message}`, null);
  }
  const url = `${options.apiUrl.replace(/\/+$/, "")}${INGEST_PATH}`;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 8;
  for (let attempt = 0; ; attempt++) {
    let status: number | null = null;
    let detail = "";
    let wait = 1000 * 2 ** Math.min(attempt, 4);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(events),
      });
      status = response.status;
      if (response.ok) return;
      detail = (await response.text()).slice(0, 500);
      const retryAfter = Number(response.headers.get("retry-after"));
      if (status === 503 && retryAfter > 0) wait = retryAfter * 1000;
      if (status !== 503) throw new PostError(`API answered ${status}: ${detail}`, status);
    } catch (error) {
      if (error instanceof PostError) throw error;
      detail = String(error);
    }
    if (attempt >= retries) {
      throw new PostError(
        `giving up after ${attempt + 1} tries: ${status ?? ""} ${detail}`,
        status,
      );
    }
    await sleep(wait);
  }
}
