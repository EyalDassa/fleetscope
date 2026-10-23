import { pino } from "pino";
import { loadConfig } from "./config";
import { DockerFleet } from "./docker";
import { parseRunArgs, USAGE, UsageError } from "./options";
import { preflight } from "./preflight";
import { runFleet } from "./run";
import { formatSummary } from "./summary";

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

async function runCommand(args: string[]): Promise<number> {
  const options = parseRunArgs(args);
  const config = loadConfig();
  const logger = pino({ name: "fleet-runner", level: config.logLevel });
  const fleets = new Map(
    options.engines.map((engine) => [engine, new DockerFleet(config.browserImage, engine, logger)]),
  );
  const anyFleet = fleets.values().next().value as DockerFleet;

  const problems = await preflight({
    apiUrl: config.apiUrl,
    demoSiteUrl: config.demoSiteUrl,
    browserImage: config.browserImage,
    docker: anyFleet,
  });
  if (problems.length > 0) {
    err("Cannot start the run:\n");
    for (const problem of problems) err(`  - ${problem.message}\n`);
    return 1;
  }

  // Ctrl+C: stop starting sessions, end the running ones as failed/"interrupted", flush, clean up.
  const interrupt = new AbortController();
  let interrupts = 0;
  const onSignal = (name: string) => {
    interrupts++;
    if (interrupts === 1) {
      logger.warn({ signal: name }, "interrupted: ending running sessions, then cleaning up");
      interrupt.abort();
    } else {
      err(
        "Second interrupt: exiting now. Run `pnpm fleet cleanup` to remove leftover containers.\n",
      );
      process.exit(130);
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  logger.info(
    {
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

  const run = await runFleet({ config, options, fleets, logger, signal: interrupt.signal });

  // Belt and braces: every session removes its own container, this catches anything that slipped.
  let leftovers = 0;
  for (const fleet of fleets.values()) leftovers += await fleet.removeAllOwned();
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
  const fleet = new DockerFleet(config.browserImage, "chromium", logger);
  try {
    await fleet.ping();
  } catch (error) {
    err(`Cannot reach Docker: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const removed = await fleet.removeAllOwned();
  out(`Removed ${removed} container${removed === 1 ? "" : "s"} labelled fleetscope.session.\n`);
  return 0;
}

async function main(): Promise<number> {
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

main().then(
  (code) => process.exit(code),
  (error) => {
    err(
      `${JSON.stringify({ level: 60, msg: "fleet runner crashed", err: String(error?.stack ?? error) })}\n`,
    );
    process.exit(1);
  },
);
