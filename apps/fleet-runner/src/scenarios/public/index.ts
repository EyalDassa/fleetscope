import type { Scenario } from "../types";
import { govukRead, hnRead, mdnRead, pydocsRead, wikiRead } from "./journeys";
import type { PublicSite } from "./sites";

/** One read-only journey per public site (docs/adr/0007). Not part of the demo `mix`. */
export const PUBLIC_SCENARIOS = {
  "wiki-read": wikiRead,
  "mdn-read": mdnRead,
  "govuk-read": govukRead,
  "hn-read": hnRead,
  "pydocs-read": pydocsRead,
} as const satisfies Record<string, Scenario>;

export type PublicScenarioName = keyof typeof PUBLIC_SCENARIOS;

/** The journey of each site, and the site of each journey. */
export const SCENARIO_OF_SITE: Record<PublicSite, PublicScenarioName> = {
  wikipedia: "wiki-read",
  mdn: "mdn-read",
  govuk: "govuk-read",
  hackernews: "hn-read",
  "python-docs": "pydocs-read",
};
