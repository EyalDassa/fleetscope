import { randomUUID } from "node:crypto";
import { type DedupTokens, dedupTokensFor } from "@fleetscope/db";
import type { FleetEvent, SessionEndedEvent } from "@fleetscope/schema";
import { RecentIds } from "./recent-ids";

/**
 * The ingest buffer (PLAN.md section 5, docs/adr/0002-ingest-dedupe.md).
 *
 * The HTTP route validates a batch and hands it to `offer()`, which answers at once. A timer
 * writes what has piled up to ClickHouse in big batches, because ClickHouse likes a few large
 * INSERTs and hates many small ones.
 *
 *   offer() --> pending ----flush every 1 s or at 5,000 events----> write() --> ClickHouse
 *                  ^                                                   |
 *                  |            session.ended without a start          |
 *                  +------------- held for 60 s, offered again <-------+
 *
 * Rules that make it safe:
 *  - One flush at a time, in arrival order.
 *  - A failed flush is retried with the SAME events and the SAME dedup tokens, so ClickHouse skips
 *    the tables it already wrote. New events keep arriving meanwhile, up to `capacity`; beyond
 *    that `offer()` says "full" and the route answers 503, so memory stays bounded.
 *  - Event ids seen in the last minutes are dropped (client retries): see RecentIds.
 */

/** Writes one flush to ClickHouse. The real one is `insertEvents`; tests pass a fake. */
export type WriteBatch = (
  events: FleetEvent[],
  dedupTokens: DedupTokens,
) => Promise<{ orphans: readonly SessionEndedEvent[] }>;

export interface BufferLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface IngestBufferOptions {
  /** Flush at least this often. */
  flushIntervalMs: number;
  /** Flush at once when this many events are waiting; also the most one flush will take. */
  maxBatchSize: number;
  /** Most events kept in memory (waiting, being written, or held as orphans). */
  capacity: number;
  /** How long a session.ended without a start is kept and retried before it is dropped. */
  orphanGraceMs: number;
  /** An event id is remembered for this long... */
  duplicateWindowMs: number;
  /** ...or until this many newer ids have been seen. */
  duplicateWindowMaxIds: number;
  /** Backoff after a failed flush: base * 2^failures, at most max, with jitter. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** `close()` gives up after this long. */
  shutdownTimeoutMs: number;
}

export const DEFAULT_INGEST_OPTIONS: IngestBufferOptions = {
  flushIntervalMs: 1_000,
  maxBatchSize: 5_000,
  capacity: 50_000,
  orphanGraceMs: 60_000,
  duplicateWindowMs: 15 * 60_000,
  duplicateWindowMaxIds: 1_000_000,
  retryBaseMs: 500,
  retryMaxMs: 10_000,
  shutdownTimeoutMs: 10_000,
};

export interface IngestDeps {
  write: WriteBatch;
  log: BufferLogger;
  /** Milliseconds since the epoch. Tests pass a fake clock. */
  now?: () => number;
  /** Returns a number in [0, 1). Tests pass a fixed value to make the jitter predictable. */
  random?: () => number;
  options?: Partial<IngestBufferOptions>;
}

export type OfferResult =
  | { ok: true; accepted: number; duplicates: number }
  /** "full": the buffer is at capacity, try later. "closing": the server is shutting down. */
  | { ok: false; reason: "full" | "closing" };

/** What `/healthz` reports about the buffer. */
export interface IngestStats {
  /** Events accepted but not yet in ClickHouse (waiting, being written, or held orphans). */
  queued: number;
  capacity: number;
  /** Age of the oldest event still waiting to be written, `null` when none is. */
  oldestAgeMs: number | null;
  /** True while a flush has failed and is being retried. */
  retrying: boolean;
  lastFlushAt: number | null;
  /** The failure of the latest flush attempt; cleared by the next successful flush. */
  lastFlushError: { at: number; error: string } | null;
  /** session.ended events waiting for their session.started. */
  orphansHeld: number;
  /** session.ended events dropped after the grace period, since startup. */
  orphansDropped: number;
}

interface Queued {
  event: FleetEvent;
  acceptedAt: number;
}

/** One flush: fixed from the moment it is cut until it is written, however many attempts it takes. */
interface Flush {
  id: string;
  tokens: DedupTokens;
  /** The events taken from `pending` for this flush. */
  taken: Queued[];
  /** Ids of the held orphans that ride along in this flush. */
  heldIds: Set<string>;
  /** `taken` plus the held orphans: what is passed to `write`. */
  events: FleetEvent[];
  failures: number;
}

/**
 * Delay before retry number `failures + 1`: exponential, capped, with jitter so that many API
 * instances do not hit a recovering ClickHouse at the same moment. The result is in
 * [ceiling / 2, ceiling), where ceiling = min(max, base * 2^failures).
 */
export function backoffDelay(
  failures: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** failures);
  return ceiling / 2 + random() * (ceiling / 2);
}

/** A short description that is safe to show on /healthz (no message, which may name hosts). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? `${error.name} ${code}`
    : error.name;
}

export class IngestBuffer {
  private readonly write: WriteBatch;
  private readonly log: BufferLogger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly options: IngestBufferOptions;
  private readonly recentIds: RecentIds;

  /** Accepted, not yet part of a flush. In arrival order. */
  private pending: Queued[] = [];
  /** The flush being written (or retried) right now. */
  private current: Flush | null = null;
  /** session.ended events whose start was not found, by event id. */
  private readonly held = new Map<string, { event: SessionEndedEvent; firstSeenAt: number }>();

  private draining: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  /** Set when shutdown ran out of time: stop retrying. */
  private abandoned = false;

  private lastFlushAt: number | null = null;
  private lastFlushError: { at: number; error: string } | null = null;
  private orphansDropped = 0;

  constructor(deps: IngestDeps) {
    this.write = deps.write;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.options = { ...DEFAULT_INGEST_OPTIONS, ...deps.options };
    this.recentIds = new RecentIds(
      this.options.duplicateWindowMs,
      this.options.duplicateWindowMaxIds,
      this.now,
    );
  }

  /** Start the periodic flush. */
  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    this.timer.unref(); // the timer alone must not keep the process alive
  }

  /**
   * Queue events that the route has already validated. Returns at once; nothing waits for
   * ClickHouse. All or nothing: if the new events do not fit, none of them is queued and none of
   * their ids is remembered, so the client's retry is not mistaken for a duplicate.
   */
  offer(events: readonly FleetEvent[]): OfferResult {
    if (this.closing) return { ok: false, reason: "closing" };

    // Layer 1: leave out ids already seen, and repeats inside this very batch.
    const fresh: FleetEvent[] = [];
    const inThisBatch = new Set<string>();
    for (const event of events) {
      const key = RecentIds.key(event.event_id);
      if (inThisBatch.has(key) || this.recentIds.has(event.event_id)) continue;
      inThisBatch.add(key);
      fresh.push(event);
    }

    if (this.queued + fresh.length > this.options.capacity) {
      return { ok: false, reason: "full" };
    }

    const acceptedAt = this.now();
    for (const event of fresh) {
      this.recentIds.add(event.event_id);
      this.pending.push({ event, acceptedAt });
    }
    if (this.pending.length >= this.options.maxBatchSize) void this.flush();

    return { ok: true, accepted: fresh.length, duplicates: events.length - fresh.length };
  }

  /**
   * Write what is waiting. Safe to call at any time: if a flush is already running, this joins it.
   * Never rejects. A failing flush keeps retrying inside, until it succeeds or `close()` gives up.
   */
  flush(): Promise<void> {
    this.draining ??= this.drain()
      .catch((error) => this.log.error({ err: error }, "unexpected error while flushing"))
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  /**
   * Stop accepting events, flush what is queued, and return. Gives up after
   * `shutdownTimeoutMs` (then the events still queued are lost and logged).
   * Call it after the HTTP server has stopped taking requests.
   */
  close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  stats(): IngestStats {
    const oldest = this.current?.taken[0] ?? this.pending[0];
    return {
      queued: this.queued,
      capacity: this.options.capacity,
      oldestAgeMs: oldest ? this.now() - oldest.acceptedAt : null,
      retrying: (this.current?.failures ?? 0) > 0,
      lastFlushAt: this.lastFlushAt,
      lastFlushError: this.lastFlushError,
      orphansHeld: this.held.size,
      orphansDropped: this.orphansDropped,
    };
  }

  private get queued(): number {
    return this.pending.length + (this.current?.taken.length ?? 0) + this.held.size;
  }

  /** Flush batch after batch while a full batch is waiting; otherwise wait for the next tick. */
  private async drain(): Promise<void> {
    do {
      if (this.abandoned) return;
      // A flush that is still current failed before and is being retried: write that very batch.
      this.current ??= this.cutFlush();
      const flush = this.current;
      if (!flush) return;

      const result = await this.writeUntilStored(flush);
      if (!result) return; // abandoned during shutdown; `current` stays so the loss is counted

      this.current = null;
      this.lastFlushAt = this.now();
      this.lastFlushError = null;
      this.log.debug(
        { flushId: flush.id, events: flush.events.length, failures: flush.failures },
        "flushed to ClickHouse",
      );
      this.settleOrphans(flush, result.orphans);
    } while (this.pending.length >= this.options.maxBatchSize);
  }

  /** Take the next batch from `pending` and add the held orphans for another try. */
  private cutFlush(): Flush | null {
    const taken = this.pending.splice(0, this.options.maxBatchSize);
    const heldEvents = [...this.held.values()].map((entry) => entry.event);
    if (taken.length === 0 && heldEvents.length === 0) return null;
    const id = randomUUID();
    return {
      id,
      tokens: dedupTokensFor(id),
      taken,
      heldIds: new Set(this.held.keys()),
      events: [...taken.map((queued) => queued.event), ...heldEvents],
      failures: 0,
    };
  }

  /**
   * Layer 2: write the flush, and if that fails, wait and write the same flush again with the same
   * tokens. Returns null only when shutdown has given up.
   */
  private async writeUntilStored(
    flush: Flush,
  ): Promise<{ orphans: readonly SessionEndedEvent[] } | null> {
    for (;;) {
      try {
        return await this.write(flush.events, flush.tokens);
      } catch (error) {
        flush.failures++;
        this.lastFlushError = { at: this.now(), error: describeError(error) };
        this.log.error(
          { err: error, flushId: flush.id, events: flush.events.length, failures: flush.failures },
          "flush to ClickHouse failed, will retry the same batch",
        );
        if (this.abandoned) return null;
        await this.sleepBeforeRetry(flush.failures - 1);
        if (this.abandoned) return null;
      }
    }
  }

  private sleepBeforeRetry(failures: number): Promise<void> {
    const { retryBaseMs, retryMaxMs } = this.options;
    let delay = backoffDelay(failures, retryBaseMs, retryMaxMs, this.random);
    // During shutdown every second counts, so retry quickly.
    if (this.closing) delay = Math.min(delay, 200);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, delay);
      this.wake = done;
    });
  }

  /**
   * After a flush: held orphans whose start was found are released; orphans that are still
   * orphans are kept until the grace period is over, then dropped with a warning.
   */
  private settleOrphans(flush: Flush, orphans: readonly SessionEndedEvent[]): void {
    const now = this.now();
    const stillOrphans = new Set(orphans.map((event) => event.event_id));
    for (const id of flush.heldIds) {
      if (!stillOrphans.has(id)) this.held.delete(id); // its session.started was found: stored
    }

    const expired: SessionEndedEvent[] = [];
    for (const event of orphans) {
      const entry = this.held.get(event.event_id);
      if (!entry) {
        this.held.set(event.event_id, { event, firstSeenAt: now });
      } else if (now - entry.firstSeenAt >= this.options.orphanGraceMs) {
        this.held.delete(event.event_id);
        expired.push(event);
      }
    }

    if (expired.length > 0) {
      this.orphansDropped += expired.length;
      this.log.warn(
        {
          count: expired.length,
          sessionIds: [...new Set(expired.map((event) => event.session_id))].slice(0, 20),
          graceMs: this.options.orphanGraceMs,
        },
        "dropped session.ended events: no session.started arrived within the grace period",
      );
    }
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.wake?.(); // do not sleep through a backoff while shutting down

    const drained = (async () => {
      do {
        await this.flush();
      } while ((this.pending.length > 0 || this.current) && !this.abandoned);
    })();

    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      deadline = setTimeout(() => resolve("timeout"), this.options.shutdownTimeoutMs);
    });
    const outcome = await Promise.race([drained.then(() => "drained" as const), timedOut]);
    clearTimeout(deadline);

    if (outcome === "timeout") {
      this.abandoned = true;
      this.wake?.();
    }

    const lost = this.queued;
    if (lost > 0) {
      this.log.error(
        {
          lost,
          orphans: this.held.size,
          sessionIds: [...new Set([...this.held.values()].map((e) => e.event.session_id))].slice(
            0,
            20,
          ),
          timedOut: outcome === "timeout",
        },
        "shutting down with events that were not written to ClickHouse",
      );
    }
  }
}
