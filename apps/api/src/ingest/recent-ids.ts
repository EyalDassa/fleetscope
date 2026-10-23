/**
 * Dedupe layer 1 (docs/adr/0002-ingest-dedupe.md): a window of recently accepted event ids.
 *
 * A collector that times out and sends the same batch again produces events the buffer has
 * already accepted. Those are recognised here by `event_id` and dropped.
 *
 * The window is bounded twice, so memory cannot grow without limit:
 *  - by age: ids older than `maxAgeMs` are forgotten (a retry that late is not a retry any more),
 *  - by count: when `maxIds` is exceeded, the oldest ids go first.
 *
 * Ids are compared lower-cased, because ClickHouse stores them as a UUID and reads upper and
 * lower case as the same value.
 */
export class RecentIds {
  /** id -> when it was added. A Map iterates in insertion order, which here is also age order. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxAgeMs: number,
    private readonly maxIds: number,
    private readonly now: () => number,
  ) {}

  /** The form in which ids are stored and compared. */
  static key(eventId: string): string {
    return eventId.toLowerCase();
  }

  has(eventId: string): boolean {
    this.expire();
    return this.seen.has(RecentIds.key(eventId));
  }

  add(eventId: string): void {
    const key = RecentIds.key(eventId);
    if (this.seen.has(key)) return; // keep the original time: the window starts at first sight
    this.seen.set(key, this.now());
    while (this.seen.size > this.maxIds) this.dropOldest();
  }

  get size(): number {
    return this.seen.size;
  }

  private expire(): void {
    const oldestAllowed = this.now() - this.maxAgeMs;
    for (const [key, addedAt] of this.seen) {
      if (addedAt >= oldestAllowed) return; // everything after this one is newer
      this.seen.delete(key);
    }
  }

  private dropOldest(): void {
    const oldest = this.seen.keys().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }
}
