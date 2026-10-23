import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { ENGINES, type Engine } from "@fleetscope/schema";
import { SCENARIO_NAMES, type ScenarioName } from "./scenarios";

/** Engines the runner can drive today. M3 adds the other two. */
export const SUPPORTED_ENGINES = ["chromium"] as const satisfies readonly Engine[];

export interface RunOptions {
  engines: Engine[];
  sessions: number;
  concurrency: number;
  scenario: ScenarioName | "mix";
  seed: number;
  agentId: string;
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
  pnpm fleet cleanup           remove leftover containers labelled fleetscope.session

Options for "run":
  --engines <list>          comma-separated, default chromium (only chromium for now)
  --sessions <n>            number of sessions, default 10
  --concurrency <n>         containers alive at the same time, default 4
  --scenario <name>         ${[...SCENARIO_NAMES, "mix"].join(" | ")}, default mix
  --seed <n>                makes the scenario choice and the chaos repeatable (default: random, printed)
  --agent <id>              agent_id on every event, default fleet-runner@<hostname>
  --session-timeout <sec>   cut off a session that runs longer, default 120

Environment: FLEETSCOPE_API_URL, DEMO_SITE_URL, FLEET_BROWSER_IMAGE, DOCKER_HOST, LOG_LEVEL`;

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
    if (!(SUPPORTED_ENGINES as readonly string[]).includes(name)) {
      throw new UsageError(
        `engine "${name}" is not supported by the runner yet (only ${SUPPORTED_ENGINES.join(", ")}; the other engines arrive in M3)`,
      );
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
        "session-timeout": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
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
  const agentId = values.agent?.trim() || `fleet-runner@${hostname()}`;
  if (agentId.length > 128) throw new UsageError("--agent must be at most 128 characters");

  const sessions = positiveInt("sessions", values.sessions, 10, 100_000);
  return {
    engines: parseEngines(values.engines),
    sessions,
    concurrency: Math.min(positiveInt("concurrency", values.concurrency, 4, 64), sessions),
    scenario: scenario as RunOptions["scenario"],
    seed: values.seed === undefined ? randomSeed() : Number(values.seed),
    agentId,
    sessionTimeoutMs: positiveInt("session-timeout", values["session-timeout"], 120, 3600) * 1000,
  };
}
