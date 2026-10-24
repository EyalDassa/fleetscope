import type { ActionType, Engine, SessionStatus } from "@fleetscope/schema";
import { ENGINES } from "@fleetscope/schema";
import type { Dist } from "./rng";

/**
 * The numbers the simulator draws from, per engine and scenario. `profile.json` is produced by
 * `pnpm sim calibrate` (see calibrate.ts); an engine without real sessions gets numbers derived
 * from Chromium's with the documented factors in priors.ts.
 */

export interface ProfileStep {
  action_type: ActionType;
  /** Average number of this action per session (3.4 = three, and a 40% chance of a fourth). */
  per_session: number;
  /** The most common real target of this action in this scenario. */
  target: string;
  latency_ms: Dist;
}

/** One way a session ends badly. The probabilities of a scenario's failures add up to at most 1. */
export interface ProfileFailure {
  /** Chance that a session of this scenario and engine ends this way. */
  p: number;
  status: SessionStatus;
  reason: string;
  /** The failing action's error code. The matching `issue` event is derived (ISSUE_FOR_CODE). */
  error_code: string;
  /** Where in the session it fails, 0 (first action) to 1 (last). */
  at: number;
}

export interface ProfileNetwork {
  /** Average sampled requests per session. */
  requests: number;
  domain: string;
  duration_ms: Dist;
  bytes: Dist;
  /** Share of requests whose size the engine reports (the rest is `null`). */
  bytes_reported: number;
  /** Relative weight of each resource type. */
  resource_types: Record<string, number>;
}

export interface ProfileScenario {
  /** Duration of a session (`duration_ms`, browser already usable), successful ones. */
  duration_ms: Dist;
  /** Highest container memory of a session, MiB. */
  peak_mem_mib: Dist;
  /** Memory of the first sample as a share of the peak. Memory rises from here to the peak, page by page. */
  base_ratio: number;
  steps: ProfileStep[];
  network: ProfileNetwork;
  failures: ProfileFailure[];
}

export interface ProfileEngine {
  /** `real`: measured from `real_sessions` real sessions. `prior`: derived from `derived_from` with the factors in `note`. */
  basis: "real" | "prior";
  real_sessions: number;
  derived_from?: Engine;
  note: string;
  engine_version: string | null;
  startup_ms: Dist;
  connect_ms: Dist;
  /** Container CPU, % of one core, per sample. */
  cpu_pct: Dist;
  /** JS heap per sample, MiB; `null` when the engine cannot report it (Lightpanda). */
  heap_mb: Dist | null;
  scenarios: Record<string, ProfileScenario>;
}

export interface Profile {
  version: 1;
  /** When `pnpm sim calibrate` produced this file (ISO). */
  generated_at: string;
  method: string;
  engines: Record<Engine, ProfileEngine>;
}

/** Throws a readable error if a value is not a usable profile (a hand edit, an old version). */
export function assertProfile(value: unknown): Profile {
  const profile = value as Profile;
  if (profile?.version !== 1 || typeof profile.engines !== "object") {
    throw new Error("profile.json is not a version 1 profile; run `pnpm sim calibrate`");
  }
  for (const engine of ENGINES) {
    const entry = profile.engines[engine];
    if (!entry || Object.keys(entry.scenarios ?? {}).length === 0) {
      throw new Error(`profile.json has no scenarios for ${engine}; run \`pnpm sim calibrate\``);
    }
  }
  return profile;
}

export function scenariosOf(profile: Profile): string[] {
  return Object.keys(profile.engines.chromium.scenarios).sort();
}
