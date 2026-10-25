import { randomUUID } from "node:crypto";
import type { CollectedSession } from "@fleetscope/collector";
import type { Engine } from "@fleetscope/schema";
import { type Logger, pino } from "pino";
import { loadConfig, type RunnerConfig } from "./config";
import { DockerFleet } from "./docker";
import { createInterruptHandler } from "./interrupt";
import { parseRunArgs, parseTrafficArgs, type RunOptions, USAGE, UsageError } from "./options";
import { preflight } from "./preflight";
import { createCollectors, runFleet } from "./run";
import type { SitePacer } from "./scenarios/public/pacer";
import { createPauseStore } from "./scenarios/public/pause";
import { prepareSites } from "./scenarios/public/robots";
import type { PublicSite } from "./scenarios/public/sites";
import type { SessionResult } from "./session-runner";
import { forceShutdown } from "./shutdown";
import { engineLabel, formatSummary, visitLabel } from "./summary";

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

/** Environment of the forwarder sidecar. */
function forwarderEnv(config: RunnerConfig): string[] {
  return config.demoSiteUpstream ? [`DEMO_SITE_UPSTREAM=${config.demoSiteUpstream}`] : [];
}

/** A traffic loop reads the public sites' robots.txt again this often. */
const ROBOTS_REFRESH_MS = 6 * 60 * 60 * 1000;

/** If the exit-now path itself takes longer than this, give up and exit. */
const FORCE_EXIT_DEADLINE_MS = 6500;

/** Everything `run` and `traffic` share: Docker fleets, collectors, Ctrl+C, preflight. */
async function prepare(options: RunOptions, label: string) {
  const config = loadConfig();
  const logger = pino({ name: "fleet-runner", level: config.logLevel });
  // Marks this run's containers, so finishing (or Ctrl+C) never touches another run's.
  const runId = randomUUID().slice(0, 8);
  const fleets = new Map(
    options.engines.map((engine) => [
      engine,
      new DockerFleet(config.browserImages[engine], engine, logger, {
        runId,
        forwarder: { image: config.forwarderImage, env: forwarderEnv(config) },
      }),
    ]),
  );
  if (process.env.FLEET_BROWSER_IMAGE?.trim()) {
    logger.warn(
      {
        chromiumImage: config.browserImages.chromium,
        setTo: process.env.FLEET_BROWSER_IMAGE.trim(),
      },
      "FLEET_BROWSER_IMAGE is the legacy name for the chromium image. If it points at a pre-M3 image (revision 1, with its own forwarder), chromium's memory includes the forwarder: use FLEET_BROWSER_IMAGE_CHROMIUM=fleetscope/playwright-chromium:1.64.1-2",
    );
  }
  const anyFleet = fleets.values().next().value as DockerFleet;
  const collectors = createCollectors(config, options, logger);
  const live = new Set<CollectedSession>();

  // Ctrl+C, see interrupt.ts for the escalation. Installed first, so a Ctrl+C during the preflight
  // is handled too instead of killing the process in the middle of a check.
  const interrupt = new AbortController();
  const onSignal = createInterruptHandler({
    onFirst: () => {
      logger.warn(
        "interrupted: ending the running sessions, then cleaning up (Ctrl+C again after 2 s stops waiting)",
      );
      interrupt.abort();
    },
    onForce: () => {
      logger.warn("second interrupt: not waiting for running sessions, flushing and cleaning up");
      setTimeout(() => process.exit(130), FORCE_EXIT_DEADLINE_MS).unref();
      forceShutdown({ live, collectors, fleets, runId, logger }).finally(() => process.exit(130));
    },
    onExit: () => {
      err(
        "Third interrupt: exiting now. Run `pnpm fleet cleanup` to remove leftover containers.\n",
      );
      process.exit(130);
    },
  });
  const handle = (name: string) => {
    const action = onSignal();
    if (action === "ignored") logger.debug({ signal: name }, "same interrupt, ignored");
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));

  logger.info(`${label} preflight: checking the API, the demo site, Docker and the images`);
  const aborted = new Promise<"aborted">((resolve) =>
    interrupt.signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
  );
  const [first, ...rest] = options.engines;
  const checked = await Promise.race([
    preflight({
      apiUrl: config.apiUrl,
      demoSiteUrl: config.demoSiteUrl,
      browserImage: config.browserImages[first as Engine],
      otherImages: [
        ...rest.map((engine) => ({
          image: config.browserImages[engine],
          what: "browser image" as const,
        })),
        { image: config.forwarderImage, what: "forwarder image" as const },
      ],
      docker: anyFleet,
    }),
    aborted,
  ]);
  if (checked === "aborted") {
    err("Interrupted before the run started.\n");
    return 130;
  }
  if (checked.length > 0) {
    err("Cannot start the run:\n");
    for (const problem of checked) err(`  - ${problem.message}\n`);
    return 1;
  }
  return { config, logger, runId, fleets, collectors, live, interrupt };
}

/** Removes what a session did not clean up. Only this run's: another run keeps its containers. */
async function sweep(
  fleets: ReadonlyMap<Engine, DockerFleet>,
  runId: string,
  logger: Logger,
): Promise<void> {
  let leftovers = 0;
  for (const fleet of fleets.values()) leftovers += await fleet.removeAllOwned({ runId });
  if (leftovers > 0) logger.warn({ leftovers }, "removed containers a session had not cleaned up");
}

async function runCommand(args: string[]): Promise<number> {
  const options = parseRunArgs(args);
  const ready = await prepare(options, "run");
  if (typeof ready === "number") return ready;
  const { config, logger, runId, fleets, collectors, live, interrupt } = ready;

  logger.info(
    {
      runId,
      engines: options.engines,
      sessions: options.sessions,
      concurrency: options.concurrency,
      scenario: options.scenario,
      routing: options.routing,
      public: options.public,
      stateFile: options.stateFile,
      seed: options.seed,
      agent: options.agentId,
      api: config.apiUrl,
      demoSite: config.demoSiteUrl,
      images: Object.fromEntries(options.engines.map((e) => [e, config.browserImages[e]])),
      forwarder: config.forwarderImage,
    },
    `run starting (repeat it with --seed ${options.seed})`,
  );

  // Public sessions: read each site's robots.txt now and drop the paths it forbids (docs/adr/0007).
  const pauseStore = createPauseStore(options.stateFile, {
    onWriteError: (error) =>
      logger.warn(
        { err: error, stateFile: options.stateFile },
        "could not write the pause file: the pause holds in this process only",
      ),
  });
  const publicSites =
    options.public > 0 ? await prepareSites({ logger, pause: pauseStore }) : undefined;

  const run = await runFleet({
    config,
    options,
    fleets,
    collectors,
    logger,
    signal: interrupt.signal,
    live,
    publicSites,
    pause: pauseStore,
  });

  // Belt and braces: every session removes its own containers, this catches anything that slipped.
  await sweep(fleets, runId, logger);

  out(`\n${formatSummary(run.results, run.delivery, run.elapsedMs, run.skipped)}`);

  if (interrupt.signal.aborted) return 130;
  const infraErrors = run.results.filter((r) => r.status === "infra_error").length;
  if (run.delivery.dropped > 0) {
    err(`${run.delivery.dropped} events were not delivered to the API (see the log above).\n`);
  }
  return infraErrors > 0 || run.delivery.dropped > 0 ? 1 : 0;
}

/** One line for a finished batch of the traffic loop. */
export function batchLine(batch: number, results: readonly SessionResult[], ms: number): string {
  const sessions = [...results]
    .sort((a, b) => a.index - b.index)
    .map(
      (r) => `${engineLabel(r)}/${r.target === "public" ? visitLabel(r) : r.scenario}=${r.status}`,
    )
    .join(", ");
  const first = results.length > 0 ? Math.min(...results.map((r) => r.index)) + 1 : 0;
  const last = first + results.length - 1;
  return `batch ${batch}: #${first}-#${last} ${sessions} (${(ms / 1000).toFixed(1)}s)\n`;
}

/** Waits `ms`, or less if the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * `fleet traffic`: keeps real sessions coming at `--rate` per minute, in batches of
 * min(concurrency, rate) sessions. A batch starts when the previous period is over; if sessions take
 * longer than the period the next batch starts at once (the rate is then lower than asked, which
 * the batch duration on each line shows).
 */
async function trafficCommand(args: string[]): Promise<number> {
  const options = parseTrafficArgs(args);
  const ready = await prepare(options, "traffic");
  if (typeof ready === "number") return ready;
  const { config, logger, runId, fleets, collectors, live, interrupt } = ready;
  const { signal } = interrupt;

  const batchSize = Math.min(options.concurrency, options.ratePerMinute);
  const periodMs = (batchSize * 60_000) / options.ratePerMinute;
  const startedAt = Date.now();
  const stopAt = options.durationMs === undefined ? Infinity : startedAt + options.durationMs;
  logger.info(
    {
      runId,
      engines: options.engines,
      ratePerMinute: options.ratePerMinute,
      concurrency: options.concurrency,
      batchSize,
      periodSeconds: Math.round(periodMs / 1000),
      durationMs: options.durationMs,
      scenario: options.scenario,
      routing: options.routing,
      public: options.public,
      stateFile: options.stateFile,
      seed: options.seed,
      agent: options.agentId,
      api: config.apiUrl,
    },
    "traffic starting (Ctrl+C stops it)",
  );

  const results: SessionResult[] = [];
  const warnedUnroutable = new Set<string>();
  // Public sessions: robots.txt is read at the start and again every few hours, because a traffic
  // loop can run for days (docs/adr/0007). The counter keeps the rotation going across batches.
  const pauseStore = createPauseStore(options.stateFile, {
    onWriteError: (error) =>
      logger.warn(
        { err: error, stateFile: options.stateFile },
        "could not write the pause file: the pause holds in this process only",
      ),
  });
  const publicCounter = { next: options.seed };
  // one pacer per site for the whole loop, also across the refreshes of robots.txt
  const pacers = new Map<PublicSite, SitePacer>();
  let publicSites =
    options.public > 0 ? await prepareSites({ logger, pause: pauseStore, pacers }) : undefined;
  let robotsReadAt = Date.now();
  let index = 0;
  let batch = 0;
  while (!signal.aborted && Date.now() < stopAt) {
    const batchStart = Date.now();
    if (options.public > 0 && batchStart - robotsReadAt > ROBOTS_REFRESH_MS) {
      publicSites = await prepareSites({ logger, pause: pauseStore, pacers });
      robotsReadAt = Date.now();
    }
    const run = await runFleet({
      config,
      options: { ...options, sessions: batchSize, concurrency: batchSize },
      fleets,
      collectors,
      logger,
      signal,
      live,
      firstIndex: index,
      closeCollectors: false,
      warnedUnroutable,
      publicSites,
      pause: pauseStore,
      publicCounter,
    });
    index += batchSize;
    results.push(...run.results);
    batch++;
    out(batchLine(batch, run.results, run.elapsedMs));

    const wait = Math.min(periodMs - (Date.now() - batchStart), stopAt - Date.now());
    if (wait > 0 && !signal.aborted) await pause(wait, signal);
  }

  await Promise.all([...collectors.values()].map((collector) => collector.close()));
  await sweep(fleets, runId, logger);
  const delivery = { pushed: 0, sent: 0, duplicates: 0, dropped: 0, pending: 0 };
  for (const collector of collectors.values()) {
    const stats = collector.stats();
    delivery.pushed += stats.pushed;
    delivery.sent += stats.sent;
    delivery.duplicates += stats.duplicates;
    delivery.dropped += stats.dropped;
    delivery.pending += stats.pending;
  }
  out(`\n${formatSummary(results, delivery, Date.now() - startedAt)}`);
  if (signal.aborted) return 130;
  return delivery.dropped > 0 ? 1 : 0;
}

async function cleanupCommand(): Promise<number> {
  const config = loadConfig();
  const logger = pino({ name: "fleet-runner", level: config.logLevel });
  const fleet = new DockerFleet(config.browserImage, "chromium", logger);
  try {
    await fleet.ping();
  } catch (error) {
    err(`Cannot reach Docker: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // Every run's containers (browsers and sidecars): this is the "something went wrong, clean it all up" command.
  const removed = await fleet.removeAllOwned();
  out(`Removed ${removed} container${removed === 1 ? "" : "s"} labelled fleetscope.session.\n`);
  return 0;
}

export async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "run") return await runCommand(rest);
    if (command === "traffic") return await trafficCommand(rest);
    if (command === "cleanup") return await cleanupCommand();
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      out(`${USAGE}\n`);
      return command === undefined ? 2 : 0;
    }
    throw new UsageError(`unknown command "${command}"`);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`Error: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
}
