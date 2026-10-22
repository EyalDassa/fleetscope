import { randomUUID } from "node:crypto";
import {
  ActionEvent,
  type FleetEvent,
  IssueEvent,
  NetworkRequestEvent,
  ResourceSampleEvent,
  SessionEndedEvent,
  SessionStartedEvent,
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
 * Tests named "QA-M0-NN" describe a known bug (see qa/m0-report.md). They use `it.fails`: they
 * pass while the bug exists and fail once it is fixed, which tells QA to flip them to `it`.
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

  it("does not apply the TTL to sessions (only the four raw tables have one)", async () => {
    await insertEvents(db.client, [started("ttl-session", { ts: Date.now() - 90 * DAY })]);
    expect(await count("sessions", "ttl-session")).toBe(1);
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

  // QA-M0-01 (major). The ids of ended sessions are sent to ClickHouse as ONE query parameter
  // (`session_id IN {ids:Array(String)}`). ClickHouse refuses a form field above ~64 KB with
  // "HTML Form Exception: Field value too long", so the whole insert fails. 1,000 ends with
  // 128-char ids is inside the documented API contract (batch of 1,000, ids up to 128 chars);
  // 5,000 ends with uuid-sized ids is inside the planned ingest flush size (5k rows).
  it.fails("QA-M0-01: handles 1,000 session.ended events (128 char ids) whose start is stored", async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => `vol-long-${i}-`.padEnd(128, "x"));
    await insertEvents(
      db.client,
      ids.map((id) => started(id)),
    );
    const counts = await insertEvents(
      db.client,
      ids.map((id) => ended(id)),
    );
    expect(counts.sessions).toBe(1_000);
  });

  it.fails("QA-M0-01: handles 5,000 session.ended events (36 char ids) whose start is stored", async () => {
    const ids = Array.from({ length: 5_000 }, () => randomUUID());
    await insertEvents(
      db.client,
      ids.map((id) => started(id)),
    );
    const counts = await insertEvents(
      db.client,
      ids.map((id) => ended(id)),
    );
    expect(counts.sessions).toBe(5_000);
  });
});

describe("a bad value must not take the whole batch down", () => {
  // QA-M0-02 / QA-M0-03. The schema accepts any integer ts up to 2^53, but ClickHouse cannot read
  // years >= 10000, so one poisoned event fails the insert for the entire flush. And because
  // insertEvents writes table by table (sessions, actions, ..., issues) a failure in the last
  // table leaves the earlier tables written: a client retry then double-inserts them.
  const YEAR_10000 = 253_402_300_800_000;

  it("rejects a ts in year 10000 with an error (ClickHouse cannot store it)", async () => {
    await expect(
      insertEvents(db.client, [action("poison-reject", { ts: YEAR_10000 })]),
    ).rejects.toThrow();
    expect(await count("actions", "poison-reject")).toBe(0);
  });

  it("rejects a ts beyond what Date can format with a RangeError before writing anything", async () => {
    await expect(
      insertEvents(db.client, [
        started("poison-range"),
        action("poison-range", { ts: Number.MAX_SAFE_INTEGER }),
      ]),
    ).rejects.toThrow(RangeError);
    expect(await count("sessions", "poison-range")).toBe(0);
  });

  it.fails("QA-M0-03: leaves nothing behind when the last table insert fails", async () => {
    await expect(
      insertEvents(db.client, [
        started("poison-partial"),
        action("poison-partial"),
        issue("poison-partial", { ts: YEAR_10000 }),
      ]),
    ).rejects.toThrow();
    expect(await count("sessions", "poison-partial")).toBe(0);
    expect(await count("actions", "poison-partial")).toBe(0);
  });

  // QA-M0-04 (minor). Values the schema allows but the column cannot hold are not rejected: they
  // are silently changed. 2^32 ms becomes 0, 1e39 becomes NULL ("not available").
  it.fails("QA-M0-04: does not silently wrap a duration that overflows UInt32", async () => {
    await insertEvents(db.client, [action("ovf-wrap", { duration_ms: 2 ** 32 + 5 })]);
    const [row] = await rows<{ d: number }>(
      "SELECT duration_ms AS d FROM actions WHERE session_id = 'ovf-wrap'",
    );
    expect(row?.d).not.toBe(5);
  });

  it.fails("QA-M0-04: does not turn an out-of-range cpu_pct into NULL", async () => {
    await insertEvents(db.client, [sample("ovf-null", { cpu_pct: 1e39 })]);
    const [row] = await rows<{ c: number | null }>(
      "SELECT cpu_pct AS c FROM resource_samples WHERE session_id = 'ovf-null'",
    );
    expect(row?.c).not.toBeNull();
  });
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

  // QA-M0-05 (minor). Nothing serialises concurrent runs (CI deploy + a developer, two replicas
  // starting together): each run sees an empty ledger, applies all five files and writes its own
  // ledger rows. Harmless today because every migration is CREATE TABLE IF NOT EXISTS; the first
  // ALTER TABLE migration would be applied several times.
  it.fails("QA-M0-05: records each migration exactly once when runs overlap", async () => {
    const config = { ...db.config, database: `${db.config.database}_conc2` };
    try {
      await Promise.allSettled([
        runMigrations(config),
        runMigrations(config),
        runMigrations(config),
      ]);
      const counts = await ledgerCounts(config.database);
      expect(Object.values(counts)).toEqual([1, 1, 1, 1, 1]);
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
