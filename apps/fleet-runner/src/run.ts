import { type CollectedSession, type Collector, createCollector } from "@fleetscope/collector";
import { DEMO_SITE, type Engine, type Target } from "@fleetscope/schema";
import type { Logger } from "pino";
import { type Assignment, assignPublic, assignSession, routeSession, unmetNeeds } from "./assign";
import type { RunnerConfig } from "./config";
import type { DockerFleet } from "./docker";
import type { RunOptions } from "./options";
import { sessionSeed } from "./rng";
import { PAUSE_MS, type PauseStore } from "./scenarios/public/pause";
import type { SiteRun } from "./scenarios/public/robots";
import type { PublicSite } from "./scenarios/public/sites";
import { runSession, type SessionResult } from "./session-runner";

export interface FleetRunResult {
  results: SessionResult[];
  /** Sessions that were never started because the run was interrupted. */
  skipped: number;
  /** Events handed to the collectors, accepted by the API, and lost (summed over engines). */
  delivery: { pushed: number; sent: number; duplicates: number; dropped: number; pending: number };
  elapsedMs: number;
}

export interface FleetRunDeps {
  config: RunnerConfig;
  options: RunOptions;
  /** One DockerFleet per engine (it knows the image). */
  fleets: ReadonlyMap<Engine, DockerFleet>;
  /** One collector per engine, from `createCollectors`. `runFleet` closes them when it is done. */
  collectors: ReadonlyMap<Engine, Collector>;
  logger: Logger;
  signal: AbortSignal;
  /** Sessions that have started and not ended (see `SessionDeps.live`). */
  live?: Set<CollectedSession>;
  /** Index of the first session (`fleet traffic` runs batches that continue one another). Default 0. */
  firstIndex?: number;
  /** Close the collectors when done (default). `fleet traffic` keeps them across batches. */
  closeCollectors?: boolean;
  /**
   * "engine/scenario" pairs already warned about (no engine of the run can run the scenario). Share
   * one set across batches (`fleet traffic`) to warn once per run, not once per batch.
   */
  warnedUnroutable?: Set<string>;
  /**
   * The public sites this run may visit, from `prepareSites` (robots.txt already applied). Needed
   * when `options.public > 0`; without it every session is a demo session.
   */
  publicSites?: ReadonlyMap<PublicSite, SiteRun>;
  /** Which public sites are paused. A site that pushes back is paused here. */
  pause?: PauseStore;
  /**
   * Counts the public sessions assigned so far, so that the rotation over sites and engines goes on
   * from one batch to the next (`fleet traffic`). Share one object across batches; its first value
   * is where the rotation starts.
   */
  publicCounter?: { next: number };
  /** Test hooks. */
  runSession?: typeof runSession;
  now?: () => number;
}

/** One collector per engine: they own the in-order queues that ship events to the API. */
export function createCollectors(
  config: RunnerConfig,
  options: RunOptions,
  logger: Logger,
): Map<Engine, Collector> {
  return new Map(
    options.engines.map((engine) => [
      engine,
      createCollector({
        apiUrl: config.apiUrl,
        source: "real",
        agentId: options.agentId,
        provider: "local-docker",
        engine,
        logger: logger.child({ component: "collector", engine }),
      }),
    ]),
  );
}

/**
 * Runs `options.sessions` sessions with at most `options.concurrency` browser containers alive at
 * once. Engine and scenario come from `assignSession` (every scenario on every engine), then
 * `routeSession` applies `options.routing`. Returns when every started session has ended and the collectors have flushed.
 */
export async function runFleet(deps: FleetRunDeps): Promise<FleetRunResult> {
  const { config, options, logger, signal, collectors } = deps;
  const startedAt = Date.now();

  const results: SessionResult[] = [];
  const warned = deps.warnedUnroutable ?? new Set<string>();
  const publicCounter = deps.publicCounter ?? { next: options.seed };
  const now = deps.now ?? Date.now;
  let warnedNoPublicSite = false;
  let next = 0;

  /** Public sites with a session running now: a site gets one visitor at a time (docs/adr/0007). */
  const busySites = new Set<PublicSite>();
  /** The public sites that may be visited right now: prepared, not paused and not busy. */
  const activeSites = (): PublicSite[] =>
    [...(deps.publicSites?.keys() ?? [])].filter(
      (site) => !busySites.has(site) && !deps.pause?.isPaused(site, now()),
    );

  async function lane(): Promise<void> {
    while (!signal.aborted) {
      const n = next++;
      if (n >= options.sessions) return;
      const index = (deps.firstIndex ?? 0) + n;
      // The first `options.public` sessions of the batch visit public sites; the rest are the demo mix.
      let assigned: Assignment | undefined;
      let target: Target = "demo";
      let site: string = DEMO_SITE;
      let siteRun: SiteRun | undefined;
      if (n < options.public) {
        const sites = activeSites();
        if (sites.length > 0) {
          const pick = assignPublic(options.engines, sites, publicCounter.next++);
          assigned = { engine: pick.engine, scenario: pick.scenario };
          target = "public";
          site = pick.site;
          siteRun = deps.publicSites?.get(pick.site);
          busySites.add(pick.site);
        } else if (!warnedNoPublicSite) {
          warnedNoPublicSite = true;
          logger.warn(
            "public sessions requested but no public site is free (paused, busy with another session, skipped by robots.txt, or not prepared): running them on the demo site",
          );
        }
      }
      assigned ??= assignSession(options.engines, options.scenario, options.seed, index);
      const { engine, scenario, routedFrom } = routeSession(
        assigned,
        options.engines,
        options.routing,
      );
      const unmet = unmetNeeds(engine, scenario);
      const key = `${engine}/${scenario}`;
      if (options.routing === "by-scenario" && unmet.length > 0 && !warned.has(key)) {
        warned.add(key);
        logger.warn(
          { engine, scenario, missing: unmet, engines: options.engines },
          `routing: no engine of this run can run ${scenario} (needs ${unmet.join(", ")}); it runs on ${engine} and is expected to fail. Add chrome-headless-shell or chromium to --engines`,
        );
      }
      const fleet = deps.fleets.get(engine);
      const collector = collectors.get(engine);
      if (!fleet || !collector) throw new Error(`no browser fleet for engine ${engine}`);
      let result: SessionResult;
      try {
        result = await (deps.runSession ?? runSession)(
          {
            fleet,
            collector,
            config,
            sessionTimeoutMs: options.sessionTimeoutMs,
            logger,
            signal,
            live: deps.live,
          },
          {
            index,
            engine,
            routedFrom,
            scenario,
            target,
            site,
            siteRun,
            seed: sessionSeed(options.seed, index),
          },
        );
      } finally {
        if (target === "public") busySites.delete(site as PublicSite);
      }
      results.push(result);
      // A public site that said no (403, 429, CAPTCHA) is left alone for an hour (docs/adr/0007).
      if (target === "public" && result.status === "blocked") {
        const until = now() + PAUSE_MS;
        deps.pause?.pause(site as PublicSite, until);
        logger.warn(
          { site, reason: result.reason, pausedUntil: new Date(until).toISOString() },
          `public site ${site} pushed back: paused for an hour`,
        );
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: options.concurrency }, lane));
  } finally {
    // Always flush and stop the collectors, even if a lane threw.
    const done = (collector: Collector) =>
      deps.closeCollectors === false ? collector.flush() : collector.close();
    await Promise.all([...collectors.values()].map(done));
  }

  const delivery = { pushed: 0, sent: 0, duplicates: 0, dropped: 0, pending: 0 };
  for (const collector of collectors.values()) {
    const stats = collector.stats();
    delivery.pushed += stats.pushed;
    delivery.sent += stats.sent;
    delivery.duplicates += stats.duplicates;
    delivery.dropped += stats.dropped;
    delivery.pending += stats.pending;
  }
  return {
    results,
    skipped: options.sessions - results.length,
    delivery,
    elapsedMs: Date.now() - startedAt,
  };
}
