import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RecentIds } from "./recent-ids";

/**
 * QA, M1 (QA-M1-07, VERIFIED in the re-test). The first version evicted the oldest id with
 * `map.keys().next()` + `delete` on a V8 Map, which leaves holes at the front that every later call
 * has to skip: with a 100,000-id window the cost per event swung between 17 and 325 microseconds,
 * over and over, and a 1,000-event request could block the event loop for 0.3 s once the window was
 * full (about 110 events/s sustained over 15 minutes). The window is now a Set plus an order array
 * with a moving head. This test keeps it that way: it runs the old 30-second scenario (a full
 * 100,000-id window, 300,000 more events) and checks that the cost per event stays flat. It takes
 * about a second now.
 */
describe("RecentIds with a full window", () => {
  it("QA-M1-07: the cost per event stays flat while old ids are evicted", () => {
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
