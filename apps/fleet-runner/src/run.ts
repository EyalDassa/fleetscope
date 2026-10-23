import { type Collector, createCollector } from "@fleetscope/collector";
import type { Engine } from "@fleetscope/schema";
import type { Logger } from "pino";
import type { RunnerConfig } from "./config";
import type { DockerFleet } from "./docker";
import type { RunOptions } from "./options";
import { sessionSeed } from "./rng";
import { scenarioFor } from "./scenarios";
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
  logger: Logger;
  signal: AbortSignal;
  /** Test hooks. */
  collectorFor?: (engine: Engine) => Collector;
  runSession?: typeof runSession;
}

/**
 * Runs `options.sessions` sessions with at most `options.concurrency` browser containers alive at
 * once. Sessions take the engines in turn and the scenarios from `scenarioFor` (round-robin for
 * `mix`). Returns when every started session has ended and the collectors have flushed.
 */
export async function runFleet(deps: FleetRunDeps): Promise<FleetRunResult> {
  const { config, options, logger, signal } = deps;
  const startedAt = Date.now();

  const collectors = new Map<Engine, Collector>(
    options.engines.map((engine) => [
      engine,
      deps.collectorFor?.(engine) ??
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

  const results: SessionResult[] = [];
  let next = 0;

  async function lane(): Promise<void> {
    while (!signal.aborted) {
      const index = next++;
      if (index >= options.sessions) return;
      const engine = options.engines[index % options.engines.length] as Engine;
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
          },
          {
            index,
            engine,
            scenario: scenarioFor(options.scenario, index, options.seed),
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
    await Promise.all([...collectors.values()].map((collector) => collector.close()));
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
