import { describe, expect, it } from "vitest";
import {
  ChaosStore,
  chaosPatchSchema,
  decide,
  intParam,
  MAX_LATENCY_MS,
  NO_CHAOS,
  parseSeed,
  resolveSettings,
  seededRandom,
} from "./chaos";

/** A random source that returns the given draws in order. */
function scripted(...draws: number[]): () => number {
  let i = 0;
  return () => {
    const value = draws[i];
    if (value === undefined) throw new Error("more draws than scripted");
    i += 1;
    return value;
  };
}

describe("seededRandom", () => {
  it("gives the same sequence for the same seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(Array.from({ length: 10 }, a)).toEqual(Array.from({ length: 10 }, b));
  });

  it("gives different sequences for different seeds", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it("does not give streaks for small consecutive seeds", () => {
    // The first draw decides the error check, so seeds 1..40 must not all land on one side.
    const first = Array.from({ length: 40 }, (_, i) => seededRandom(i + 1)());
    const below = first.filter((d) => d < 0.5).length;
    expect(below).toBeGreaterThan(12);
    expect(below).toBeLessThan(28);
    // ...and no long run on either side.
    let run = 1;
    let longest = 1;
    for (let i = 1; i < first.length; i++) {
      run = (first[i] ?? 0) < 0.5 === (first[i - 1] ?? 0) < 0.5 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThan(9);
  });

  it("stays in [0, 1) and is spread out", () => {
    const random = seededRandom(7);
    const draws = Array.from({ length: 2000 }, random);
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
    const below = draws.filter((d) => d < 0.5).length;
    expect(below).toBeGreaterThan(900);
    expect(below).toBeLessThan(1100);
  });
});

describe("parseSeed", () => {
  it("reads whole numbers", () => {
    expect(parseSeed("5")).toBe(5);
    expect(parseSeed("-3")).toBe(-3);
    expect(parseSeed(["9", "10"])).toBe(9);
  });

  it("ignores everything else", () => {
    for (const bad of [undefined, "", "abc", "1.5", "1e3", "99999999999999999999"]) {
      expect(parseSeed(bad)).toBeUndefined();
    }
  });
});

describe("intParam", () => {
  const opts = { min: 0, max: 100, fallback: 50 };
  it("uses the fallback when missing or not a number", () => {
    expect(intParam(undefined, opts)).toBe(50);
    expect(intParam("lots", opts)).toBe(50);
    expect(intParam("", opts)).toBe(50);
  });
  it("clamps to the range and drops decimals", () => {
    expect(intParam("999", opts)).toBe(100);
    expect(intParam("-5", opts)).toBe(0);
    expect(intParam("12.9", opts)).toBe(12);
  });
});

describe("resolveSettings", () => {
  it("is all zeros with no query, no global settings and no route defaults", () => {
    expect(resolveSettings({}, NO_CHAOS)).toEqual(NO_CHAOS);
  });

  it("uses the global settings when the query is silent", () => {
    const global = { latencyMs: 500, flakyRate: 0.1, botwallRate: 0.2, errorRate: 0.3 };
    expect(resolveSettings({}, global)).toEqual(global);
  });

  it("lets query parameters override the global settings, including with 0", () => {
    const global = { latencyMs: 500, flakyRate: 0.1, botwallRate: 0.2, errorRate: 0.3 };
    const settings = resolveSettings({ latencyMs: "0", errorRate: "0.9", flakyRate: "0" }, global);
    expect(settings).toEqual({ latencyMs: 0, flakyRate: 0, botwallRate: 0.2, errorRate: 0.9 });
  });

  it("caps latency at MAX_LATENCY_MS and rates at 1, and floors them at 0", () => {
    const settings = resolveSettings(
      { latencyMs: "999999", errorRate: "7", botwallRate: "-1" },
      NO_CHAOS,
    );
    expect(settings.latencyMs).toBe(MAX_LATENCY_MS);
    expect(settings.errorRate).toBe(1);
    expect(settings.botwallRate).toBe(0);
  });

  it("ignores query values that are not numbers", () => {
    const global = { ...NO_CHAOS, errorRate: 0.4 };
    expect(resolveSettings({ errorRate: "often", latencyMs: "NaN" }, global)).toEqual(global);
  });

  it("uses the route's alias and defaults", () => {
    const route = { defaults: { latencyMs: 2000 }, aliases: { latencyMs: "ms" } };
    expect(resolveSettings({}, NO_CHAOS, route).latencyMs).toBe(2000);
    expect(resolveSettings({ ms: "150" }, NO_CHAOS, route).latencyMs).toBe(150);
    expect(resolveSettings({ ms: "0" }, NO_CHAOS, route).latencyMs).toBe(0);
    expect(resolveSettings({ ms: "99999" }, NO_CHAOS, route).latencyMs).toBe(MAX_LATENCY_MS);
    // The alias wins when both names are given; the long name works too.
    expect(resolveSettings({ ms: "10", latencyMs: "20" }, NO_CHAOS, route).latencyMs).toBe(10);
    expect(resolveSettings({ latencyMs: "20" }, NO_CHAOS, route).latencyMs).toBe(20);
  });

  it("prefers a non-zero global setting over the route default", () => {
    const route = { defaults: { flakyRate: 0.3 }, aliases: { flakyRate: "rate" } };
    expect(resolveSettings({}, { ...NO_CHAOS, flakyRate: 0.8 }, route).flakyRate).toBe(0.8);
    expect(resolveSettings({ rate: "0.1" }, { ...NO_CHAOS, flakyRate: 0.8 }, route).flakyRate).toBe(
      0.1,
    );
  });

  it("does not apply a route's default to the other knobs", () => {
    const route = { defaults: { flakyRate: 0.3 } };
    expect(resolveSettings({}, NO_CHAOS, route)).toEqual({ ...NO_CHAOS, flakyRate: 0.3 });
  });
});

describe("decide", () => {
  const all = { latencyMs: 0, flakyRate: 1, botwallRate: 1, errorRate: 1 };

  it("never fires at rate 0 and always fires at rate 1", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(decide(NO_CHAOS, seededRandom(seed))).toEqual({
        error: false,
        botwall: null,
        flaky: false,
      });
      const decision = decide(all, seededRandom(seed));
      expect(decision.error).toBe(true);
      expect(decision.botwall).not.toBeNull();
      expect(decision.flaky).toBe(true);
    }
  });

  it("compares each draw to its rate, in a fixed order: error, botwall, kind, flaky", () => {
    const settings = { latencyMs: 0, flakyRate: 0.5, botwallRate: 0.5, errorRate: 0.5 };
    expect(decide(settings, scripted(0.1, 0.9, 0.9, 0.9))).toEqual({
      error: true,
      botwall: null,
      flaky: false,
    });
    expect(decide(settings, scripted(0.9, 0.1, 0.9, 0.1))).toEqual({
      error: false,
      botwall: "captcha",
      flaky: true,
    });
    expect(decide(settings, scripted(0.9, 0.1, 0.1, 0.9))).toEqual({
      error: false,
      botwall: "forbidden",
      flaky: false,
    });
  });

  it("takes exactly four draws whatever the rates are", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return 0.5;
    };
    decide(NO_CHAOS, counting);
    decide(all, counting);
    expect(calls).toBe(8);
  });

  it("is deterministic for a seed and close to the rate over many seeds", () => {
    const settings = { ...NO_CHAOS, errorRate: 0.3, botwallRate: 0.5, flakyRate: 0.2 };
    expect(decide(settings, seededRandom(9))).toEqual(decide(settings, seededRandom(9)));

    const results = Array.from({ length: 1000 }, (_, seed) =>
      decide(settings, seededRandom(seed + 1)),
    );
    const share = (pick: (d: (typeof results)[number]) => boolean) =>
      results.filter(pick).length / results.length;
    expect(share((d) => d.error)).toBeGreaterThan(0.25);
    expect(share((d) => d.error)).toBeLessThan(0.35);
    expect(share((d) => d.botwall !== null)).toBeGreaterThan(0.44);
    expect(share((d) => d.botwall !== null)).toBeLessThan(0.56);
    expect(share((d) => d.flaky)).toBeGreaterThan(0.15);
    expect(share((d) => d.flaky)).toBeLessThan(0.25);
    // A bot wall is a 403 about half of the time and a CAPTCHA the other half.
    const walls = results.filter((d) => d.botwall !== null);
    const forbidden = walls.filter((d) => d.botwall === "forbidden").length / walls.length;
    expect(forbidden).toBeGreaterThan(0.4);
    expect(forbidden).toBeLessThan(0.6);
  });
});

describe("ChaosStore and chaosPatchSchema", () => {
  it("starts at zero, merges patches and resets", () => {
    const store = new ChaosStore();
    expect(store.get()).toEqual(NO_CHAOS);
    store.patch({ latencyMs: 100, errorRate: 0.5 });
    expect(store.patch({ errorRate: 0.1 })).toEqual({
      ...NO_CHAOS,
      latencyMs: 100,
      errorRate: 0.1,
    });
    expect(store.reset()).toEqual(NO_CHAOS);
  });

  it("hands out copies, so callers cannot change the settings by accident", () => {
    const store = new ChaosStore();
    store.get().errorRate = 1;
    expect(store.get().errorRate).toBe(0);
  });

  it("accepts a partial body and rejects bad ones", () => {
    expect(chaosPatchSchema.safeParse({}).success).toBe(true);
    expect(chaosPatchSchema.safeParse({ latencyMs: MAX_LATENCY_MS }).success).toBe(true);
    expect(chaosPatchSchema.safeParse({ latencyMs: MAX_LATENCY_MS + 1 }).success).toBe(false);
    expect(chaosPatchSchema.safeParse({ errorRate: 1.1 }).success).toBe(false);
    expect(chaosPatchSchema.safeParse({ flakyRate: -0.1 }).success).toBe(false);
    expect(chaosPatchSchema.safeParse({ botwallRate: "0.2" }).success).toBe(false);
    expect(chaosPatchSchema.safeParse({ nonsense: 1 }).success).toBe(false);
    expect(chaosPatchSchema.safeParse([]).success).toBe(false);
  });
});
