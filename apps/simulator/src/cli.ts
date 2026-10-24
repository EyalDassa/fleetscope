import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createClickHouseClient, loadDbConfig } from "@fleetscope/db";
import { ENGINES, type Engine, type FleetEvent } from "@fleetscope/schema";
import { buildProfile, readRawData } from "./calibrate";
import { generateSession } from "./generate";
import { pairFor, parseDuration, planRun, simAgentId } from "./plan";
import { batchEvents, batchSessions, postBatch } from "./post";
import { assertProfile, type Profile } from "./profile";

const PROFILE_PATH = new URL("./profile.json", import.meta.url);
const say = (text: string) => process.stdout.write(`${text}\n`);

const USAGE = `usage:
  pnpm sim run --sessions 500 [--duration 10m] [--seed N] [--engines a,b] [--stretch X]
      Posts 500 simulated sessions (source=sim) with timestamps spread over the last --duration
      (default 10m), as fast as the API takes them, in batches of at most 1000 events.
  pnpm sim live --rate <sessions per minute> [--seed N] [--engines a,b] [--stretch X]
      Runs until Ctrl+C: new sessions start at that rate and their events are sent as they happen.
  pnpm sim calibrate
      Rewrites src/profile.json from the real sessions in ClickHouse.
Environment: FLEETSCOPE_API_URL (default http://localhost:4000), CLICKHOUSE_* for calibrate.`;

async function loadProfile(): Promise<Profile> {
  return assertProfile(JSON.parse(await readFile(PROFILE_PATH, "utf8")));
}

function engineList(text: string | undefined): Engine[] {
  if (!text) return [...ENGINES];
  const names = text.split(",").map((s) => s.trim());
  for (const name of names) {
    if (!(ENGINES as readonly string[]).includes(name)) {
      throw new Error(`unknown engine "${name}" (choose from ${ENGINES.join(", ")})`);
    }
  }
  return names as Engine[];
}

const positive = (text: string | undefined, name: string, fallback?: number): number => {
  if (text === undefined) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
};

const seedOf = (text: string | undefined): number =>
  text === undefined ? Date.now() % 2 ** 31 : Math.trunc(positive(text, "seed"));

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      sessions: { type: "string" },
      duration: { type: "string" },
      seed: { type: "string" },
      engines: { type: "string" },
      stretch: { type: "string" },
    },
  });
  const sessions = Math.trunc(positive(values.sessions, "sessions"));
  const windowMs = parseDuration(values.duration ?? "10m");
  const seed = seedOf(values.seed);
  const apiUrl = process.env.FLEETSCOPE_API_URL ?? "http://localhost:4000";
  const profile = await loadProfile();
  const planned = planRun(profile, {
    sessions,
    windowMs,
    seed,
    now: Date.now(),
    engines: engineList(values.engines),
    agentId: simAgentId(),
    stretch: values.stretch ? positive(values.stretch, "stretch") : undefined,
  });
  const batches = batchSessions(planned);
  const total = planned.reduce((sum, s) => sum + s.length, 0);
  say(
    `sim run: ${sessions} sessions, ${total} events, ${batches.length} batches -> ${apiUrl} (seed ${seed})`,
  );
  let sent = 0;
  for (const batch of batches) {
    await postBatch(batch, { apiUrl });
    sent += batch.length;
  }
  const perEngine = new Map<string, number>();
  for (const events of planned) {
    const engine = (events[0] as FleetEvent).engine;
    perEngine.set(engine, (perEngine.get(engine) ?? 0) + 1);
  }
  say(
    `sim run: sent ${sent} events. sessions per engine: ${[...perEngine].map(([e, n]) => `${e} ${n}`).join(", ")}. window: last ${values.duration ?? "10m"}, source=sim`,
  );
  return 0;
}

/** Sends events whose time has come, once a second, until stopped; then sends what is left. */
async function live(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      rate: { type: "string" },
      seed: { type: "string" },
      engines: { type: "string" },
      stretch: { type: "string" },
    },
  });
  const perMinute = positive(values.rate, "rate");
  const seed = seedOf(values.seed);
  const apiUrl = process.env.FLEETSCOPE_API_URL ?? "http://localhost:4000";
  const profile = await loadProfile();
  const engines = engineList(values.engines);
  const stretch = values.stretch ? positive(values.stretch, "stretch") : undefined;
  const agentId = simAgentId();

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    say("sim live: stopping, sending the sessions in flight (Ctrl+C again to quit now)...");
  });

  say(`sim live: ${perMinute} sessions/min -> ${apiUrl} (seed ${seed}). Ctrl+C to stop.`);
  let pending: FleetEvent[] = [];
  let owed = 0;
  let index = 0;
  let sent = 0;
  let last = Date.now();
  const flush = async (all: boolean) => {
    const now = Date.now();
    const due = all ? pending : pending.filter((e) => e.ts <= now);
    if (due.length === 0) return;
    pending = all ? [] : pending.filter((e) => e.ts > now);
    due.sort((a, b) => a.ts - b.ts);
    for (const batch of batchEvents(due)) {
      try {
        await postBatch(batch, { apiUrl });
        sent += batch.length;
      } catch (error) {
        process.stderr.write(`sim live: ${String(error)}\n`);
      }
    }
  };
  while (!stopping) {
    const now = Date.now();
    owed += ((now - last) / 60_000) * perMinute;
    last = now;
    while (owed >= 1) {
      owed -= 1;
      const { engine, scenario } = pairFor(profile, engines, seed, index);
      pending.push(
        ...generateSession(profile, {
          engine,
          scenario,
          startMs: now,
          seed,
          index,
          agentId,
          provider: "local-docker",
          stretch,
        }),
      );
      index += 1;
    }
    await flush(false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await flush(true);
  say(`sim live: stopped after ${index} sessions, ${sent} events sent.`);
  return 0;
}

async function calibrate(): Promise<number> {
  const config = loadDbConfig();
  const client = createClickHouseClient(config);
  try {
    const profile = buildProfile(await readRawData(client));
    await writeFile(PROFILE_PATH, `${JSON.stringify(profile, null, 2)}\n`);
    for (const engine of ENGINES) {
      const e = profile.engines[engine];
      say(`${engine}: ${e.basis}${e.basis === "real" ? ` (${e.real_sessions} sessions)` : ""}`);
    }
    say(`wrote ${PROFILE_PATH.pathname.replace(/^\/(\w:)/, "$1")}`);
    return 0;
  } finally {
    await client.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") return await run(rest);
    if (command === "live") return await live(rest);
    if (command === "calibrate") return await calibrate();
  } catch (error) {
    process.stderr.write(
      `sim ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  say(USAGE);
  return command === undefined || command === "help" ? 0 : 2;
}

process.exitCode = await main(process.argv.slice(2));
