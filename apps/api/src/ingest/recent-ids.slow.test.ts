import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RecentIds } from "./recent-ids";

/**
 * QA, M1 (QA-M1-07). Opt-in because it takes about 25 s: QA_SLOW=1.
 *
 *   QA_SLOW=1 pnpm --filter @fleetscope/api exec vitest run src/ingest/recent-ids.slow.test.ts
 *
 * Once the dedupe window is full, every new id evicts the oldest one with
 * `seen.keys().next()` + `delete`. On a V8 Map, deleting from the front leaves holes that the next
 * `keys().next()` has to skip, so the cost per event grows until the table is rebuilt, then starts
 * again (a sawtooth). Measured with a 100,000-id window: 17 us per event, rising to 325 us, over
 * and over. A 1,000-event request then blocks the event loop for up to 0.3 s. The default window is
 * 1,000,000 ids (15 minutes), reached at about 1,100 events/s; a 100,000-id window is reached at
 * about 110 events/s. Filling the window is cheap (1.5 us per event); it is the steady state that
 * is slow.
 */
const SLOW = process.env.QA_SLOW === "1";

describe.skipIf(!SLOW)("RecentIds with a full window", () => {
  it.fails("QA-M1-07: the cost per event stays flat while old ids are evicted", () => {
    const WINDOW = 100_000;
    const ids = new RecentIds(3_600_000, WINDOW, () => 0);
    for (let i = 0; i < WINDOW; i++) ids.add(randomUUID());

    const chunk = 25_000;
    const perEventUs: number[] = [];
    let start = performance.now();
    for (let i = 1; i <= 12 * chunk; i++) {
      const id = randomUUID();
      ids.has(id);
      ids.add(id);
      if (i % chunk === 0) {
        perEventUs.push(((performance.now() - start) * 1000) / chunk);
        start = performance.now();
      }
    }
    // A flat implementation (an array queue, or two rotating Sets) stays within a few
    // microseconds of itself. The Map version swings by 10x or more.
    expect(Math.max(...perEventUs) / Math.min(...perEventUs)).toBeLessThan(4);
    expect(Math.max(...perEventUs)).toBeLessThan(100);
  }, 120_000);
});
