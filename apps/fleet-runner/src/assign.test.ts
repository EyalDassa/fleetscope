import { describe, expect, it } from "vitest";
import { assignSession } from "./assign";
import { SCENARIO_NAMES } from "./scenarios";

const ENGINES = ["chromium", "chrome-headless-shell", "lightpanda"] as const;

describe("assignSession", () => {
  it.each([0, 1, 2, 7, 12345])(
    "runs every scenario on every engine within one block of 9 sessions (seed %i)",
    (seed) => {
      const pairs = new Set<string>();
      for (let i = 0; i < 9; i++) {
        const { engine, scenario } = assignSession(ENGINES, "mix", seed, i);
        pairs.add(`${scenario}/${engine}`);
      }
      expect(pairs.size).toBe(SCENARIO_NAMES.length * ENGINES.length);
    },
  );

  it("is repeatable", () => {
    expect(assignSession(ENGINES, "mix", 3, 4)).toEqual(assignSession(ENGINES, "mix", 3, 4));
  });

  it("a fixed scenario just cycles the engines", () => {
    const got = [0, 1, 2, 3].map((i) => assignSession(ENGINES, "checkout-form", 0, i));
    expect(new Set(got.map((g) => g.scenario))).toEqual(new Set(["checkout-form"]));
    expect(got.map((g) => g.engine)).toEqual([...ENGINES, ENGINES[0]]);
  });

  it("one engine still cycles every scenario", () => {
    const scenarios = [0, 1, 2].map((i) => assignSession(["chromium"], "mix", 0, i).scenario);
    expect(new Set(scenarios).size).toBe(3);
  });
});
