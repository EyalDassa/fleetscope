import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { ENGINES, type Engine, SAFE_LABEL_PATTERN } from "@fleetscope/schema";
import { ROUTING_POLICIES, type RoutingPolicy } from "./assign";
import { SCENARIO_NAMES, type ScenarioName } from "./scenarios";

export interface RunOptions {
  engines: Engine[];
  sessions: number;
  concurrency: number;
  scenario: ScenarioName | "mix";
  seed: number;
  agentId: string;
  /** `fixed`: every session runs on the engine it was assigned. `by-scenario`: see `routeSession`. */
  routing: RoutingPolicy;
  /** A session still running after this long is cut off and ends as `timeout`. */
  sessionTimeoutMs: number;
}

/** Wrong command line. The message is for the person typing; `main` prints it with the usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `Usage:
  pnpm fleet run [options]     run sessions in Docker browser containers and report them
  pnpm fleet traffic [options] keep running sessions at a steady rate until Ctrl+C (or --duration)
  pnpm fleet cleanup           remove leftover containers labelled fleetscope.session

Options for "run":
  --engines <list>          comma-separated: chromium, chrome-headless-shell, lightpanda; default chromium
  --sessions <n>            number of sessions, default 10
  --concurrency <n>         containers alive at the same time, default 4
  --scenario <name>         ${[...SCENARIO_NAMES, "mix"].join(" | ")}, default mix
  --seed <n>                makes the scenario choice and the chaos repeatable (default: random, printed)
  --agent <id>              agent_id on every event, default fleet-runner@<hostname>
  --routing <policy>        fixed | by-scenario, default fixed. by-scenario runs a scenario only on an
                            engine that can: heavy-page-crawl needs web workers, which Lightpanda does
                            not run, so its sessions go to chrome-headless-shell (or chromium) and are
                            recorded as routed (sessions.routed_from)
  --session-timeout <sec>   cut off a session that runs longer, default 120

Options for "traffic" (also --engines, --agent, --scenario, --seed, --routing, --session-timeout):
  --rate <n>                sessions per minute, default 3
  --concurrency <n>         containers alive at the same time, default 2
  --duration <time>         stop after this long, e.g. 90s, 10m, 2h (default: until Ctrl+C)
  --agent <id>              default traffic@<hostname>

Environment: FLEETSCOPE_API_URL, DEMO_SITE_URL, FLEET_BROWSER_IMAGE_<ENGINE> (CHROMIUM,
CHROME_HEADLESS_SHELL, LIGHTPANDA), FLEET_FORWARDER_IMAGE, DOCKER_HOST, LOG_LEVEL`;

/**
 * `fleet-runner@<host name>`, with every character the schema does not allow in an agent id replaced
 * by `_`. A host name is whatever the machine owner typed (underscores, accents, ...), and an agent
 * id the API refuses would make it reject every batch of the run.
 */
export function defaultAgentId(host: string = hostname()): string {
  return `fleet-runner@${host.replace(/[^A-Za-z0-9._:@/+-]/g, "_")}`.slice(0, 128);
}

function positiveInt(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new UsageError(`--${name} must be a whole number from 1 to ${max}, got "${raw}"`);
  }
  return Number(raw);
}

function parseEngines(raw: string | undefined): Engine[] {
  const names = (raw ?? "chromium")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) throw new UsageError("--engines needs at least one engine");
  const engines: Engine[] = [];
  for (const name of names) {
    if (!(ENGINES as readonly string[]).includes(name)) {
      const hint = name === "chrome" ? ' (did you mean "chromium"?)' : "";
      throw new UsageError(`unknown engine "${name}"${hint}. Known engines: ${ENGINES.join(", ")}`);
    }
    if (!engines.includes(name as Engine)) engines.push(name as Engine);
  }
  return engines;
}

/** Parses the arguments after `run`. `randomSeed` is injectable for tests. */
export function parseRunArgs(
  argv: readonly string[],
  randomSeed: () => number = () => Math.floor(Math.random() * 2 ** 31),
): RunOptions {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        engines: { type: "string" },
        sessions: { type: "string" },
        concurrency: { type: "string" },
        scenario: { type: "string" },
        seed: { type: "string" },
        agent: { type: "string" },
        routing: { type: "string" },
        "session-timeout": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const routing = values.routing ?? "fixed";
  if (!(ROUTING_POLICIES as readonly string[]).includes(routing)) {
    throw new UsageError(
      `unknown routing "${routing}". Choose one of: ${ROUTING_POLICIES.join(", ")}`,
    );
  }
  const scenario = values.scenario ?? "mix";
  if (scenario !== "mix" && !(SCENARIO_NAMES as readonly string[]).includes(scenario)) {
    throw new UsageError(
      `unknown scenario "${scenario}". Choose one of: ${[...SCENARIO_NAMES, "mix"].join(", ")}`,
    );
  }
  if (values.seed !== undefined && !/^\d{1,10}$/.test(values.seed)) {
    throw new UsageError(`--seed must be a non-negative whole number, got "${values.seed}"`);
  }
  const agentId = values.agent?.trim() || defaultAgentId();
  if (!SAFE_LABEL_PATTERN.test(agentId)) {
    throw new UsageError(
      "--agent must be 1 to 128 characters from A-Z a-z 0-9 . _ : @ / + - (dashboards put it into SQL)",
    );
  }

  const sessions = positiveInt("sessions", values.sessions, 10, 100_000);
  return {
    engines: parseEngines(values.engines),
    sessions,
    concurrency: Math.min(positiveInt("concurrency", values.concurrency, 4, 64), sessions),
    scenario: scenario as RunOptions["scenario"],
    seed: values.seed === undefined ? randomSeed() : Number(values.seed),
    agentId,
    routing: routing as RoutingPolicy,
    sessionTimeoutMs: positiveInt("session-timeout", values["session-timeout"], 120, 3600) * 1000,
  };
}

export interface TrafficOptions extends RunOptions {
  /** Sessions started per minute. */
  ratePerMinute: number;
  /** Stop after this many ms; `undefined` runs until Ctrl+C. */
  durationMs: number | undefined;
}

/** `90s`, `10m`, `2h` (a bare number is seconds). */
export function parseDuration(raw: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(raw.trim());
  if (!match || Number(match[1]) < 1) {
    throw new UsageError(`--duration must look like 90s, 10m or 2h, got "${raw}"`);
  }
  const unit = { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "s" | "m" | "h"];
  return Number(match[1]) * unit;
}

export function defaultTrafficAgentId(host: string = hostname()): string {
  return `traffic@${host.replace(/[^A-Za-z0-9._:@/+-]/g, "_")}`.slice(0, 128);
}

/** Parses the arguments after `traffic`. */
export function parseTrafficArgs(
  argv: readonly string[],
  randomSeed: () => number = () => Math.floor(Math.random() * 2 ** 31),
): TrafficOptions {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        engines: { type: "string" },
        rate: { type: "string" },
        concurrency: { type: "string" },
        duration: { type: "string" },
        scenario: { type: "string" },
        seed: { type: "string" },
        agent: { type: "string" },
        routing: { type: "string" },
        "session-timeout": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  // Same checks as `run` for everything they share; sessions is a placeholder, traffic has no count.
  const shared = parseRunArgs(
    [
      ...(values.engines !== undefined ? ["--engines", values.engines] : []),
      ...(values.concurrency !== undefined ? ["--concurrency", values.concurrency] : []),
      ...(values.scenario !== undefined ? ["--scenario", values.scenario] : []),
      ...(values.seed !== undefined ? ["--seed", values.seed] : []),
      ...(values.routing !== undefined ? ["--routing", values.routing] : []),
      ...(values["session-timeout"] !== undefined
        ? ["--session-timeout", values["session-timeout"]]
        : []),
      "--agent",
      values.agent?.trim() || defaultTrafficAgentId(),
      "--sessions",
      "64",
    ],
    randomSeed,
  );
  return {
    ...shared,
    concurrency: values.concurrency === undefined ? 2 : shared.concurrency,
    sessions: Number.MAX_SAFE_INTEGER,
    ratePerMinute: positiveInt("rate", values.rate, 3, 600),
    durationMs: values.duration === undefined ? undefined : parseDuration(values.duration),
  };
}
