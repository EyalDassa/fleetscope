import { type EventEnvelope, type FleetEvent, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";
import { getSessionTimeline, getTimelineSession } from "./timeline";

let db: TestDatabase;
const T0 = Date.now() - 10 * 60_000;

const ctx = (session_id: string, engine: EventEnvelope["engine"] = "chromium"): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "timeline-test",
  engine,
  provider: "local-docker",
});

beforeAll(async () => {
  db = await createTestDatabase();
  const a = ctx("tl-a");
  const other = ctx("tl-other"); // same engine: its rows must not leak into tl-a
  const lp = ctx("tl-lp", "lightpanda");
  const routed = ctx("tl-routed", "chrome-headless-shell");
  const started: FleetEvent[] = [
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
      "session.started",
      other,
      { engine_version: "141.0", scenario: "x", region: "local", startup_ms: 1, connect_ms: 1 },
      T0,
    ),
    newEvent(
      "session.started",
      lp,
      { engine_version: null, scenario: "x", region: "local", startup_ms: 1, connect_ms: 1 },
      T0,
    ),
    newEvent(
      "session.started",
      routed,
      {
        engine_version: null,
        scenario: "heavy-page-crawl",
        region: "local",
        startup_ms: 1,
        connect_ms: 1,
        routed_from: "lightpanda",
      },
      T0,
    ),
  ];
  const rows: FleetEvent[] = [
    // inserted out of order on purpose: the timeline must come back sorted
    newEvent(
      "action",
      a,
      {
        seq: 1,
        action_type: "click",
        target: "#pay",
        duration_ms: 500,
        ok: false,
        error_code: "selector_not_found",
      },
      T0 + 2000,
    ),
    newEvent(
      "action",
      a,
      {
        seq: 0,
        action_type: "goto",
        target: "demo.test",
        duration_ms: 300,
        ok: true,
        error_code: null,
      },
      T0 + 1000,
    ),
    newEvent(
      "action",
      other,
      {
        seq: 0,
        action_type: "goto",
        target: "other.test",
        duration_ms: 1,
        ok: true,
        error_code: null,
      },
      T0 + 1000,
    ),
    newEvent(
      "resource.sample",
      a,
      { origin: "container", cpu_pct: 12.5, mem_mb: 210.5, net_rx_bytes: 5, net_tx_bytes: 6 },
      T0 + 1500,
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
        js_heap_mb: 38.25,
      },
      T0 + 1600,
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
        js_heap_mb: null,
      },
      T0 + 1700,
    ),
    newEvent(
      "network.request",
      a,
      { domain: "demo.test", status: 200, bytes: 1234, duration_ms: 80, resource_type: "document" },
      T0 + 1100,
    ),
    newEvent(
      "network.request",
      a,
      { domain: "cdn.test", status: null, bytes: null, duration_ms: 20, resource_type: "script" },
      T0 + 1200,
    ),
    newEvent("issue", a, { kind: "timeout", message: "waiting for #pay" }, T0 + 2600),
    newEvent("issue", other, { kind: "crash", message: "not mine" }, T0 + 2600),
  ];
  // sessions start in one flush and end in another, as in production
  await insertEvents(db.client, [...started, ...rows]);
  await insertEvents(db.client, [
    newEvent(
      "session.ended",
      a,
      { status: "failed", reason: "selector not found", duration_ms: 3000 },
      T0 + 3000,
    ),
  ]);
});

afterAll(async () => {
  await db.cleanup();
});

describe("getSessionTimeline", () => {
  it("returns null for a session that does not exist", async () => {
    expect(await getSessionTimeline(db.client, "no-such-session")).toBeNull();
    expect(await getTimelineSession(db.client, "no-such-session")).toBeNull();
  });

  it("returns the session, in its latest version", async () => {
    const timeline = await getSessionTimeline(db.client, "tl-a");
    expect(timeline?.session).toEqual({
      session_id: "tl-a",
      agent_id: "timeline-test",
      source: "real",
      engine: "chromium",
      engine_version: "141.0",
      provider: "local-docker",
      scenario: "checkout-form",
      region: "local",
      startup_ms: 900,
      connect_ms: 400,
      routed_from: null,
      target: "demo",
      site: "demo-site",
      status: "failed",
      started_at_ms: T0,
      ended_at_ms: T0 + 3000,
      duration_ms: 3000,
      reason: "selector not found",
    });
  });

  it("returns routed_from for a routed session, null for the others", async () => {
    expect((await getTimelineSession(db.client, "tl-routed"))?.routed_from).toBe("lightpanda");
    expect((await getTimelineSession(db.client, "tl-lp"))?.routed_from).toBeNull();
  });

  it("returns a session that is still running with null end fields", async () => {
    const { session } = (await getSessionTimeline(db.client, "tl-other")) ?? {};
    expect(session).toMatchObject({
      status: "running",
      ended_at_ms: null,
      duration_ms: null,
      reason: null,
    });
    expect((await getTimelineSession(db.client, "tl-lp"))?.engine_version).toBeNull();
  });

  it("returns its actions in order, as numbers and booleans", async () => {
    const timeline = await getSessionTimeline(db.client, "tl-a");
    expect(timeline?.actions).toEqual([
      {
        seq: 0,
        ts_ms: T0 + 1000,
        action_type: "goto",
        target: "demo.test",
        duration_ms: 300,
        ok: true,
        error_code: null,
      },
      {
        seq: 1,
        ts_ms: T0 + 2000,
        action_type: "click",
        target: "#pay",
        duration_ms: 500,
        ok: false,
        error_code: "selector_not_found",
      },
    ]);
  });

  it("returns container and cdp samples, with the null a sample could not measure", async () => {
    const timeline = await getSessionTimeline(db.client, "tl-a");
    expect(timeline?.samples).toEqual([
      { ts_ms: T0 + 1500, origin: "container", cpu_pct: 12.5, mem_mb: 210.5, js_heap_mb: null },
      { ts_ms: T0 + 1600, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: 38.25 },
      { ts_ms: T0 + 1700, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: null },
    ]);
  });

  it("returns network requests (status and bytes null where unknown) and issues", async () => {
    const timeline = await getSessionTimeline(db.client, "tl-a");
    expect(timeline?.requests).toEqual([
      {
        ts_ms: T0 + 1100,
        domain: "demo.test",
        status: 200,
        bytes: 1234,
        duration_ms: 80,
        resource_type: "document",
      },
      {
        ts_ms: T0 + 1200,
        domain: "cdn.test",
        status: null,
        bytes: null,
        duration_ms: 20,
        resource_type: "script",
      },
    ]);
    expect(timeline?.issues).toEqual([
      { ts_ms: T0 + 2600, kind: "timeout", message: "waiting for #pay" },
    ]);
    expect(timeline?.truncated).toEqual([]);
  });

  it("does not return rows of another session, even of the same engine", async () => {
    const timeline = await getSessionTimeline(db.client, "tl-a");
    expect(timeline?.actions.map((a) => a.target)).not.toContain("other.test");
    expect(timeline?.issues.map((i) => i.message)).not.toContain("not mine");
    const lp = await getSessionTimeline(db.client, "tl-lp");
    expect(lp?.actions).toEqual([]);
  });

  it("treats the id as data, never as SQL", async () => {
    for (const id of ["tl-a' OR '1'='1", "tl-a'; DROP TABLE sessions; --", "tl-%", "tl-_"]) {
      expect(await getSessionTimeline(db.client, id), id).toBeNull();
    }
    expect(await getSessionTimeline(db.client, "tl-a")).not.toBeNull(); // the table is still there
  });

  it("flags a table that has more rows than the limit and returns only the first rows", async () => {
    const timeline = await getSessionTimeline(db.client, "tl-a", { rowLimit: 1 });
    expect(timeline?.actions).toHaveLength(1);
    expect(timeline?.actions[0]?.seq).toBe(0);
    expect(timeline?.samples).toHaveLength(1);
    expect(timeline?.requests).toHaveLength(1);
    expect(timeline?.issues).toHaveLength(1); // exactly the limit: not truncated
    expect(timeline?.truncated.sort()).toEqual(["actions", "network_requests", "resource_samples"]);
  });
});
