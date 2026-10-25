import type { CollectedPage } from "@fleetscope/collector";
import type { Logger } from "pino";
import type { Rng } from "../rng";
import type { SiteRun } from "./public/robots";

export interface ScenarioContext {
  /** Demo site as the browser sees it, e.g. `http://localhost:3100`. No trailing slash. */
  baseUrl: string;
  /** Seeded per session: every random choice a scenario makes comes from here. */
  rng: Rng;
  logger: Logger;
  /** Public sessions only: the site this session visits, with the paths robots.txt allows today. */
  siteRun?: SiteRun;
  /** Public sessions only: aborted when the session is cut off, so a wait between pages ends at once. */
  signal?: AbortSignal;
  /** Test hooks for the wait between navigations of a public session. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * A scenario is the work an "agent" does in one session. It uses only the collector-wrapped page, so
 * every step is measured. Throwing ends the session: `BlockedError` becomes `blocked`, a timeout
 * becomes `timeout`, anything else `failed`. Returning normally is `success`.
 */
export type Scenario = (page: CollectedPage, ctx: ScenarioContext) => Promise<void>;
