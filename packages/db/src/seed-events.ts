import { randomUUID } from "node:crypto";
import { type Engine, EventBatch, type FleetEvent } from "@fleetscope/schema";

/** Every seeded session id starts with this, so re-seeding can remove the previous run. */
export const SEED_SESSION_PREFIX = "seed-";

interface SeedSession {
  id: string;
  engine: Engine;
  engineVersion: string | null;
  status: "success" | "failed" | "blocked";
  /** js_heap_mb is null for engines without CDP Performance support (honest "not available"). */
  jsHeapMb: number | null;
  issue?: { kind: "captcha" | "unsupported_api" | "blocked"; message: string };
}

const SESSIONS: SeedSession[] = [
  {
    id: "seed-chromium-1",
    engine: "chromium",
    engineVersion: "141.0",
    status: "success",
    jsHeapMb: 38.5,
  },
  {
    id: "seed-headless-1",
    engine: "chrome-headless-shell",
    engineVersion: "141.0",
    status: "blocked",
    jsHeapMb: 31.25,
    issue: { kind: "captcha", message: "Captcha challenge on /checkout" },
  },
  {
    id: "seed-lightpanda-1",
    engine: "lightpanda",
    engineVersion: null,
    status: "failed",
    jsHeapMb: null,
    issue: { kind: "unsupported_api", message: "IntersectionObserver is not implemented" },
  },
];

/**
 * A handful of simulated events (source "sim") ending about a minute before `now`.
 * Validated with the shared schema, so a schema change breaks the seed loudly.
 */
export function buildSeedEvents(now = Date.now()): FleetEvent[] {
  const events: FleetEvent[] = [];

  SESSIONS.forEach((session, index) => {
    const start = now - 5 * 60_000 + index * 60_000;
    const base = {
      v: 1 as const,
      session_id: session.id,
      source: "sim" as const,
      agent_id: `seed-agent-${index + 1}`,
      engine: session.engine,
      provider: "local-docker",
    };
    const id = () => randomUUID();

    events.push({
      ...base,
      event_id: id(),
      ts: start,
      type: "session.started",
      engine_version: session.engineVersion,
      scenario: "checkout",
      region: "eu-west",
      startup_ms: 300 + index * 150,
      connect_ms: 40,
    });

    ["goto", "click", "extract"].forEach((actionType, seq) => {
      const failed = session.status === "failed" && seq === 2;
      events.push({
        ...base,
        event_id: id(),
        ts: start + 1000 + seq * 1500,
        type: "action",
        seq,
        action_type: actionType as "goto" | "click" | "extract",
        target: seq === 0 ? "demo.fleetscope.test" : "#buy",
        duration_ms: 200 + seq * 80,
        ok: !failed,
        error_code: failed ? "unsupported_api" : null,
      });
    });

    [0, 1].forEach((n) => {
      events.push({
        ...base,
        event_id: id(),
        ts: start + 2000 + n * 2000,
        type: "resource.sample",
        cpu_pct: 10 + n * 5 + index,
        mem_mb: 120 + n * 10 + index * 40,
        net_rx_bytes: 50_000 * (n + 1),
        net_tx_bytes: 5_000 * (n + 1),
        js_heap_mb: session.jsHeapMb,
        origin: "cdp",
      });
    });

    events.push({
      ...base,
      event_id: id(),
      ts: start + 1200,
      type: "network.request",
      domain: "demo.fleetscope.test",
      status: 200,
      bytes: 18_000,
      duration_ms: 95,
      resource_type: "document",
    });
    events.push({
      ...base,
      event_id: id(),
      ts: start + 1800,
      type: "network.request",
      domain: "cdn.fleetscope.test",
      status: session.status === "blocked" ? 403 : 200,
      bytes: session.engine === "lightpanda" ? null : 64_000,
      duration_ms: 140,
      resource_type: "script",
    });

    if (session.issue) {
      events.push({
        ...base,
        event_id: id(),
        ts: start + 4000,
        type: "issue",
        kind: session.issue.kind,
        message: session.issue.message,
      });
    }

    events.push({
      ...base,
      event_id: id(),
      ts: start + 6000,
      type: "session.ended",
      status: session.status,
      reason: session.issue?.message ?? null,
      duration_ms: 6000,
    });
  });

  // Fails loudly if the fixtures drift from the schema.
  return EventBatch.parse(events);
}
