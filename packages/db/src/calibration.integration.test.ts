import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCalibrationData } from "./calibration";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
const DAY = 86_400_000;

const session = (
  id: string,
  opts: {
    source?: "real" | "sim";
    ageMs: number;
    status?: "success" | "failed";
    reason?: string | null;
    end?: boolean;
  },
) => {
  const ctx: EventEnvelope = {
    session_id: id,
    source: opts.source ?? "real",
    agent_id: "cal-test",
    engine: "lightpanda",
    provider: "local-docker",
  };
  const t = Date.now() - opts.ageMs;
  return [
    newEvent(
      "session.started",
      ctx,
      { engine_version: "1.0.2", scenario: "login", region: "local", startup_ms: 5, connect_ms: 6 },
      t,
    ),
    newEvent(
      "action",
      ctx,
      { seq: 0, action_type: "goto", target: "x", duration_ms: 7, ok: true, error_code: null },
      t + 100,
    ),
    newEvent(
      "resource.sample",
      ctx,
      { origin: "container", cpu_pct: 3, mem_mb: 20, net_rx_bytes: 1, net_tx_bytes: 1 },
      t + 200,
    ),
    ...(opts.end === false
      ? []
      : [
          newEvent(
            "session.ended",
            ctx,
            { status: opts.status ?? "success", reason: opts.reason ?? null, duration_ms: 1000 },
            t + 1000,
          ),
        ]),
  ];
};

beforeAll(async () => {
  db = await createTestDatabase();
  await insertEvents(db.client, [
    ...session("real-new", { ageMs: 2 * 60_000 }),
    ...session("real-old", { ageMs: 20 * DAY }),
    ...session("sim-new", { source: "sim", ageMs: 2 * 60_000 }),
    ...session("int", { ageMs: 2 * 60_000, status: "failed", reason: "interrupted" }),
    ...session("run", { ageMs: 2 * 60_000, end: false }),
  ]);
});
afterAll(async () => {
  await db.cleanup();
});

describe("readCalibrationData", () => {
  it("reads only finished, real, non-interrupted sessions of the last days (default 14)", async () => {
    const data = await readCalibrationData(db.client);
    expect(data.sessions.map((s) => s.session_id)).toEqual(["real-new"]);
    expect(data.sessions[0]).toMatchObject({
      engine: "lightpanda",
      engine_version: "1.0.2",
      startup_ms: 5,
      duration_ms: 1000,
    });
    expect(data.actions.map((a) => a.session_id)).toEqual(["real-new"]);
    expect(data.samples.map((a) => a.session_id)).toEqual(["real-new"]);
  });

  it("the window is a parameter: 30 days also reads the 20 day old session", async () => {
    const data = await readCalibrationData(db.client, { days: 30 });
    expect(data.sessions.map((s) => s.session_id).sort()).toEqual(["real-new", "real-old"]);
  });
});
