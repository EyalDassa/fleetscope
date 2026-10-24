import { getSessionTimeline, getTimelineSession, insertEvents } from "@fleetscope/db";
import { createTestDatabase, type TestDatabase } from "@fleetscope/db/testing";
import { ChromeTrace, type EventEnvelope, type FleetEvent, newEvent } from "@fleetscope/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * GET /v1/sessions/:id/trace and /perfetto against real ClickHouse (needs `pnpm infra:up`):
 * a seeded session goes in through insertEvents and comes out as a Chrome trace.
 */

let db: TestDatabase;
const T0 = Date.now() - 5 * 60_000;
const ID = "trace-int-1";
const SIM_ID = "trace-int-sim";

const ctx = (
  session_id: string,
  engine: EventEnvelope["engine"] = "chromium",
  source: EventEnvelope["source"] = "real",
): EventEnvelope => ({
  session_id,
  source,
  agent_id: "trace-test",
  engine,
  provider: "local-docker",
});

beforeAll(async () => {
  db = await createTestDatabase();
  const a = ctx(ID);
  const lp = ctx(SIM_ID, "lightpanda", "sim");
  const events: FleetEvent[] = [
    newEvent(
      "session.started",
      a,
      {
        engine_version: "141.0",
        scenario: "checkout-form",
        region: "local",
        startup_ms: 900,
        connect_ms: 400,
      },
      T0,
    ),
    newEvent(
      "action",
      a,
      {
        seq: 0,
        action_type: "goto",
        target: "demo.test/checkout",
        duration_ms: 300,
        ok: true,
        error_code: null,
      },
      T0 + 100,
    ),
    newEvent(
      "action",
      a,
      {
        seq: 1,
        action_type: "click",
        target: "#pay",
        duration_ms: 1500,
        ok: false,
        error_code: "selector_not_found",
      },
      T0 + 500,
    ),
    newEvent(
      "resource.sample",
      a,
      { origin: "container", cpu_pct: 41.5, mem_mb: 212, net_rx_bytes: 1, net_tx_bytes: 1 },
      T0 + 1000,
    ),
    newEvent(
      "resource.sample",
      a,
      { origin: "container", cpu_pct: 18, mem_mb: 220, net_rx_bytes: 1, net_tx_bytes: 1 },
      T0 + 3000,
    ),
    newEvent(
      "resource.sample",
      a,
      {
        origin: "cdp",
        cpu_pct: null,
        mem_mb: null,
        net_rx_bytes: null,
        net_tx_bytes: null,
        js_heap_mb: 36.5,
      },
      T0 + 2000,
    ),
    newEvent(
      "network.request",
      a,
      {
        domain: "demo.test",
        status: 200,
        bytes: 2048,
        duration_ms: 120,
        resource_type: "document",
      },
      T0 + 400,
    ),
    newEvent("issue", a, { kind: "timeout", message: "waiting for #pay" }, T0 + 2100),
    // a simulated Lightpanda session whose engine reports no JS heap
    newEvent(
      "session.started",
      lp,
      { engine_version: null, scenario: "x", region: "local", startup_ms: 5, connect_ms: 5 },
      T0,
    ),
    newEvent(
      "resource.sample",
      lp,
      {
        origin: "cdp",
        cpu_pct: null,
        mem_mb: null,
        net_rx_bytes: null,
        net_tx_bytes: null,
        js_heap_mb: null,
      },
      T0 + 1000,
    ),
  ];
  await insertEvents(db.client, events);
  await insertEvents(db.client, [
    newEvent(
      "session.ended",
      a,
      { status: "failed", reason: "selector not found", duration_ms: 2100 },
      T0 + 2100,
    ),
  ]);
});
afterAll(async () => {
  await db.cleanup();
});

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
function app() {
  const instance = buildApp({
    logLevel: false,
    ping: async () => true,
    getSessionTimeline: (id) => getSessionTimeline(db.client, id),
    getSession: (id) => getTimelineSession(db.client, id),
  });
  apps.push(instance);
  return instance;
}

describe("GET /v1/sessions/:id/trace (real ClickHouse)", () => {
  it("returns the stored session as a valid Chrome trace", async () => {
    const res = await app().inject({ method: "GET", url: `/v1/sessions/${ID}/trace` });
    expect(res.statusCode).toBe(200);
    const trace = ChromeTrace.parse(res.json());

    const process = trace.traceEvents.find((e) => e.ph === "M" && e.name === "process_name");
    expect(process?.args.name).toBe(`${ID} · chromium 141.0 · REAL · Failed`);

    const slices = trace.traceEvents.filter((e) => e.ph === "X");
    expect(slices.map((e) => [e.name, e.ts, e.dur])).toEqual([
      ["goto demo.test/checkout", 100_000, 300_000],
      ["✕ click #pay", 500_000, 1_500_000],
      ["document demo.test", 280_000, 120_000], // stamped at +400 ms, took 120 ms
    ]);
  });

  it("has the counter tracks, from the container samples and the cdp sample", async () => {
    const trace = ChromeTrace.parse(
      (await app().inject({ method: "GET", url: `/v1/sessions/${ID}/trace` })).json(),
    );
    const counters = trace.traceEvents.filter((e) => e.ph === "C");
    const series = (name: string) =>
      counters.filter((e) => e.name === name).map((e) => [e.ts, Object.values(e.args)[0]]);
    expect(series("CPU")).toEqual([
      [1_000_000, 41.5],
      [3_000_000, 18],
    ]);
    expect(series("memory")).toEqual([
      [1_000_000, 212],
      [3_000_000, 220],
    ]);
    expect(series("JS heap")).toEqual([[2_000_000, 36.5]]);
  });

  it("has the issue and the session markers", async () => {
    const trace = ChromeTrace.parse(
      (await app().inject({ method: "GET", url: `/v1/sessions/${ID}/trace` })).json(),
    );
    const instants = trace.traceEvents
      .filter((e) => e.ph === "i")
      .map((e) => [e.name, e.ts, e.tid]);
    expect(instants).toContainEqual(["timeout", 2_100_000, 3]);
    expect(instants).toContainEqual(["session started", 0, 4]);
    expect(instants).toContainEqual(["session ended", 2_100_000, 4]);
  });

  it("says so, instead of faking a track, when the engine reports no JS heap", async () => {
    const trace = ChromeTrace.parse(
      (await app().inject({ method: "GET", url: `/v1/sessions/${SIM_ID}/trace` })).json(),
    );
    expect(trace.traceEvents.filter((e) => e.ph === "C")).toEqual([]);
    expect(
      trace.traceEvents.some(
        (e) => e.ph === "i" && e.name === "note: JS heap not available (engine reports null)",
      ),
    ).toBe(true);
    const process = trace.traceEvents.find((e) => e.ph === "M" && e.name === "process_name");
    expect(process?.args.name).toBe(`${SIM_ID} · lightpanda · SIM · Running`);
  });

  it("returns 404 for an unknown session and treats a hostile id as plain data", async () => {
    const instance = app();
    for (const id of ["nope", "x' OR 1=1 --", "trace-int-%"]) {
      const res = await instance.inject({
        method: "GET",
        url: `/v1/sessions/${encodeURIComponent(id)}/trace`,
      });
      expect(res.statusCode, id).toBe(404);
    }
  });
});

describe("GET /v1/sessions/:id/perfetto (real ClickHouse)", () => {
  it("serves the page for a stored session", async () => {
    const res = await app().inject({ method: "GET", url: `/v1/sessions/${ID}/perfetto` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(ID);
    expect(res.body).toContain("failed (selector not found)");
    expect(res.body).toContain("'PING'");
    expect(res.body).toContain("'PONG'");
  });

  it("serves a 404 page for an unknown session", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/sessions/nope/perfetto" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Session not found");
  });
});
