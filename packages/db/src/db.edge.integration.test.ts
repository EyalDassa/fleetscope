import { randomUUID } from "node:crypto";
import {
  ActionEvent,
  FleetEvent,
  IssueEvent,
  NetworkRequestEvent,
  ResourceSampleEvent,
  SessionEndedEvent,
  SessionStartedEvent,
  TS_MAX_EXCLUSIVE,
  TS_MIN,
} from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "./client";
import { insertEvents } from "./insert";
import { runMigrations } from "./migrate";
import { seed } from "./seed";
import { buildSeedEvents } from "./seed-events";
import { createTestDatabase, dropDatabase, type TestDatabase } from "./testing";

/**
 * QA edge cases against a real ClickHouse (M0). Each describe block uses its own session ids, so
 * the blocks do not see each other's rows. Fixture timestamps are always "now", because the raw
 * tables drop rows older than 30 days at insert time (TTL).
 *
 * Bugs from the first QA pass are tagged "QA-M0-NN" in test names (see qa/m0-report.md). All fixed
 * ones are ordinary tests now; deferred ones (QA-M0-03, -06, -09) are M1 items.
 */

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

const DAY = 86_400_000;

async function rows<T>(query: string): Promise<T[]> {
  const result = await db.client.query({ query, format: "JSONEachRow" });
  return result.json<T>();
}
async function count(table: string, sessionPrefix: string): Promise<number> {
  const [row] = await rows<{ n: string }>(
    `SELECT count() AS n FROM ${table} WHERE startsWith(session_id, '${sessionPrefix}')`,
  );
  return Number(row?.n);
}

const envelope = (session_id: string, ts = Date.now()) => ({
  v: 1 as const,
  event_id: randomUUID(),
  ts,
  session_id,
  source: "real" as const,
  agent_id: "qa-agent",
  engine: "chromium" as const,
  provider: "local-docker",
});

function action(session_id: string, extra: Record<string, unknown> = {}): FleetEvent {
  return {
    ...envelope(session_id),
    type: "action",
    seq: 0,
    action_type: "goto",
    target: "example.com",
    duration_ms: 10,
    ok: true,
    error_code: null,
    ...extra,
  } as FleetEvent;
}
function started(session_id: string, extra: Record<string, unknown> = {}): FleetEvent {
  return {
    ...envelope(session_id),
    type: "session.started",
    engine_version: null,
    scenario: "qa",
    region: "local",
    startup_ms: 10,
    connect_ms: 5,
    ...extra,
  } as FleetEvent;
}
function ended(session_id: string, extra: Record<string, unknown> = {}): FleetEvent {
  return {
    ...envelope(session_id),
    type: "session.ended",
    status: "success",
    reason: null,
    duration_ms: 100,
    ...extra,
  } as FleetEvent;
}
function issue(session_id: string, extra: Record<string, unknown> = {}): FleetEvent {
  return {
    ...envelope(session_id),
    type: "issue",
    kind: "blocked",
    message: "m",
    ...extra,
  } as FleetEvent;
}
function sample(session_id: string, extra: Record<string, unknown> = {}): FleetEvent {
  return {
    ...envelope(session_id),
    type: "resource.sample",
    cpu_pct: 1,
    mem_mb: 2,
    net_rx_bytes: 3,
    net_tx_bytes: 4,
    origin: "container",
    ...extra,
  } as FleetEvent;
}

describe("schema and tables agree (contract)", () => {
  async function columns(table: string): Promise<string[]> {
    const result = await rows<{ name: string }>(
      `SELECT name FROM system.columns WHERE database = currentDatabase() AND table = '${table}'`,
    );
    return result.map((r) => r.name);
  }
  const eventFields = (shape: Record<string, unknown>) =>
    Object.keys(shape).filter((key) => key !== "v" && key !== "type");

  it.each([
    ["actions", ActionEvent],
    ["resource_samples", ResourceSampleEvent],
    ["network_requests", NetworkRequestEvent],
    ["issues", IssueEvent],
  ] as const)("every %s event field has a column of the same name", async (table, schema) => {
    const have = await columns(table);
    for (const field of eventFields(schema.shape)) {
      expect(have, `${table}.${field}`).toContain(field);
    }
  });

  it("sessions has a column for every session.started and session.ended field", async () => {
    const have = await columns("sessions");
    const startedFields = eventFields(SessionStartedEvent.shape).map((f) =>
      f === "ts" ? "started_at" : f,
    );
    const endedFields = eventFields(SessionEndedEvent.shape).filter(
      (f) => !["ts", "event_id"].includes(f),
    );
    for (const field of [...startedFields.filter((f) => f !== "event_id"), ...endedFields]) {
      expect(have, `sessions.${field}`).toContain(field);
    }
    expect(have).toEqual(expect.arrayContaining(["ended_at", "version"]));
  });
});

describe("round trip: every event type comes back as it went in", () => {
  it("stores values, nulls and booleans exactly", async () => {
    const ts = Math.floor(Date.now() / 1000) * 1000 + 7;
    const sid = "rt-all";
    await insertEvents(db.client, [
      { ...started(sid, { engine_version: "141.0.1", startup_ms: 321 }), ts } as FleetEvent,
      { ...action(sid, { ok: false, error_code: "timeout", seq: 4 }), ts: ts + 1 } as FleetEvent,
      {
        ...sample(sid, {
          origin: "cdp",
          cpu_pct: 12.5,
          mem_mb: 256.25,
          net_rx_bytes: 4_000_000_000,
          js_heap_mb: null,
        }),
        ts: ts + 2,
      } as FleetEvent,
      {
        ...envelope(sid, ts + 3),
        type: "network.request",
        domain: "example.com",
        status: null,
        bytes: null,
        duration_ms: 12,
        resource_type: "xhr",
      } as FleetEvent,
      ended(sid, { status: "timeout", reason: "idle", duration_ms: 99, ts: ts + 100 }),
    ]);

    const [session] = await rows<Record<string, unknown>>(
      `SELECT status, engine_version, startup_ms, reason, duration_ms, version,
              toUnixTimestamp64Milli(started_at) AS started_ms, toUnixTimestamp64Milli(ended_at) AS ended_ms
       FROM sessions FINAL WHERE session_id = '${sid}'`,
    );
    expect(session).toMatchObject({
      status: "timeout",
      engine_version: "141.0.1",
      startup_ms: 321,
      reason: "idle",
      duration_ms: 99,
      version: 2,
    });
    expect(Number(session?.started_ms)).toBe(ts);
    expect(Number(session?.ended_ms)).toBe(ts + 100);

    const [act] = await rows<Record<string, unknown>>(
      `SELECT ok, error_code, seq FROM actions WHERE session_id = '${sid}'`,
    );
    expect(act).toEqual({ ok: false, error_code: "timeout", seq: 4 });

    const [res] = await rows<Record<string, unknown>>(
      `SELECT cpu_pct, mem_mb, toString(net_rx_bytes) AS rx, js_heap_mb, origin FROM resource_samples WHERE session_id = '${sid}'`,
    );
    expect(res).toEqual({
      cpu_pct: 12.5,
      mem_mb: 256.25,
      rx: "4000000000",
      js_heap_mb: null,
      origin: "cdp",
    });

    const [net] = await rows<Record<string, unknown>>(
      `SELECT status, bytes FROM network_requests WHERE session_id = '${sid}'`,
    );
    expect(net).toEqual({ status: null, bytes: null });
  });

  it("stores an engine_version that was never reported as NULL, not as an empty string", async () => {
    await insertEvents(db.client, [started("rt-nullver")]);
    const [row] = await rows<{ v: string | null }>(
      "SELECT engine_version AS v FROM sessions FINAL WHERE session_id = 'rt-nullver'",
    );
    expect(row?.v).toBeNull();
  });

  it("stores a js_heap_mb of 0 as 0 and an omitted one as NULL", async () => {
    await insertEvents(db.client, [
      sample("rt-heap", { js_heap_mb: 0, origin: "cdp" }),
      sample("rt-heap", { origin: "container" }),
    ]);
    const result = await rows<{ origin: string; js_heap_mb: number | null }>(
      "SELECT origin, js_heap_mb FROM resource_samples WHERE session_id = 'rt-heap' ORDER BY origin",
    );
    expect(result).toEqual([
      { origin: "cdp", js_heap_mb: 0 },
      { origin: "container", js_heap_mb: null },
    ]);
  });

  it("does not store screenshot events anywhere and reports them as skipped", async () => {
    const counts = await insertEvents(db.client, [
      { ...envelope("rt-shot"), type: "screenshot", action_seq: 0 } as FleetEvent,
    ]);
    expect(counts.skipped).toBe(1);
    expect(await count("actions", "rt-shot")).toBe(0);
  });
});

describe("duplicate event_id (M1 owns dedupe)", () => {
  // Recorded behaviour, severity minor (QA-M0-09). When M1 adds dedupe this test must change:
  // expect 1 row.
  it("stores both rows when the same event is sent twice in one batch", async () => {
    const event = action("dup-same-batch");
    const counts = await insertEvents(db.client, [event, event]);
    expect(counts.actions).toBe(2);
    expect(await count("actions", "dup-same-batch")).toBe(2);
  });

  it("stores both rows when a batch is retried (client retry after a timeout)", async () => {
    const batch = [action("dup-retry"), issue("dup-retry")];
    await insertEvents(db.client, batch);
    await insertEvents(db.client, batch);
    expect(await count("actions", "dup-retry")).toBe(2);
    expect(await count("issues", "dup-retry")).toBe(2);
  });

  it("is harmless for sessions: a retried started + ended keeps ONE finished row", async () => {
    const batch = [started("dup-sess"), ended("dup-sess")];
    await insertEvents(db.client, batch);
    await insertEvents(db.client, batch);
    const result = await rows<{ status: string; version: number }>(
      "SELECT status, version FROM sessions FINAL WHERE session_id = 'dup-sess'",
    );
    expect(result).toEqual([{ status: "success", version: 2 }]);
  });
});

describe("session ordering", () => {
  it("merges session.ended and session.started even when ended comes first in the batch", async () => {
    const t = Date.now();
    await insertEvents(db.client, [
      ended("ord-same", { ts: t + 50, status: "failed", reason: "boom" }),
      started("ord-same", { ts: t }),
    ]);
    const [row] = await rows<{ status: string; scenario: string; reason: string }>(
      "SELECT status, scenario, reason FROM sessions FINAL WHERE session_id = 'ord-same'",
    );
    expect(row).toEqual({ status: "failed", scenario: "qa", reason: "boom" });
  });

  it("a retried session.started arriving after session.ended does not reopen the session", async () => {
    const start = started("ord-retry");
    await insertEvents(db.client, [start]);
    await insertEvents(db.client, [ended("ord-retry")]);
    await insertEvents(db.client, [start]);
    const [row] = await rows<{ status: string }>(
      "SELECT status FROM sessions FINAL WHERE session_id = 'ord-retry'",
    );
    expect(row?.status).toBe("success");
  });

  it("with two session.ended events for one session in a batch, the last one wins", async () => {
    await insertEvents(db.client, [
      started("ord-two"),
      ended("ord-two", { status: "failed" }),
      ended("ord-two", { status: "success" }),
    ]);
    const [row] = await rows<{ status: string }>(
      "SELECT status FROM sessions FINAL WHERE session_id = 'ord-two'",
    );
    expect(row?.status).toBe("success");
  });

  it("copies the engine from session.started when the ended event disagrees", async () => {
    await insertEvents(db.client, [
      started("ord-engine", { engine: "lightpanda" }),
      ended("ord-engine", { engine: "chromium" }),
    ]);
    const [row] = await rows<{ engine: string }>(
      "SELECT engine FROM sessions FINAL WHERE session_id = 'ord-engine'",
    );
    expect(row?.engine).toBe("lightpanda");
  });

  it("stores an ended_at before started_at as given (no validation; negative runtime is possible)", async () => {
    const t = Date.now();
    await insertEvents(db.client, [
      started("ord-skew", { ts: t }),
      ended("ord-skew", { ts: t - 10_000 }),
    ]);
    const [row] = await rows<{ diff: string }>(
      "SELECT dateDiff('millisecond', started_at, ended_at) AS diff FROM sessions FINAL WHERE session_id = 'ord-skew'",
    );
    expect(Number(row?.diff)).toBe(-10_000);
  });

  // QA-M0-06 (minor in M0, must be settled before M1 ingest). An end that arrives in an EARLIER
  // batch than its start is counted as orphaned and thrown away; the later start then leaves the
  // session "running" forever. With client retries and several collectors, that order is possible.
  // This test records today's behaviour; the correct behaviour is for the session to end up
  // "success" (flip the expectation when fixed).
  it("loses a session.ended that arrives in an earlier batch than its session.started", async () => {
    const first = await insertEvents(db.client, [ended("ord-late")]);
    expect(first.orphanedEnds).toBe(1);
    await insertEvents(db.client, [started("ord-late")]);
    const [row] = await rows<{ status: string }>(
      "SELECT status FROM sessions FINAL WHERE session_id = 'ord-late'",
    );
    expect(row?.status).toBe("running");
  });
});

describe("timestamps: TTL, clock skew, millisecond precision", () => {
  it("keeps rows from 29 days ago and drops rows older than 30 days at insert", async () => {
    await insertEvents(db.client, [
      action("ttl-29d", { ts: Date.now() - 29 * DAY }),
      action("ttl-31d", { ts: Date.now() - 31 * DAY }),
      action("ttl-epoch", { ts: 0 }),
    ]);
    expect(await count("actions", "ttl-29d")).toBe(1);
    expect(await count("actions", "ttl-31d")).toBe(0);
    expect(await count("actions", "ttl-epoch")).toBe(0);
  });

  it("applies the same 30 day TTL to sessions (by started_at) and keeps a recent session", async () => {
    await insertEvents(db.client, [
      started("ttl-sess-29d", { ts: Date.now() - 29 * DAY }),
      started("ttl-sess-31d", { ts: Date.now() - 31 * DAY }),
      started("ttl-sess-90d", { ts: Date.now() - 90 * DAY }),
    ]);
    expect(await count("sessions", "ttl-sess-29d")).toBe(1);
    expect(await count("sessions", "ttl-sess-31d")).toBe(0);
    expect(await count("sessions", "ttl-sess-90d")).toBe(0);
  });

  it("partitions sessions by the day of started_at and drops whole parts on TTL, on all five tables", async () => {
    const tables = await rows<{ name: string; partition_key: string; engine_full: string }>(
      `SELECT name, partition_key, engine_full FROM system.tables
       WHERE database = currentDatabase() AND name IN ('sessions','actions','resource_samples','network_requests','issues')`,
    );
    expect(tables).toHaveLength(5);
    for (const table of tables) {
      expect(table.engine_full, table.name).toContain("ttl_only_drop_parts = 1");
      expect(table.engine_full, table.name).toContain("toIntervalDay(30)");
    }
    expect(tables.find((t) => t.name === "sessions")?.partition_key).toBe("toDate(started_at)");
  });

  it("a session closed by a later batch stays ONE row after merging (both versions share a partition)", async () => {
    const t = Date.now() - 2 * DAY;
    await insertEvents(db.client, [started("ttl-merge", { ts: t })]);
    await insertEvents(db.client, [ended("ttl-merge", { ts: t + 1000 })]);
    await db.client.command({ query: "OPTIMIZE TABLE sessions FINAL" });
    // No FINAL here: after a full merge the old running version must be physically gone.
    const result = await rows<{ status: string; version: number }>(
      "SELECT status, version FROM sessions WHERE session_id = 'ttl-merge'",
    );
    expect(result).toEqual([{ status: "success", version: 2 }]);
  });

  it("reports TTL-dropped rows in InsertCounts as if they were stored (counts rows sent, not stored)", async () => {
    const counts = await insertEvents(db.client, [
      action("ttl-count", { ts: Date.now() - 60 * DAY }),
    ]);
    expect(counts.actions).toBe(1);
    expect(await count("actions", "ttl-count")).toBe(0);
  });

  it("stores events with a ts in the future as given (clock skew is not corrected)", async () => {
    const future = Date.now() + 365 * DAY;
    await insertEvents(db.client, [action("skew-future", { ts: future })]);
    const [row] = await rows<{ ms: string }>(
      "SELECT toUnixTimestamp64Milli(ts) AS ms FROM actions WHERE session_id = 'skew-future'",
    );
    expect(Number(row?.ms)).toBe(future);
  });

  it("keeps events 5 minutes in the future and 5 minutes in the past in the right order", async () => {
    const now = Date.now();
    await insertEvents(db.client, [
      action("skew-order", { ts: now + 5 * 60_000, seq: 2 }),
      action("skew-order", { ts: now - 5 * 60_000, seq: 0 }),
      action("skew-order", { ts: now, seq: 1 }),
    ]);
    const result = await rows<{ seq: number }>(
      "SELECT seq FROM actions WHERE session_id = 'skew-order' ORDER BY ts",
    );
    expect(result.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it("stores the last representable instant, 9999-12-31 23:59:59.999", async () => {
    await insertEvents(db.client, [action("ts-y9999", { ts: 253_402_300_799_999 })]);
    expect(await count("actions", "ts-y9999")).toBe(1);
  });

  it("keeps exact milliseconds across a day boundary", async () => {
    const ts = Date.UTC(2099, 0, 1, 0, 0, 0, 1);
    await insertEvents(db.client, [action("ts-midnight", { ts })]);
    const [row] = await rows<{ ms: string }>(
      "SELECT toUnixTimestamp64Milli(ts) AS ms FROM actions WHERE session_id = 'ts-midnight'",
    );
    expect(Number(row?.ms)).toBe(ts);
  });
});

describe("text and unicode", () => {
  const nasty = [
    "日本語 العربية עברית 🚀👩‍💻",
    'it\'s "quoted" \\ back\\slash',
    "line1\nline2\r\nline3\ttab",
    "'; DROP TABLE actions; --",
    "{param:String} $" + "{var} %s %%",
    "\u0000nul inside\u0000",
    "a".repeat(2000),
  ];

  it.each(nasty.map((text, i) => [i, text] as const))(
    "round-trips action.target #%i",
    async (i, text) => {
      const sid = `uni-target-${i}`;
      await insertEvents(db.client, [action(sid, { target: text })]);
      const [row] = await rows<{ target: string }>(
        `SELECT target FROM actions WHERE session_id = '${sid}'`,
      );
      expect(row?.target).toBe(text);
    },
  );

  it.each(nasty.map((text, i) => [i, text] as const))(
    "round-trips issue.message #%i",
    async (i, text) => {
      const sid = `uni-msg-${i}`;
      await insertEvents(db.client, [issue(sid, { message: text })]);
      const [row] = await rows<{ message: string }>(
        `SELECT message FROM issues WHERE session_id = '${sid}'`,
      );
      expect(row?.message).toBe(text);
    },
  );

  it("is safe with SQL metacharacters in a session id (looked up with query parameters)", async () => {
    const evil = "x' OR '1'='1";
    const counts = await insertEvents(db.client, [ended(evil), started("sql-inj-keep")]);
    expect(counts.orphanedEnds).toBe(1);
    expect(await count("sessions", "sql-inj-keep")).toBe(1);
  });

  it("round-trips a session reason with unicode and a 2000 character message", async () => {
    const reason = `💥 ${"é".repeat(1990)}`;
    await insertEvents(db.client, [started("uni-reason"), ended("uni-reason", { reason })]);
    const [row] = await rows<{ reason: string }>(
      "SELECT reason FROM sessions FINAL WHERE session_id = 'uni-reason'",
    );
    expect(row?.reason).toBe(reason);
  });
});

describe("volume", () => {
  it("inserts a 10,000 event batch with one INSERT per table, fast", async () => {
    const events: FleetEvent[] = [];
    for (let i = 0; i < 10_000; i++) events.push(action(`vol-10k-${i % 100}`, { seq: i }));
    const t0 = performance.now();
    const counts = await insertEvents(db.client, events);
    const ms = performance.now() - t0;
    expect(counts.actions).toBe(10_000);
    expect(await count("actions", "vol-10k-")).toBe(10_000);
    // ~150-250 ms locally. 10 s is a generous CI ceiling that still catches a per-row insert.
    expect(ms).toBeLessThan(10_000);

    // One batch INSERT means one data part, not 10,000.
    const [parts] = await rows<{ n: string }>(
      `SELECT count() AS n FROM system.parts WHERE database = currentDatabase() AND table = 'actions' AND active AND rows >= 10000`,
    );
    expect(Number(parts?.n)).toBeGreaterThanOrEqual(1);
  });

  it("inserts a mixed 10,000 event batch (5,000 sessions and 5,000 actions)", async () => {
    const events: FleetEvent[] = [];
    for (let i = 0; i < 5_000; i++) {
      events.push(started(`vol-mix-${i}`), action(`vol-mix-${i}`));
    }
    const counts = await insertEvents(db.client, events);
    expect(counts).toMatchObject({ sessions: 5_000, actions: 5_000, orphanedEnds: 0 });
    expect(await count("sessions", "vol-mix-")).toBe(5_000);
  });

  it("closes 5,000 sessions whose start is in the same batch", async () => {
    const events: FleetEvent[] = [];
    for (let i = 0; i < 5_000; i++) {
      events.push(started(`vol-close-${i}`), ended(`vol-close-${i}`));
    }
    await insertEvents(db.client, events);
    const [row] = await rows<{ n: string }>(
      "SELECT count() AS n FROM sessions FINAL WHERE startsWith(session_id, 'vol-close-') AND status = 'success'",
    );
    expect(Number(row?.n)).toBe(5_000);
  });

  it("closes 500 sessions whose start was stored by an earlier batch", async () => {
    const starts: FleetEvent[] = [];
    const ends: FleetEvent[] = [];
    for (let i = 0; i < 500; i++) {
      starts.push(started(`vol-later-${i}`));
      ends.push(ended(`vol-later-${i}`));
    }
    await insertEvents(db.client, starts);
    const counts = await insertEvents(db.client, ends);
    expect(counts).toMatchObject({ sessions: 500, orphanedEnds: 0 });
  });

  // QA-M0-01 (fixed in round 1): the ids of ended sessions used to be sent as ONE query parameter
  // and ClickHouse refused anything above ~64 KB. They are now looked up in chunks.
  const startThenEnd = async (ids: string[]) => {
    await insertEvents(
      db.client,
      ids.map((id) => started(id)),
    );
    return insertEvents(
      db.client,
      ids.map((id) => ended(id)),
    );
  };

  it("QA-M0-01: closes 1,000 sessions with 128 char ids whose start is stored", async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => `vol-long-${i}-`.padEnd(128, "x"));
    const counts = await startThenEnd(ids);
    expect(counts).toMatchObject({ sessions: 1_000, orphanedEnds: 0 });
    const [row] = await rows<{ n: string }>(
      "SELECT count() AS n FROM sessions FINAL WHERE startsWith(session_id, 'vol-long-') AND status = 'success'",
    );
    expect(Number(row?.n)).toBe(1_000);
  });

  it("QA-M0-01: closes 5,000 sessions with 36 char ids whose start is stored", async () => {
    const counts = await startThenEnd(Array.from({ length: 5_000 }, () => randomUUID()));
    expect(counts).toMatchObject({ sessions: 5_000, orphanedEnds: 0 });
  });

  it("QA-M0-01: closes 5,000 sessions with 128 char ids (640 KB of ids) whose start is stored", async () => {
    const counts = await startThenEnd(
      Array.from({ length: 5_000 }, (_, i) => `vol-xl-${i}-`.padEnd(128, "y")),
    );
    expect(counts).toMatchObject({ sessions: 5_000, orphanedEnds: 0 });
  });

  it("QA-M0-01: handles ids that grow when URL-encoded (unicode, spaces, quotes)", async () => {
    const counts = await startThenEnd(
      Array.from({ length: 1_000 }, (_, i) =>
        `vol-enc-${i}-\u00e9 \u65e5\u672c "q"'`.padEnd(60, "\u00fc"),
      ),
    );
    expect(counts).toMatchObject({ sessions: 1_000, orphanedEnds: 0 });
  });

  it("QA-M0-01: counts orphaned ends correctly when only some starts are stored", async () => {
    const stored = Array.from({ length: 700 }, (_, i) => `vol-part-${i}-`.padEnd(128, "p"));
    const missing = Array.from({ length: 300 }, (_, i) => `vol-gone-${i}-`.padEnd(128, "g"));
    await insertEvents(
      db.client,
      stored.map((id) => started(id)),
    );
    const counts = await insertEvents(
      db.client,
      [...stored, ...missing].map((id) => ended(id)),
    );
    expect(counts).toMatchObject({ sessions: 700, orphanedEnds: 300 });
  });
});

describe("everything the schema accepts, the database can store (QA-M0-02, QA-M0-04)", () => {
  // insertEvents takes events that the API's zod validation has already accepted (lead decision,
  // round 1). So the contract to test is: the extreme values the schema ALLOWS survive a round
  // trip unchanged, instead of testing what happens to values the schema rejects.
  const UINT32_MAX = 4_294_967_295;

  it("stores the extreme valid values exactly (no wrapping, no NULL)", async () => {
    const lastTs = TS_MAX_EXCLUSIVE - 1;
    const events = [
      action("extreme", { ts: lastTs, seq: UINT32_MAX, duration_ms: UINT32_MAX }),
      sample("extreme", {
        ts: lastTs,
        cpu_pct: 100_000,
        mem_mb: 16_777_216,
        net_rx_bytes: Number.MAX_SAFE_INTEGER,
        net_tx_bytes: Number.MAX_SAFE_INTEGER,
        js_heap_mb: 16_777_216,
      }),
      started("extreme", { ts: lastTs, startup_ms: UINT32_MAX, connect_ms: UINT32_MAX }),
    ];
    for (const event of events) expect(FleetEvent.safeParse(event).success).toBe(true);
    await insertEvents(db.client, events);

    const [act] = await rows<{ seq: number; d: number; ms: string }>(
      "SELECT seq, duration_ms AS d, toUnixTimestamp64Milli(ts) AS ms FROM actions WHERE session_id = 'extreme'",
    );
    expect(act).toMatchObject({ seq: UINT32_MAX, d: UINT32_MAX });
    expect(Number(act?.ms)).toBe(lastTs);

    const [res] = await rows<Record<string, unknown>>(
      `SELECT cpu_pct, mem_mb, toString(net_rx_bytes) AS rx, js_heap_mb FROM resource_samples WHERE session_id = 'extreme'`,
    );
    expect(res).toEqual({
      cpu_pct: 100_000,
      mem_mb: 16_777_216,
      rx: String(Number.MAX_SAFE_INTEGER),
      js_heap_mb: 16_777_216,
    });

    const [session] = await rows<{ s: number; c: number }>(
      "SELECT startup_ms AS s, connect_ms AS c FROM sessions FINAL WHERE session_id = 'extreme'",
    );
    expect(session).toEqual({ s: UINT32_MAX, c: UINT32_MAX });
  });

  it("accepts the first instant of the ts window without error (the 30 day TTL then drops it)", async () => {
    const counts = await insertEvents(db.client, [action("window-min", { ts: TS_MIN })]);
    expect(counts.actions).toBe(1);
    expect(await count("actions", "window-min")).toBe(0);
  });

  it("stores a cdp sample whose container metrics are null as NULL, not 0", async () => {
    const nulls = { cpu_pct: null, mem_mb: null, net_rx_bytes: null, net_tx_bytes: null };
    await insertEvents(db.client, [
      sample("cdp-nulls", { origin: "cdp", ...nulls, js_heap_mb: 42.5 }),
      sample("cdp-nulls", { origin: "cdp", ...nulls, js_heap_mb: null }),
    ]);
    const result = await rows<Record<string, number | null>>(
      `SELECT cpu_pct, mem_mb, net_rx_bytes, net_tx_bytes, js_heap_mb FROM resource_samples
       WHERE session_id = 'cdp-nulls' ORDER BY js_heap_mb DESC`,
    );
    expect(result).toEqual([
      { ...nulls, js_heap_mb: 42.5 },
      { ...nulls, js_heap_mb: null },
    ]);
  });

  it("keeps a container sample's real zeros as 0, not NULL", async () => {
    await insertEvents(db.client, [
      sample("container-zero", { cpu_pct: 0, mem_mb: 0, net_rx_bytes: 0, net_tx_bytes: 0 }),
    ]);
    const [row] = await rows<Record<string, unknown>>(
      "SELECT cpu_pct, mem_mb, toString(net_rx_bytes) AS rx, js_heap_mb FROM resource_samples WHERE session_id = 'container-zero'",
    );
    expect(row).toEqual({ cpu_pct: 0, mem_mb: 0, rx: "0", js_heap_mb: null });
  });

  it("uses Nullable columns for the four container metrics and the heap", async () => {
    const columns = await rows<{ name: string; type: string }>(
      `SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = 'resource_samples'
       AND name IN ('cpu_pct','mem_mb','net_rx_bytes','net_tx_bytes','js_heap_mb')`,
    );
    expect(columns).toHaveLength(5);
    for (const column of columns) expect(column.type, column.name).toMatch(/^Nullable\(/);
  });

  it("throws and writes nothing for a ts Date cannot format (unvalidated input, accepted as designed)", async () => {
    await expect(
      insertEvents(db.client, [
        started("range-guard"),
        action("range-guard", { ts: Number.MAX_SAFE_INTEGER }),
      ]),
    ).rejects.toThrow(RangeError);
    expect(await count("sessions", "range-guard")).toBe(0);
  });

  // QA-M0-03 (deferred to M1): insertEvents writes table by table, so a failing later INSERT leaves
  // the earlier tables written. With validated events this is only reachable through a ClickHouse
  // outage mid-flush, and M1's dedupe by event_id makes the retry safe.
  it.todo(
    "M1 (QA-M0-03): a retry after a partial write inserts no duplicates (needs event_id dedupe)",
  );
});

describe("migrations: concurrency and history", () => {
  async function ledgerCounts(database: string): Promise<Record<string, number>> {
    const client = createClickHouseClient({ ...db.config, database });
    try {
      const result = await client.query({
        query: "SELECT name, count() AS n FROM schema_migrations GROUP BY name",
        format: "JSONEachRow",
      });
      const list = await result.json<{ name: string; n: string }>();
      return Object.fromEntries(list.map((r) => [r.name, Number(r.n)]));
    } finally {
      await client.close();
    }
  }

  it("migrating an empty database creates every table", async () => {
    const config = { ...db.config, database: `${db.config.database}_empty` };
    try {
      const result = await runMigrations(config);
      expect(result.applied).toHaveLength(5);
      const client = createClickHouseClient(config);
      const tables = await (
        await client.query({
          query: "SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name",
          format: "JSONEachRow",
        })
      ).json<{ name: string }>();
      await client.close();
      expect(tables.map((t) => t.name)).toEqual([
        "actions",
        "issues",
        "network_requests",
        "resource_samples",
        "schema_migrations",
        "sessions",
      ]);
    } finally {
      await dropDatabase(config);
    }
  });

  it("three concurrent runs leave a usable database", async () => {
    const config = { ...db.config, database: `${db.config.database}_conc` };
    try {
      const results = await Promise.allSettled([
        runMigrations(config),
        runMigrations(config),
        runMigrations(config),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const again = await runMigrations(config);
      expect(again.applied).toEqual([]);
    } finally {
      await dropDatabase(config);
    }
  });

  // QA-M0-05 (accepted limitation, round 1): ClickHouse has no advisory locks, so overlapping runs
  // cannot be serialized. packages/db/README.md says to run migrations from one place. The runner
  // re-reads the ledger before each file, which narrows (not closes) the race. What we CAN promise,
  // and test: a database migrated by overlapping runs is complete, usable, and every migration is
  // recorded at least once.
  it("overlapping runs record every migration at least once and at most once per run", async () => {
    const config = { ...db.config, database: `${db.config.database}_conc2` };
    try {
      await Promise.allSettled([
        runMigrations(config),
        runMigrations(config),
        runMigrations(config),
      ]);
      const counts = await ledgerCounts(config.database);
      expect(Object.keys(counts)).toHaveLength(5);
      for (const n of Object.values(counts)) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(3);
      }
      const after = await runMigrations(config);
      expect(after.applied).toEqual([]);
    } finally {
      await dropDatabase(config);
    }
  });

  it("sequential runs record every migration exactly once", async () => {
    const config = { ...db.config, database: `${db.config.database}_seq` };
    try {
      await runMigrations(config);
      await runMigrations(config);
      expect(Object.values(await ledgerCounts(config.database))).toEqual([1, 1, 1, 1, 1]);
    } finally {
      await dropDatabase(config);
    }
  });

  it("the ledger checksum is stable across runs", async () => {
    const [row] = await rows<{ n: string }>(
      "SELECT uniqExact(checksum) AS n FROM schema_migrations WHERE name = '0001_sessions.sql'",
    );
    expect(Number(row?.n)).toBe(1);
  });
});

describe("seed", () => {
  it("leaves non-seed data alone and never piles up", async () => {
    await insertEvents(db.client, [
      started("keep-me"),
      action("keep-me"),
      issue("keep-me"),
      sample("keep-me"),
    ]);
    await seed(db.client);
    await seed(db.client);
    await seed(db.client);
    expect(await count("sessions", "keep-me")).toBe(1);
    expect(await count("actions", "keep-me")).toBe(1);
    expect(await count("issues", "keep-me")).toBe(1);
    expect(await count("resource_samples", "keep-me")).toBe(1);
    expect(await count("actions", "seed-")).toBe(9);
    expect(await count("resource_samples", "seed-")).toBe(6);
  });

  it("only produces simulated data, recent enough to survive the 30 day TTL", async () => {
    const [bad] = await rows<{ n: string }>(
      "SELECT count() AS n FROM sessions FINAL WHERE startsWith(session_id, 'seed-') AND source != 'sim'",
    );
    expect(Number(bad?.n)).toBe(0);
    const sourceRows = await rows<{ source: string }>(
      "SELECT DISTINCT source FROM actions WHERE startsWith(session_id, 'seed-')",
    );
    expect(sourceRows).toEqual([{ source: "sim" }]);
    const events = buildSeedEvents();
    expect(events.every((e) => e.ts > Date.now() - 30 * DAY)).toBe(true);
  });
});
