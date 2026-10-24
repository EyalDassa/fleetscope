import { type CollectedSession, type Collector, createCollector } from "@fleetscope/collector";
import type { Engine } from "@fleetscope/schema";
import type { Logger } from "pino";
import { assignSession, routeSession, unmetNeeds } from "./assign";
import type { RunnerConfig } from "./config";
import type { DockerFleet } from "./docker";
import type { RunOptions } from "./options";
import { sessionSeed } from "./rng";
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
  /** Test hook. */
  runSession?: typeof runSession;
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
  let next = 0;

  async function lane(): Promise<void> {
    while (!signal.aborted) {
      const n = next++;
      if (n >= options.sessions) return;
      const index = (deps.firstIndex ?? 0) + n;
      const assigned = assignSession(options.engines, options.scenario, options.seed, index);
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
      results.push(
        await (deps.runSession ?? runSession)(
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
            seed: sessionSeed(options.seed, index),
          },
        ),
      );
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
