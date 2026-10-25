import type { Logger } from "pino";
import { createSitePacer, type SitePacer } from "./pacer";
import type { PauseStore } from "./pause";
import { PUBLIC_SITES, type PublicSite, SITES, type SiteDescriptor } from "./sites";

/**
 * robots.txt for the public sites (docs/adr/0007). We read the `*` group only, with the usual rules:
 * the longest matching rule wins, Allow wins a tie, `*` matches any characters and a trailing `$`
 * anchors the end. Crawl-delay is read as well: a site that asks for more than our minimum gets it.
 */

export interface RobotsRules {
  /** May `*` fetch this path (with its query string, e.g. `/w/index.php?title=X`)? */
  allows(pathAndQuery: string): boolean;
  /** The group's Crawl-delay in ms, or `null` if it has none. */
  crawlDelayMs: number | null;
}

export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelayMs: null };
/** What a robots.txt we could not read means for us: do not visit. */
export const DENY_ALL: RobotsRules = { allows: () => false, crawlDelayMs: null };

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

function ruleRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string): RobotsRules {
  const rules: Rule[] = [];
  let crawlDelayMs: number | null = null;
  let inStar = false; // are the lines we are reading in a group that names "*"?
  let sawRuleSinceAgent = true; // a User-agent line after rules starts a new group
  // a UTF-8 byte order mark would hide the field name of the first line
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (sawRuleSinceAgent) inStar = false; // a new group starts
      if (value === "*") inStar = true;
      sawRuleSinceAgent = false;
    } else if (field === "allow" || field === "disallow") {
      sawRuleSinceAgent = true;
      // "Disallow:" with no value allows everything: it adds no rule.
      if (inStar && value !== "") {
        rules.push({ allow: field === "allow", pattern: value, regex: ruleRegex(value) });
      }
    } else if (field === "crawl-delay") {
      sawRuleSinceAgent = true;
      const seconds = Number(value);
      if (inStar && Number.isFinite(seconds) && seconds > 0) crawlDelayMs = seconds * 1000;
    }
    // Sitemap and unknown fields change nothing.
  }
  return {
    crawlDelayMs,
    allows(pathAndQuery) {
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!rule.regex.test(pathAndQuery)) continue;
        if (
          best === undefined ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best === undefined || best.allow;
    },
  };
}

/**
 * A site for one run: its descriptor, the allowlisted paths that robots.txt still permits, and the
 * rules (journeys use `allows` for the links they follow) and the delay between navigations.
 */
export interface SiteRun {
  descriptor: SiteDescriptor;
  /** The descriptor's paths minus the ones robots.txt now disallows. Never empty. */
  paths: readonly string[];
  allows(pathAndQuery: string): boolean;
  /** The descriptor's delay, or the site's Crawl-delay if that is longer. */
  minDelayMs: number;
  /**
   * Holds `minDelayMs` between all navigations to the site in this process, whatever session makes
   * them. Optional only so that a SiteRun built by hand still works; `prepareSites` always sets it.
   */
  pacer?: SitePacer;
}

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const ROBOTS_TIMEOUT_MS = 10_000;

/**
 * Reads a site's robots.txt (RFC 9309): 200 is parsed; any 4xx means there is no robots.txt, so
 * everything is allowed; a 5xx, a network error or a timeout means we cannot know, so we do not visit.
 */
export async function fetchRobots(
  descriptor: SiteDescriptor,
  fetchFn: Fetch = fetch,
): Promise<{ rules: RobotsRules; note: string }> {
  try {
    const response = await fetchFn(`${descriptor.baseUrl}/robots.txt`, {
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
    if (response.status === 200) return { rules: parseRobots(await response.text()), note: "ok" };
    if (response.status >= 400 && response.status < 500) {
      return { rules: ALLOW_ALL, note: `robots.txt answered ${response.status}: no restrictions` };
    }
    return { rules: DENY_ALL, note: `robots.txt answered ${response.status}: cannot check it` };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { rules: DENY_ALL, note: `robots.txt not reachable (${why}): cannot check it` };
  }
}

export interface PrepareDeps {
  logger: Logger;
  pause?: PauseStore;
  /**
   * The pacers of the sites, kept between calls. A long `traffic` loop prepares the sites again every
   * few hours; passing the same map keeps the gap since the last navigation. Created per call otherwise.
   */
  pacers?: Map<PublicSite, SitePacer>;
  fetch?: Fetch;
  now?: () => number;
}

/**
 * The sites that may be visited in this run: robots.txt fetched and applied to each allowlist.
 * A site with no allowed path, or one that is paused, is left out with one log line.
 */
export async function prepareSites(deps: PrepareDeps): Promise<Map<PublicSite, SiteRun>> {
  const now = deps.now ?? Date.now;
  const prepared = new Map<PublicSite, SiteRun>();
  await Promise.all(
    PUBLIC_SITES.map(async (site) => {
      const descriptor = SITES[site];
      const pausedUntil = deps.pause?.pausedUntil(site, now());
      if (pausedUntil !== undefined) {
        const until = new Date(pausedUntil).toISOString();
        deps.logger.warn(
          { site, pausedUntil: until },
          `public site ${site} is paused until ${until}: skipped`,
        );
        return;
      }
      const { rules, note } = await fetchRobots(descriptor, deps.fetch);
      const paths = descriptor.paths.filter((path) => rules.allows(path));
      if (paths.length === 0) {
        deps.logger.warn({ site, robots: note }, `public site ${site}: no allowed path, skipped`);
        return;
      }
      const dropped = descriptor.paths.length - paths.length;
      deps.logger.info(
        { site, paths: paths.length, droppedByRobots: dropped, robots: note },
        `public site ${site}: ${paths.length} allowed paths${dropped > 0 ? `, ${dropped} dropped by robots.txt` : ""}`,
      );
      const pacer = deps.pacers?.get(site) ?? createSitePacer();
      deps.pacers?.set(site, pacer);
      prepared.set(site, {
        descriptor,
        paths,
        allows: (pathAndQuery) => rules.allows(pathAndQuery),
        minDelayMs: Math.max(descriptor.minDelayMs, rules.crawlDelayMs ?? 0),
        pacer,
      });
    }),
  );
  // in the order of PUBLIC_SITES, whatever order the fetches finished in
  const ordered = new Map<PublicSite, SiteRun>();
  for (const site of PUBLIC_SITES) {
    const run = prepared.get(site);
    if (run) ordered.set(site, run);
  }
  return ordered;
}
