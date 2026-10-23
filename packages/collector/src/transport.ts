import {
  type FleetEvent,
  INGEST_PATH,
  IngestAcceptedResponse,
  IngestErrorResponse,
} from "@fleetscope/schema";
import type { Logger } from "pino";

/** How one `send` ended. A transport never throws for these; it reports them. */
export type SendResult =
  /** The API took the batch (HTTP 2xx). */
  | { status: "accepted"; accepted: number; duplicates: number }
  /** The API refused the batch for good (400, 413, other 4xx). Retrying would not help. */
  | { status: "rejected"; httpStatus: number; error: string; issues?: unknown[] }
  /** We gave up: retries ran out, or the caller aborted. */
  | { status: "failed"; error: string };

export interface SendOptions {
  /** Abort pending retries (used when the collector is closing under a deadline). */
  signal?: AbortSignal;
}

/** Ships one batch of events (1 to 1000) to the API. In-order delivery is the queue's job. */
export interface Transport {
  send(events: readonly FleetEvent[], options?: SendOptions): Promise<SendResult>;
}

export interface HttpTransportOptions {
  /** Base URL of the API, e.g. `http://localhost:4000`. */
  apiUrl: string;
  logger: Logger;
  /** Total tries per batch, first one included. Default 8. */
  maxAttempts?: number;
  /** First retry waits about this long, doubling each time (with jitter). Default 250. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 10 000. */
  maxDelayMs?: number;
  /** Longest we will honour a `Retry-After` for. Default 30 000. */
  maxRetryAfterMs?: number;
  /** Per-request timeout. Default 10 000. */
  requestTimeoutMs?: number;
  /** Test hooks. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

/** Parses `Retry-After`: delta-seconds or an HTTP date. Returns milliseconds, or null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * POSTs batches to `POST {apiUrl}/v1/events` and applies the retry contract:
 *  - 2xx: done
 *  - 400, 413 and other 4xx: never retried (the batch is wrong, retrying cannot fix it)
 *  - 503 (and 429/408): retried, waiting for `Retry-After` when the API sends it
 *  - other 5xx and network errors: retried with jittered exponential backoff
 * Retries resend the same events with the same `event_id`s, so the API can drop duplicates.
 */
export function createHttpTransport(options: HttpTransportOptions): Transport {
  const {
    apiUrl,
    logger,
    maxAttempts = 8,
    baseDelayMs = 250,
    maxDelayMs = 10_000,
    maxRetryAfterMs = 30_000,
    requestTimeoutMs = 10_000,
    fetch: doFetch = fetch,
    sleep = abortableSleep,
    random = Math.random,
  } = options;
  const url = new URL(INGEST_PATH, apiUrl).toString();

  /** Exponential backoff with "equal jitter": half fixed, half random. */
  function backoff(attempt: number): number {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  }

  return {
    async send(events, { signal } = {}) {
      const body = JSON.stringify(events);
      let lastError = "no attempt made";

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) return { status: "failed", error: `aborted (${lastError})` };

        let retryAfterMs: number | null = null;
        try {
          const timeout = AbortSignal.timeout(requestTimeoutMs);
          const response = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });

          if (response.ok) {
            const parsed = IngestAcceptedResponse.safeParse(
              await response.json().catch(() => null),
            );
            return parsed.success
              ? { status: "accepted", ...parsed.data }
              : { status: "accepted", accepted: events.length, duplicates: 0 };
          }

          const text = await response.text().catch(() => "");
          if (response.status >= 500 || RETRYABLE_STATUSES.has(response.status)) {
            lastError = `HTTP ${response.status}`;
            retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          } else {
            const parsed = IngestErrorResponse.safeParse(safeJson(text));
            return {
              status: "rejected",
              httpStatus: response.status,
              error: parsed.success
                ? parsed.data.error
                : text.slice(0, 500) || `HTTP ${response.status}`,
              issues: parsed.success ? parsed.data.issues : undefined,
            };
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }

        if (attempt === maxAttempts) break;
        const delay =
          retryAfterMs === null ? backoff(attempt) : Math.min(retryAfterMs, maxRetryAfterMs);
        logger.debug({ attempt, delay, error: lastError }, "ingest send failed, retrying");
        await sleep(delay, signal);
      }
      return { status: "failed", error: `${lastError} (after ${maxAttempts} attempts)` };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
