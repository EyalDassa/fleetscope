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
 *
 * Shape: a `Set` answers "have I seen this?", and two arrays remember the order the ids came in.
 * Forgetting the oldest id moves a `head` index forward, which costs the same no matter how many
 * ids are stored. (An earlier version kept everything in one `Map` and evicted with
 * `map.keys().next()`: on V8 a Map that is emptied from the front leaves holes the next call has to
 * skip, so the cost per event swung between 17 and 400 microseconds, QA-M1-07.)
 */
export class RecentIds {
  private readonly members = new Set<string>();
  /** The ids in the order they were added; slots before `head` have been forgotten (set to ""). */
  private order: string[] = [];
  /** When each id was added, same positions as `order`. */
  private addedAt: number[] = [];
  /** Position of the oldest id that is still remembered. */
  private head = 0;

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
    return this.members.has(RecentIds.key(eventId));
  }

  add(eventId: string): void {
    const key = RecentIds.key(eventId);
    if (this.members.has(key)) return; // keep the original time: the window starts at first sight
    this.members.add(key);
    this.order.push(key);
    this.addedAt.push(this.now());
    while (this.members.size > this.maxIds) this.forgetOldest();
  }

  get size(): number {
    return this.members.size;
  }

  /** Forget the ids that are older than the window. Each id is looked at once in its lifetime. */
  private expire(): void {
    const oldestAllowed = this.now() - this.maxAgeMs;
    while (this.head < this.order.length && (this.addedAt[this.head] ?? 0) < oldestAllowed) {
      this.forgetOldest();
    }
  }

  private forgetOldest(): void {
    const key = this.order[this.head];
    if (key === undefined) return;
    this.members.delete(key);
    this.order[this.head] = ""; // let the string go now, not at the next compaction
    this.head++;
    // Drop the forgotten prefix once it is at least half of the arrays, so the arrays stay
    // under twice the number of remembered ids and the copying is paid for by the forgetting.
    if (this.head >= 1024 && this.head * 2 >= this.order.length) {
      this.order = this.order.slice(this.head);
      this.addedAt = this.addedAt.slice(this.head);
      this.head = 0;
    }
  }
}
