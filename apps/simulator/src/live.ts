import type { FleetEvent } from "@fleetscope/schema";
import { batchEvents, PostError } from "./post";

/**
 * The sending side of `sim live`: sessions are generated up front with timestamps in the future,
 * and each event is posted when its time comes. Kept apart from the CLI so it can be tested.
 */
export class LiveStream {
  private pending: FleetEvent[] = [];
  sent = 0;
  dropped = 0;

  /** `post` sends one batch and throws a PostError on failure (see postBatch). */
  constructor(
    private readonly post: (batch: FleetEvent[]) => Promise<void>,
    private readonly log: (text: string) => void = () => {},
  ) {}

  add(events: FleetEvent[]): void {
    this.pending.push(...events);
  }

  get inFlight(): number {
    return new Set(this.pending.filter((e) => e.type === "session.ended").map((e) => e.session_id))
      .size;
  }

  /** Sends the events whose time has come. */
  async flushDue(now: number): Promise<void> {
    const due = this.pending.filter((e) => e.ts <= now);
    if (due.length === 0) return;
    this.pending = this.pending.filter((e) => e.ts > now);
    await this.send(due);
  }

  /**
   * Ctrl+C: every session that has not ended yet ends NOW, as interrupted (the same status the real
   * runner uses). Its remaining events, all in the future, are dropped; nothing is sent with a
   * timestamp after `now` (the API refuses more than 5 minutes ahead, and a refused batch would leave
   * the session `running` for good). Then everything is sent, retrying batches that failed.
   */
  async stop(now: number): Promise<void> {
    const open = new Map<string, FleetEvent>();
    for (const e of this.pending) if (e.type === "session.ended") open.set(e.session_id, e);
    const interrupted: FleetEvent[] = [];
    for (const ended of open.values()) {
      const started = this.pending.find(
        (e) => e.session_id === ended.session_id && e.type === "session.started",
      );
      // Its session.started was already sent when it was due; take its time from the ended event.
      const durationMs = ended.type === "session.ended" ? ended.duration_ms : 0;
      const startTs = started?.ts ?? ended.ts - durationMs;
      interrupted.push({
        ...ended,
        ts: now,
        status: "failed",
        reason: "interrupted",
        duration_ms: Math.max(0, now - startTs),
      } as FleetEvent);
    }
    const keep = this.pending.filter((e) => e.ts <= now && e.type !== "session.ended");
    this.pending = [];
    await this.send([...keep, ...interrupted], 3);
  }

  /** Posts in batches. A batch that failed for a reason that may pass (network, 5xx) goes back to the queue. */
  private async send(events: FleetEvent[], rounds = 1): Promise<void> {
    let todo = events.sort((a, b) => a.ts - b.ts);
    for (let round = 0; round < rounds && todo.length > 0; round++) {
      const failed: FleetEvent[] = [];
      for (const batch of batchEvents(todo)) {
        try {
          await this.post(batch);
          this.sent += batch.length;
        } catch (error) {
          const status = error instanceof PostError ? error.status : null;
          const retryable = status === null || status >= 500;
          this.log(`sim live: ${String(error)}${retryable ? " (will retry)" : " (dropped)"}`);
          if (retryable) failed.push(...batch);
          else this.dropped += batch.length;
        }
      }
      todo = failed;
    }
    // Not stopping: keep what failed for the next tick. Stopping: nothing more can be done.
    if (todo.length > 0) {
      if (rounds > 1) this.dropped += todo.length;
      else this.pending.push(...todo);
    }
  }
}
