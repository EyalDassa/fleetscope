import { hostname } from "node:os";
import type { Engine, FleetEvent } from "@fleetscope/schema";
import { generateSession, type SessionPlan } from "./generate";
import { type Profile, scenariosOf } from "./profile";
import { createRng, type Rng } from "./rng";

/** `10m`, `90s`, `2h`, `1500ms` as milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not a duration (examples: 90s, 10m, 2h)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  return Math.round(Number(match[1]) * unit);
}

/** `sim@<host>`, with the characters a safe label does not allow replaced (SAFE_LABEL_PATTERN). */
export function simAgentId(host: string = hostname()): string {
  const safe = host.replace(/[^A-Za-z0-9._:@/+-]/g, "-");
  return `sim@${safe}`.slice(0, 128);
}

/**
 * Which (engine, scenario) session number `index` is. Every scenario runs on every engine: the pairs
 * are dealt out in rounds, and each round is shuffled with the seed, so any N sessions are balanced
 * to within one round and no engine always gets the same scenario at the same position.
 */
export function pairFor(
  profile: Profile,
  engines: Engine[],
  seed: number,
  index: number,
): { engine: Engine; scenario: string } {
  const pairs = engines.flatMap((engine) =>
    scenariosOf(profile)
      .filter((scenario) => profile.engines[engine].scenarios[scenario])
      .map((scenario) => ({ engine, scenario })),
  );
  const round = Math.floor(index / pairs.length);
  const rng: Rng = createRng(seed ^ Math.imul(round + 1, 0x85ebca6b));
  const order = pairs.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return pairs[order[index % pairs.length] as number] as { engine: Engine; scenario: string };
}

export interface RunOptions {
  sessions: number;
  /** The timestamps are spread over the last `windowMs`. */
  windowMs: number;
  seed: number;
  now: number;
  engines: Engine[];
  agentId: string;
  provider?: string;
  stretch?: number;
}

/** Moves all events of one session earlier so that none is after `limit`. */
function keepBefore(events: FleetEvent[], limit: number): FleetEvent[] {
  const overshoot = Math.max(...events.map((e) => e.ts)) - limit;
  return overshoot > 0 ? events.map((e) => ({ ...e, ts: e.ts - overshoot })) : events;
}

/**
 * The events of a whole `run`, one array per session (started first, ended last). Sessions start at
 * evenly spaced moments, with some jitter, between `now - windowMs` and `now`; a session that would
 * end after `now` is moved earlier, so a backfill never has events in the future.
 */
export function planRun(profile: Profile, options: RunOptions): FleetEvent[][] {
  const rng = createRng(options.seed);
  const out: FleetEvent[][] = [];
  for (let index = 0; index < options.sessions; index++) {
    const { engine, scenario } = pairFor(profile, options.engines, options.seed, index);
    const slot = options.windowMs / options.sessions;
    const startMs = Math.round(options.now - options.windowMs + (index + rng.next()) * slot);
    const plan: SessionPlan = {
      engine,
      scenario,
      startMs,
      seed: options.seed,
      index,
      agentId: options.agentId,
      provider: options.provider ?? "local-docker",
      stretch: options.stretch,
    };
    out.push(keepBefore(generateSession(profile, plan), options.now));
  }
  return out;
}
