import { checkoutForm } from "./checkout-form";
import { heavyPageCrawl } from "./heavy-page-crawl";
import { loginAndSearch } from "./login-and-search";
import type { Scenario } from "./types";

export type { Scenario, ScenarioContext } from "./types";

/** M1 scenarios. `long-idle-session` and `memory-hog` come with Insights (M3/M4). */
export const SCENARIOS = {
  "login-and-search": loginAndSearch,
  "checkout-form": checkoutForm,
  "heavy-page-crawl": heavyPageCrawl,
} as const satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

/**
 * A browser feature a scenario cannot run without. `ENGINE_SPECS[engine].lacks` lists what an
 * engine does not have; `--routing by-scenario` uses the two to keep a scenario off an engine that
 * cannot run it (docs/adr/0005). Add a name here only when an engine is verified to lack it.
 */
export type Capability = "webWorker";

/** What each scenario needs. `heavy-page-crawl` opens `/js-heavy`, whose probe runs a web worker. */
export const SCENARIO_NEEDS: Record<ScenarioName, readonly Capability[]> = {
  "login-and-search": [],
  "checkout-form": [],
  "heavy-page-crawl": ["webWorker"],
};

/**
 * Scenario for session number `index`. A fixed name always wins; `mix` goes round-robin, starting
 * at a point chosen by the run seed so different seeds give different orders.
 */
export function scenarioFor(
  choice: ScenarioName | "mix",
  index: number,
  seed: number,
): ScenarioName {
  if (choice !== "mix") return choice;
  return SCENARIO_NAMES[(seed + index) % SCENARIO_NAMES.length] as ScenarioName;
}
