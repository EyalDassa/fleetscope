import type { FleetEvent } from "@fleetscope/schema";
import type { Logger } from "pino";
import type { Transport } from "./transport";

export interface QueueOptions {
  transport: Transport;
  logger: Logger;
  /** Send as soon as this many events are waiting. Default 500. */
  flushSize?: number;
  /** Otherwise send whatever is waiting this often. Default 1000 ms. */
  flushIntervalMs?: number;
  /** Largest request body, in events. Default 1000 (the API limit). */
  maxBatchSize?: number;
  /**
   * Memory bound when the API is unreachable for a long time. Past this, the cheap high-volume
   * events (samples, network requests) are dropped and counted; session and action events are
   * still kept. Default 100 000.
   */
  maxBuffered?: number;
}

export interface QueueStats {
  /** Events handed to `push`. */
  pushed: number;
  /** Events the API accepted. */
  sent: number;
  /** Events the API recognised as retries of events it already had. */
  duplicates: number;
  /** Events that will never arrive (rejected by the API, retries exhausted, buffer full, closed). */
  dropped: number;
  /** Events waiting in memory, including a batch currently being sent. */
  pending: number;
}

const DROPPABLE: ReadonlySet<FleetEvent["type"]> = new Set([
  "resource.sample",
  "network.request",
  "screenshot",
]);

/**
 * One in-order queue per collector process. `push` is synchronous and never touches the network,
 * so page actions are never slowed down by it. A single drain loop sends batches one at a time,
 * which keeps events in the order they were produced (`session.started` before `session.ended`).
 */
export class EventQueue {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly flushSize: number;
  private readonly maxBatchSize: number;
  private readonly maxBuffered: number;
  private readonly timer: NodeJS.Timeout;

  private buffer: FleetEvent[] = [];
  private inFlight = 0;
  private draining: Promise<void> | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly counters = { pushed: 0, sent: 0, duplicates: 0, dropped: 0 };

  constructor(options: QueueOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
    this.flushSize = options.flushSize ?? 500;
    this.maxBatchSize = options.maxBatchSize ?? 1000;
    this.maxBuffered = options.maxBuffered ?? 100_000;
    this.timer = setInterval(() => void this.kick(), options.flushIntervalMs ?? 1000);
    this.timer.unref();
  }

  push(event: FleetEvent): void {
    this.counters.pushed++;
    if (this.closed) {
      this.counters.dropped++;
      return;
    }
    if (this.buffer.length >= this.maxBuffered && DROPPABLE.has(event.type)) {
      this.counters.dropped++;
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.flushSize) void this.kick();
  }

  stats(): QueueStats {
    return { ...this.counters, pending: this.buffer.length + this.inFlight };
  }

  /** Resolves when everything pushed so far has been sent or given up on. */
  async flush(): Promise<void> {
    while ((this.buffer.length > 0 || this.draining) && !this.abort.signal.aborted) {
      await this.kick();
    }
  }

  /**
   * Stops the timer, drains what is left, and gives up after `timeoutMs`: pending retries are
   * aborted and whatever could not be sent is counted as dropped. Safe to call twice.
   */
  async close(timeoutMs = 10_000): Promise<void> {
    clearInterval(this.timer);
    let timedOut = false;
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          timedOut = true;
          this.abort.abort();
          resolve();
        }, timeoutMs);
      }),
    ]);
    clearTimeout(deadline);
    this.closed = true;
    if (timedOut) {
      const lost = this.buffer.length + this.inFlight;
      this.counters.dropped += this.buffer.length;
      this.buffer = [];
      this.logger.warn({ lost, timeoutMs }, "collector closed before all events were sent");
    }
  }

  /** Starts the drain loop if it is not running. Returns the loop's promise. */
  private kick(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.buffer.length === 0) return Promise.resolve();
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0 && !this.abort.signal.aborted) {
      const batch = this.buffer.splice(0, this.maxBatchSize);
      this.inFlight = batch.length;
      try {
        const result = await this.transport.send(batch, { signal: this.abort.signal });
        if (result.status === "accepted") {
          this.counters.sent += result.accepted;
          this.counters.duplicates += result.duplicates;
        } else {
          this.counters.dropped += batch.length;
          this.logger.error(
            { ...result, dropped: batch.length, sessions: sessionIds(batch) },
            "events dropped, the API did not take them",
          );
        }
      } catch (error) {
        // A transport should report, not throw; if it does, treat it like a failed send.
        this.counters.dropped += batch.length;
        this.logger.error({ err: error, dropped: batch.length }, "transport threw, events dropped");
      } finally {
        this.inFlight = 0;
      }
    }
  }
}

function sessionIds(batch: readonly FleetEvent[]): string[] {
  return [...new Set(batch.map((event) => event.session_id))].slice(0, 10);
}
