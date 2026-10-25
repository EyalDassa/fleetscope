import { randomUUID } from "node:crypto";
import {
  type ActionType,
  type EventEnvelope,
  type FleetEvent,
  ISSUE_FOR_CODE,
  newEvent,
  type SessionStatus,
} from "@fleetscope/schema";
import type { Profile, ProfileFailure, ProfileScenario } from "./profile";
import { createRng, type Rng, sampleDist, sampleInt, sessionSeed } from "./rng";

/**
 * Builds the events of one simulated session from the profile. Pure: the same inputs (profile,
 * engine, scenario, seed, index, start time) give the same events, apart from the `event_id`s and the `session_id`,
 * which are random (`newEvent` and `randomUUID`), so a repeated seed never reuses an id.
 */

/** Interval of the runner's container sampler. */
export const SAMPLE_INTERVAL_MS = 2000;

export interface SessionPlan {
  engine: EventEnvelope["engine"];
  scenario: string;
  /** `session.started` timestamp, epoch ms. */
  startMs: number;
  /** Seed of the whole run and the number of this session in it. */
  seed: number;
  index: number;
  agentId: string;
  provider: string;
  /** Multiplies the session duration (the thinking time between actions); 1 = as calibrated. */
  stretch?: number;
}

interface PlannedAction {
  type: ActionType;
  target: string;
  offsetMs: number;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
}

/** Picks one of the scenario's failures, or none, with the probabilities of the profile. */
function pickFailure(rng: Rng, scenario: ProfileScenario): ProfileFailure | undefined {
  let roll = rng.next();
  for (const failure of scenario.failures) {
    if (roll < failure.p) return failure;
    roll -= failure.p;
  }
  return undefined;
}

function planActions(rng: Rng, scenario: ProfileScenario, failure: ProfileFailure | undefined) {
  const queue: Array<Pick<PlannedAction, "type" | "target" | "durationMs">> = [];
  for (const step of scenario.steps) {
    const whole = Math.floor(step.per_session);
    const count = whole + (rng.chance(step.per_session - whole) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      queue.push({
        type: step.action_type,
        target: step.target,
        durationMs: sampleInt(rng, step.latency_ms, 1),
      });
    }
  }
  if (queue.length === 0) queue.push({ type: "goto", target: "localhost", durationMs: 100 });
  // A failure ends the session at that point: the failing action is the last one.
  const cut = failure
    ? Math.min(queue.length, Math.max(1, Math.round(failure.at * queue.length)))
    : queue.length;
  return queue.slice(0, cut);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function generateSession(profile: Profile, plan: SessionPlan): FleetEvent[] {
  const engine = profile.engines[plan.engine];
  const scenario = engine.scenarios[plan.scenario];
  if (!scenario) throw new Error(`no profile for ${plan.engine} / ${plan.scenario}`);
  const rng = createRng(sessionSeed(plan.seed, plan.index));
  const ctx: EventEnvelope = {
    // A fresh id every time: `sessions` replaces a row with the same id, so an id derived from the
    // seed would overwrite the sessions of an earlier run with the same seed (R-M3-04). The seed
    // still decides everything else.
    session_id: `sim-${randomUUID()}`,
    source: "sim",
    agent_id: plan.agentId,
    engine: plan.engine,
    provider: plan.provider,
  };
  const start = plan.startMs;
  const failure = pickFailure(rng, scenario);
  const queue = planActions(rng, scenario, failure);

  // Lay the actions out inside the session: what is left of the duration after the actions is
  // spread evenly as thinking time between them.
  const busyMs = queue.reduce((sum, a) => sum + a.durationMs, 0);
  const wanted = sampleInt(rng, scenario.duration_ms, 100) * (plan.stretch ?? 1);
  const fullDuration = Math.max(wanted, busyMs + 100);
  const durationMs = failure
    ? Math.max(busyMs + 50, Math.round(fullDuration * Math.max(failure.at, 0.1)))
    : fullDuration;
  const gap = Math.max(0, (durationMs - busyMs) / (queue.length + 1));
  let cursor = gap;
  const actions: PlannedAction[] = queue.map((a, seq) => {
    const isLastOfFailure = failure !== undefined && seq === queue.length - 1;
    const planned: PlannedAction = {
      ...a,
      offsetMs: Math.round(cursor),
      ok: !isLastOfFailure,
      errorCode: isLastOfFailure ? failure.error_code : null,
    };
    cursor += a.durationMs + gap;
    return planned;
  });
  const end = start + durationMs;

  const out: FleetEvent[] = [];
  out.push(
    newEvent(
      "session.started",
      ctx,
      {
        engine_version: engine.engine_version,
        scenario: plan.scenario,
        region: "local",
        startup_ms: sampleInt(rng, engine.startup_ms, 1),
        connect_ms: sampleInt(rng, engine.connect_ms, 1),
        // simulated sessions only ever visit the demo site (docs/adr/0007)
        target: "demo",
        site: "demo-site",
      },
      start,
    ),
  );

  actions.forEach((a, seq) => {
    out.push(
      newEvent(
        "action",
        ctx,
        {
          seq,
          action_type: a.type,
          target: a.target,
          duration_ms: a.durationMs,
          ok: a.ok,
          error_code: a.errorCode,
        },
        start + a.offsetMs,
      ),
    );
  });

  // The failing action also raises an issue, as the real runner does.
  const last = actions[actions.length - 1];
  const issueKind = failure ? ISSUE_FOR_CODE[failure.error_code] : null;
  if (last && failure && issueKind) {
    out.push(
      newEvent(
        "issue",
        ctx,
        { kind: issueKind, message: failure.reason },
        Math.min(end, start + last.offsetMs + last.durationMs),
      ),
    );
  }

  // Container samples every 2 s; memory climbs from the base to the peak as pages are loaded.
  const peak = Math.max(1, sampleDist(rng, scenario.peak_mem_mib));
  const base = peak * scenario.base_ratio;
  const pages = actions.filter((a) => a.type === "goto");
  const sampleTimes: number[] = [];
  for (let t = SAMPLE_INTERVAL_MS; t < durationMs; t += SAMPLE_INTERVAL_MS) sampleTimes.push(t);
  if (sampleTimes.length === 0) sampleTimes.push(Math.max(1, Math.round(durationMs / 2)));
  for (const t of sampleTimes) {
    const pagesDone = pages.filter((p) => p.offsetMs + p.durationMs <= t).length;
    const byPages = pages.length === 0 ? t / durationMs : pagesDone / pages.length;
    const progress = 0.7 * byPages + 0.3 * Math.min(1, t / durationMs);
    const busy = actions.some((a) => a.offsetMs <= t && t < a.offsetMs + a.durationMs);
    const rx = Math.round((busy ? 60_000 : 2_000) * (0.5 + rng.next()));
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        {
          origin: "container",
          cpu_pct: round1(sampleDist(rng, engine.cpu_pct) * (busy ? 1 : 0.3)),
          mem_mb: round1(
            Math.max(1, (base + (peak - base) * progress) * (1 + 0.02 * rng.normal())),
          ),
          net_rx_bytes: rx,
          net_tx_bytes: Math.round(rx * 0.1),
        },
        start + t,
      ),
    );
  }

  // JS heap (CDP), once after each page. An engine that cannot report it sends null, never a number.
  pages.forEach((page, i) => {
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        {
          origin: "cdp",
          cpu_pct: null,
          mem_mb: null,
          net_rx_bytes: null,
          net_tx_bytes: null,
          js_heap_mb: engine.heap_mb
            ? round1(sampleDist(rng, engine.heap_mb) * (1 + 0.08 * i))
            : null,
        },
        Math.min(end, start + page.offsetMs + page.durationMs),
      ),
    );
  });

  // Sampled network requests; `ts` is when the request finished.
  const net = scenario.network;
  const requests = Math.round(net.requests * (0.7 + 0.6 * rng.next()));
  const types = Object.entries(net.resource_types);
  const typeTotal = types.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  for (let i = 0; i < requests; i++) {
    let roll = rng.next() * typeTotal;
    let resourceType = types[0]?.[0] ?? "document";
    for (const [name, weight] of types) {
      if (roll < weight) {
        resourceType = name;
        break;
      }
      roll -= weight;
    }
    const duration = sampleInt(rng, net.duration_ms, 1);
    const finishedAt = Math.round(duration + rng.next() * durationMs);
    out.push(
      newEvent(
        "network.request",
        ctx,
        {
          domain: net.domain,
          status: rng.chance(0.97) ? 200 : 404,
          bytes: rng.chance(net.bytes_reported) ? sampleInt(rng, net.bytes) : null,
          duration_ms: duration,
          resource_type: resourceType,
        },
        start + Math.min(durationMs, finishedAt),
      ),
    );
  }

  // Time order; session.started has the earliest ts, session.ended is appended last.
  out.sort((a, b) => a.ts - b.ts);
  const status: SessionStatus = failure ? failure.status : "success";
  out.push(
    newEvent(
      "session.ended",
      ctx,
      { status, reason: failure ? failure.reason : null, duration_ms: durationMs },
      end,
    ),
  );
  return out;
}
