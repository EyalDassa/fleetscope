import type { Engine } from "@fleetscope/schema";
import { ENGINE_SPECS } from "./engines";
import {
  SCENARIO_NAMES,
  SCENARIO_NEEDS,
  type ScenarioName,
  type SessionScenarioName,
} from "./scenarios";
import { SCENARIO_OF_SITE } from "./scenarios/public";
import type { PublicSite } from "./scenarios/public/sites";

export interface Assignment {
  engine: Engine;
  scenario: SessionScenarioName;
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

/** `fixed`: the assignment is final. `by-scenario`: a scenario is moved off an engine that lacks what it needs. */
export const ROUTING_POLICIES = ["fixed", "by-scenario"] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

export interface RoutedAssignment extends Assignment {
  /** The engine `assignSession` chose, when routing moved the session to another; else `null`. */
  routedFrom: Engine | null;
}

/** Lightest first: a routed session goes to the cheapest engine that can run it. */
export const LIGHTNESS_ORDER = ["lightpanda", "chrome-headless-shell", "chromium"] as const;

// Compile-time guard: an engine added to ENGINES but not listed above would never be a routing
// target. This line stops compiling until the new engine gets its place in the order.
type EngineMissingFromLightnessOrder = Exclude<Engine, (typeof LIGHTNESS_ORDER)[number]>;
const _everyEngineIsOrdered: [EngineMissingFromLightnessOrder] extends [never] ? true : never =
  true;
void _everyEngineIsOrdered;

/** What the scenario needs and the engine lacks. Empty: the engine can run the scenario. */
export function unmetNeeds(engine: Engine, scenario: SessionScenarioName) {
  const lacks = ENGINE_SPECS[engine].lacks;
  return SCENARIO_NEEDS[scenario].filter((need) => lacks.includes(need));
}

/**
 * Applies the routing policy to an assignment. Pure: it does not log.
 *
 * With `by-scenario`, an assignment whose engine lacks something the scenario needs moves to the
 * first engine of the run (in lightness order) that has all of it, and `routedFrom` names the engine
 * it was taken from. If no engine of the run can run the scenario the assignment stays as it is
 * (`routedFrom` null) and the session fails honestly on the engine that cannot do it; the caller
 * can tell with `unmetNeeds`. With `fixed` nothing changes.
 */
export function routeSession(
  assignment: Assignment,
  engines: readonly Engine[],
  policy: RoutingPolicy,
): RoutedAssignment {
  const unrouted = { ...assignment, routedFrom: null };
  if (policy === "fixed" || unmetNeeds(assignment.engine, assignment.scenario).length === 0) {
    return unrouted;
  }
  const capable = LIGHTNESS_ORDER.find(
    (engine) => engines.includes(engine) && unmetNeeds(engine, assignment.scenario).length === 0,
  );
  return capable === undefined
    ? unrouted
    : { engine: capable, scenario: assignment.scenario, routedFrom: assignment.engine };
}

/**
 * Which site and engine public session number `ordinal` gets (docs/adr/0007). `ordinal` counts the
 * public sessions of the whole run, so it keeps rotating from one batch to the next.
 *
 * Site and engine both move one step per session, so a few sessions already visit different sites on
 * different engines. Moving in lock-step would pin each site to one engine whenever the number of
 * sites and engines share a factor (3 sites left, 3 engines), so the engine takes an extra step each
 * time the sites have gone round once.
 */
export function assignPublic(
  engines: readonly Engine[],
  sites: readonly PublicSite[],
  ordinal: number,
): { site: PublicSite; engine: Engine; scenario: SessionScenarioName } {
  if (sites.length === 0) throw new Error("assignPublic needs at least one site");
  const site = sites[ordinal % sites.length] as PublicSite;
  const engine = engines[(ordinal + Math.floor(ordinal / sites.length)) % engines.length] as Engine;
  return { site, engine, scenario: SCENARIO_OF_SITE[site] };
}
