import { randomUUID } from "node:crypto";
import type { CollectedSession } from "@fleetscope/collector";
import { pino } from "pino";
import { loadConfig, type RunnerConfig } from "./config";
import { DockerFleet } from "./docker";
import { createInterruptHandler } from "./interrupt";
import { parseRunArgs, USAGE, UsageError } from "./options";
import { preflight } from "./preflight";
import { createCollectors, runFleet } from "./run";
import { forceShutdown } from "./shutdown";
import { formatSummary } from "./summary";

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

/** Environment passed to every browser container. */
function containerEnv(config: RunnerConfig): string[] {
  return config.demoSiteUpstream ? [`DEMO_SITE_UPSTREAM=${config.demoSiteUpstream}`] : [];
}

/** If the exit-now path itself takes longer than this, give up and exit. */
const FORCE_EXIT_DEADLINE_MS = 6500;

async function runCommand(args: string[]): Promise<number> {
  const options = parseRunArgs(args);
  const config = loadConfig();
  const logger = pino({ name: "fleet-runner", level: config.logLevel });
  // Marks this run's containers, so finishing (or Ctrl+C) never touches another run's.
  const runId = randomUUID().slice(0, 8);
  const fleets = new Map(
    options.engines.map((engine) => [
      engine,
      new DockerFleet(config.browserImage, engine, logger, { env: containerEnv(config), runId }),
    ]),
  );
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

  logger.info("preflight: checking the API, the demo site, Docker and the browser image");
  const aborted = new Promise<"aborted">((resolve) =>
    interrupt.signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
  );
  const checked = await Promise.race([
    preflight({
      apiUrl: config.apiUrl,
      demoSiteUrl: config.demoSiteUrl,
      browserImage: config.browserImage,
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

  logger.info(
    {
      runId,
      engines: options.engines,
      sessions: options.sessions,
      concurrency: options.concurrency,
      scenario: options.scenario,
      seed: options.seed,
      agent: options.agentId,
      api: config.apiUrl,
      demoSite: config.demoSiteUrl,
      image: config.browserImage,
    },
    `run starting (repeat it with --seed ${options.seed})`,
  );

  const run = await runFleet({
    config,
    options,
    fleets,
    collectors,
    logger,
    signal: interrupt.signal,
    live,
  });

  // Belt and braces: every session removes its own container, this catches anything that slipped.
  // Only this run's: another `pnpm fleet run` in a second terminal keeps its containers.
  let leftovers = 0;
  for (const fleet of fleets.values()) leftovers += await fleet.removeAllOwned({ runId });
  if (leftovers > 0) logger.warn({ leftovers }, "removed containers a session had not cleaned up");

  out(`\n${formatSummary(run.results, run.delivery, run.elapsedMs, run.skipped)}`);

  if (interrupt.signal.aborted) return 130;
  const infraErrors = run.results.filter((r) => r.status === "infra_error").length;
  if (run.delivery.dropped > 0) {
    err(`${run.delivery.dropped} events were not delivered to the API (see the log above).\n`);
  }
  return infraErrors > 0 || run.delivery.dropped > 0 ? 1 : 0;
}

async function cleanupCommand(): Promise<number> {
  const config = loadConfig();
  const logger = pino({ name: "fleet-runner", level: config.logLevel });
  const fleet = new DockerFleet(config.browserImage, "chromium", logger, {
    env: containerEnv(config),
  });
  try {
    await fleet.ping();
  } catch (error) {
    err(`Cannot reach Docker: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // Every run's containers: this is the "something went wrong, clean it all up" command.
  const removed = await fleet.removeAllOwned();
  out(`Removed ${removed} container${removed === 1 ? "" : "s"} labelled fleetscope.session.\n`);
  return 0;
}

export async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "run") return await runCommand(rest);
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
