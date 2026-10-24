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
 * 100,000-id window, 360,000 more events) and checks that the cost per event stays flat. It takes
 * about a second now.
 *
 * Why the check is not "max / min < 4" any more: on a shared CI runner one chunk can be slow for
 * reasons that have nothing to do with the code (a GC pause, a noisy neighbour), and the maximum is
 * exactly that chunk. It failed once with 4.6 on GitHub. So the test throws away two warm-up
 * chunks, uses small chunks (10,000 events), and compares the 75th percentile with the fastest chunk.
 * Measured locally, in microseconds per event, ratio p75 / min:
 *   - this implementation: p75 about 1.5, min about 1.0 -> ratio 1.6 to 1.9 (max / min up to 3.4);
 *   - the first Map version (keys().next() + delete): p75 about 230, min about 12 -> ratio 20 to 21.
 * The limit is 8: about 4x above the good code and about 2.5x below the 24x sawtooth. A noisy
 * neighbour would have to slow a quarter of all chunks to fail it.
 */
describe("RecentIds with a full window", () => {
  it("QA-M1-07: the cost per event stays flat while old ids are evicted", () => {
    const WINDOW = 100_000;
    const ids = new RecentIds(3_600_000, WINDOW, () => 0);
    for (let i = 0; i < WINDOW; i++) ids.add(randomUUID());

    const chunk = 10_000;
    const chunks = 36;
    const WARM_UP = 2; // JIT compilation and a cold cache make the first chunks slower
    const perEventUs: number[] = [];
    let start = performance.now();
    for (let i = 1; i <= chunks * chunk; i++) {
      const id = randomUUID();
      ids.has(id);
      ids.add(id);
      if (i % chunk === 0) {
        perEventUs.push(((performance.now() - start) * 1000) / chunk);
        start = performance.now();
      }
    }

    const sorted = perEventUs.slice(WARM_UP).sort((a, b) => a - b);
    const quantile = (q: number) => sorted[Math.floor(q * sorted.length)] as number;
    const fastest = sorted[0] as number;
    // Flat: p75 stays within a small factor of the fastest chunk. The Map version swings by 20x.
    expect(quantile(0.75) / fastest).toBeLessThan(8);
    // And it is fast in absolute terms: the typical (median) event costs well under 100 microseconds.
    expect(quantile(0.5)).toBeLessThan(100);
  }, 120_000);
});
