import type { Engine } from "@fleetscope/schema";
import { SCENARIO_NAMES, type ScenarioName } from "./scenarios";

export interface Assignment {
  engine: Engine;
  scenario: ScenarioName;
}

/**
 * Which engine and scenario session number `index` gets. Fair by construction: the pairs
 * (scenario, engine) go round in a fixed order, started at a point chosen by the seed, so with N
 * engines and S scenarios every block of S*N sessions runs every scenario on every engine exactly
 * once. (The old `index % engines` and `index % scenarios` moved in lock-step: with 3 engines and 3
 * scenarios, chromium only ever ran the same scenario.)
 *
 * A fixed `--scenario` just cycles the engines. The pairs are scenario-major, so neighbouring
 * sessions (which run side by side with `--concurrency`) are the same scenario on different engines.
 */
export function assignSession(
  engines: readonly Engine[],
  choice: ScenarioName | "mix",
  seed: number,
  index: number,
): Assignment {
  const scenarios: readonly ScenarioName[] = choice === "mix" ? SCENARIO_NAMES : [choice];
  const pairs = scenarios.length * engines.length;
  const at = (seed + index) % pairs;
  return {
    scenario: scenarios[Math.floor(at / engines.length)] as ScenarioName,
    engine: engines[at % engines.length] as Engine,
  };
}
