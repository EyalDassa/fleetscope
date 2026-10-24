import { describe, expect, it } from "vitest";
import { type Assignment, assignSession, routeSession, unmetNeeds } from "./assign";
import { ENGINE_SPECS } from "./engines";
import { SCENARIO_NAMES, SCENARIO_NEEDS } from "./scenarios";

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

describe("routeSession", () => {
  const heavyOnLightpanda: Assignment = { engine: "lightpanda", scenario: "heavy-page-crawl" };

  it("does nothing under the fixed policy", () => {
    expect(routeSession(heavyOnLightpanda, ENGINES, "fixed")).toEqual({
      ...heavyOnLightpanda,
      routedFrom: null,
    });
  });

  it("moves lightpanda + heavy-page-crawl to chrome-headless-shell", () => {
    expect(routeSession(heavyOnLightpanda, ENGINES, "by-scenario")).toEqual({
      engine: "chrome-headless-shell",
      scenario: "heavy-page-crawl",
      routedFrom: "lightpanda",
    });
  });

  it("moves it to chromium when chrome-headless-shell is not part of the run", () => {
    expect(routeSession(heavyOnLightpanda, ["lightpanda", "chromium"], "by-scenario")).toEqual({
      engine: "chromium",
      scenario: "heavy-page-crawl",
      routedFrom: "lightpanda",
    });
  });

  it("keeps the lightness order whatever order --engines had", () => {
    const reversed = ["chromium", "chrome-headless-shell", "lightpanda"] as const;
    expect(routeSession(heavyOnLightpanda, reversed, "by-scenario").engine).toBe(
      "chrome-headless-shell",
    );
  });

  it("keeps the assignment when no engine of the run can run the scenario", () => {
    expect(routeSession(heavyOnLightpanda, ["lightpanda"], "by-scenario")).toEqual({
      ...heavyOnLightpanda,
      routedFrom: null,
    });
    expect(unmetNeeds("lightpanda", "heavy-page-crawl")).toEqual(["webWorker"]);
  });

  it("leaves scenarios without needs, and engines that can run the scenario, alone", () => {
    for (const scenario of SCENARIO_NAMES) {
      for (const engine of ENGINES) {
        const assignment = { engine, scenario };
        const needsMet = SCENARIO_NEEDS[scenario].every(
          (need) => !ENGINE_SPECS[engine].lacks.includes(need),
        );
        if (needsMet) {
          expect(routeSession(assignment, ENGINES, "by-scenario")).toEqual({
            ...assignment,
            routedFrom: null,
          });
        }
      }
    }
    expect(
      routeSession({ engine: "lightpanda", scenario: "checkout-form" }, ENGINES, "by-scenario")
        .routedFrom,
    ).toBeNull();
  });

  it("single-engine runs: a capable engine is untouched, an incapable one stays", () => {
    const heavy = (engine: Assignment["engine"]) => ({
      engine,
      scenario: "heavy-page-crawl" as const,
    });
    expect(routeSession(heavy("chromium"), ["chromium"], "by-scenario").routedFrom).toBeNull();
    expect(routeSession(heavy("lightpanda"), ["lightpanda"], "by-scenario").engine).toBe(
      "lightpanda",
    );
  });

  it("over a whole mixed run: no lightpanda heavy-page-crawl is left, everything else keeps its engine", () => {
    for (let index = 0; index < 18; index++) {
      const assigned = assignSession(ENGINES, "mix", 5, index);
      const routed = routeSession(assigned, ENGINES, "by-scenario");
      expect(routed.engine === "lightpanda" && routed.scenario === "heavy-page-crawl").toBe(false);
      expect(routed.routedFrom !== null).toBe(
        assigned.engine === "lightpanda" && assigned.scenario === "heavy-page-crawl",
      );
    }
  });
});
