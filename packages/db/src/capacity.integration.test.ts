import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { dedupTokensFor, insertEvents } from "./insert";
import { createReaderClient, createTestDatabase, type TestDatabase, testPassword } from "./testing";

/**
 * The "Capacity" snippets of packages/db/README.md, run as the read-only Grafana user (with the grants
 * `ensureGrafanaUser` gives it). Three layers:
 *  1. the real system tables: every snippet runs and returns its contract columns (the values depend
 *     on the machine, so they are not asserted);
 *  2. the real `part_log`: events go through `insertEvents`, and sent must equal written;
 *  3. synthetic tables with the same columns, swapped in for the two system tables, so that limit
 *     changes, two replicas, a missing limit and a mismatch can be worked out by hand.
 */

let db: TestDatabase;
let reader: ClickHouseClient;
const user = `fleetscope_capacity_test_${randomBytes(4).toString("hex")}`;
const password = testPassword();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const GIB = 2 ** 30;

async function readmeSnippets(): Promise<Map<string, string>> {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const snippets = new Map<string, string>();
  for (const match of readme
    .replace(/\r\n/g, "\n")
    .matchAll(/```sql name=([a-z-]+)\n([\s\S]*?)\n```/g)) {
    snippets.set(match[1] as string, match[2] as string);
  }
  return snippets;
}

const CAPACITY_SNIPPETS = [
  "capacity-load",
  "capacity-utilization",
  "capacity-replicas",
  "capacity-limit-changes",
  "capacity-alerts-mem-pct",
  "capacity-alerts-cpu-pct",
  "capacity-alerts-limits-changed",
  "capacity-alerts-load-mismatch-pct",
  "capacity-alerts-minutes-since-write",
];

interface Tables {
  metrics?: string;
  partLog?: string;
}

/** Expands the two time macros and, for the synthetic tests, swaps in the stand-in tables. */
async function sqlOf(name: string, window: { from: number; to: number }, tables: Tables = {}) {
  const snippet = (await readmeSnippets()).get(name) as string;
  expect(snippet, name).toBeDefined();
  const sec = (ms: number) => Math.floor(ms / 1000);
  let sql = snippet
    .replace(/\$__fromTime/g, `toDateTime(${sec(window.from)})`)
    .replace(/\$__toTime/g, `toDateTime(${sec(window.to)})`);
  if (tables.metrics) sql = sql.replaceAll("system.asynchronous_metric_log", tables.metrics);
  if (tables.partLog) sql = sql.replaceAll("system.part_log", tables.partLog);
  return sql;
}

async function run<T = Record<string, unknown>>(
  name: string,
  window: { from: number; to: number },
  tables?: Tables,
): Promise<{ rows: T[]; columns: string[] }> {
  const result = await reader.query({
    query: await sqlOf(name, window, tables),
    format: "JSON",
  });
  // format JSON is one object with the column list (`meta`) and the rows (`data`)
  const body = (await result.json()) as unknown as { meta: Array<{ name: string }>; data: T[] };
  return { rows: body.data, columns: body.meta.map((m) => m.name) };
}

/** An alert query: one row, one column `value`. */
async function alertValue(name: string, tables?: Tables): Promise<number | null> {
  const { rows, columns } = await run<{ value: number | string | null }>(
    name,
    { from: Date.now() - 60 * MIN, to: Date.now() },
    tables,
  );
  expect(columns).toEqual(["value"]);
  expect(rows).toHaveLength(1);
  const value = rows[0]?.value;
  return value === null || value === undefined ? null : Number(value);
}

let partLogExists = false;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
  reader = createReaderClient(db.config, user, password);
  const exists = await db.client.query({
    query: "SELECT count() AS n FROM system.tables WHERE database = 'system' AND name = 'part_log'",
    format: "JSONEachRow",
  });
  partLogExists = Number(((await exists.json()) as Array<{ n: number | string }>)[0]?.n) > 0;

  // Stand-ins with the columns the snippets use. Plain MergeTree, so the read-only user reads them
  // like any other table of the database.
  for (const name of ["metrics_full", "metrics_dev", "metrics_empty"]) {
    await db.client.command({
      query: `CREATE TABLE ${name} (hostname LowCardinality(String), event_time DateTime, metric LowCardinality(String), value Float64) ENGINE = MergeTree ORDER BY (event_time, metric)`,
    });
  }
  for (const name of ["part_log_fake", "part_log_empty", "part_log_orphan", "part_log_age"]) {
    await db.client.command({
      query: `CREATE TABLE ${name} (event_type LowCardinality(String), database LowCardinality(String), \`table\` LowCardinality(String), rows UInt64, error UInt16, event_time DateTime) ENGINE = MergeTree ORDER BY event_time`,
    });
  }
});

afterAll(async () => {
  await reader.close();
  await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("the capacity snippets", () => {
  it("are all in the README, need no SETTINGS clause and read nothing outside the two granted system tables", async () => {
    const snippets = await readmeSnippets();
    for (const name of CAPACITY_SNIPPETS) {
      const sql = snippets.get(name);
      expect(sql, name).toBeDefined();
      expect(sql, name).not.toMatch(/\bSETTINGS\b/i);
      const systemTables = [...(sql as string).matchAll(/\bsystem\.(\w+)/g)].map((m) => m[1]);
      for (const table of systemTables) {
        expect(["asynchronous_metric_log", "part_log"], `${name}: system.${table}`).toContain(
          table,
        );
      }
    }
  });

  describe("on the real system tables", () => {
    const window = () => ({ from: Date.now() - 15 * MIN, to: Date.now() + MIN });
    const CONTRACT: Record<string, string[]> = {
      "capacity-load": ["time", "rows_sent", "rows_written", "sessions_started"],
      "capacity-utilization": [
        "time",
        "replica",
        "mem_used_gib",
        "mem_limit_gib",
        "cpu_used_cores",
        "cpu_limit_cores",
      ],
      "capacity-replicas": ["time", "replicas"],
      "capacity-limit-changes": ["time", "text"],
    };

    it.for(Object.keys(CONTRACT))(
      "%s runs as the read-only user with the contract columns",
      async (name, task) => {
        if (name === "capacity-load" && !partLogExists) {
          return task.skip("system.part_log does not exist on this ClickHouse");
        }
        const { columns } = await run(name, window());
        expect(columns).toEqual(CONTRACT[name]);
      },
    );

    it("capacity-load is zero-filled: every minute of an idle range is a row of three zeros", async (task) => {
      if (!partLogExists) return task.skip("system.part_log does not exist on this ClickHouse");
      // an hour in the past that nothing wrote to, ending on a minute boundary: 5 minutes, 5 rows
      const from = Math.floor(Date.now() / MIN) * MIN - 3 * 60 * MIN;
      const { rows } = await run<Record<string, string | number>>("capacity-load", {
        from,
        to: from + 5 * MIN,
      });
      // (JSON format sends 64-bit counts as strings and the filled zeros as numbers: compare as numbers)
      expect(
        rows.map((r) => ({
          ...r,
          rows_sent: Number(r.rows_sent),
          rows_written: Number(r.rows_written),
          sessions_started: Number(r.sessions_started),
        })),
      ).toEqual(
        [0, 1, 2, 3, 4].map((i) => ({
          time: iso(from + i * MIN),
          rows_sent: 0,
          rows_written: 0,
          sessions_started: 0,
        })),
      );
      // a start inside a minute is snapped to it, and the end is exclusive
      const part = await run("capacity-load", { from: from + 30_000, to: from + 2 * MIN + 30_000 });
      expect(part.rows.map((r) => (r as { time: string }).time)).toEqual([
        iso(from),
        iso(from + MIN),
        iso(from + 2 * MIN),
      ]);
    });

    it("capacity-utilization shows this server: a short replica name, memory in use, and a limit that is NULL or positive", async () => {
      const { rows } = await run<{
        replica: string;
        mem_used_gib: number | null;
        mem_limit_gib: number | null;
        cpu_used_cores: number | null;
        cpu_limit_cores: number | null;
      }>("capacity-utilization", window());
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.replica).not.toContain(".");
        expect(row.replica.length).toBeGreaterThan(0);
        expect(row.mem_used_gib).toBeGreaterThan(0);
        expect(row.cpu_used_cores).toBeGreaterThanOrEqual(0);
        // no limit on the container is NULL, never 0 (dev Docker has none)
        for (const limit of [row.mem_limit_gib, row.cpu_limit_cores]) {
          if (limit !== null) expect(limit).toBeGreaterThan(0);
        }
      }
    });

    it("capacity-replicas counts at least the one server that answers", async () => {
      const { rows } = await run<{ replicas: number | string }>("capacity-replicas", window());
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Number(row.replicas)).toBeGreaterThanOrEqual(1);
    });

    it.for([
      "capacity-alerts-mem-pct",
      "capacity-alerts-cpu-pct",
      "capacity-alerts-limits-changed",
      "capacity-alerts-load-mismatch-pct",
      "capacity-alerts-minutes-since-write",
    ])("%s returns one row with one column `value`", async (name, task) => {
      if (!partLogExists && /load-mismatch|since-write/.test(name)) {
        return task.skip("system.part_log does not exist on this ClickHouse");
      }
      const value = await alertValue(name);
      expect(value === null || Number.isFinite(value)).toBe(true);
    });
  });

  describe("sent vs written, on the real part_log", () => {
    const ctx = (session_id: string): EventEnvelope => ({
      session_id,
      source: "real",
      agent_id: "capacity-test",
      engine: "chromium",
      provider: "local-docker",
    });

    function fleet(sessionId: string, at: number) {
      const c = ctx(sessionId);
      return [
        newEvent(
          "session.started",
          c,
          { engine_version: null, scenario: "x", region: "local", startup_ms: 1, connect_ms: 1 },
          at,
        ),
        ...[0, 1, 2, 3, 4, 5, 6].map((seq) =>
          newEvent(
            "action",
            c,
            {
              seq,
              action_type: "goto",
              target: "x",
              duration_ms: 5,
              ok: true,
              error_code: null,
            },
            at + 10 * seq,
          ),
        ),
        ...[0, 1, 2, 3, 4].map((i) =>
          newEvent(
            "resource.sample",
            c,
            { origin: "container", cpu_pct: 1, mem_mb: 2, net_rx_bytes: 3, net_tx_bytes: 4 },
            at + 10 * i,
          ),
        ),
        ...[0, 1, 2, 3].map((i) =>
          newEvent(
            "network.request",
            c,
            { domain: "x", status: 200, bytes: 10, duration_ms: 3, resource_type: "document" },
            at + 10 * i,
          ),
        ),
        newEvent("issue", c, { kind: "blocked", message: "m" }, at + 5),
        newEvent("issue", c, { kind: "crash", message: "m" }, at + 6),
      ];
    }
    // 7 + 5 + 4 + 2 = 18 rows in the four append-only tables per session

    async function totals() {
      await db.client.command({ query: "SYSTEM FLUSH LOGS part_log" });
      const now = Date.now();
      const { rows } = await run<{
        rows_sent: number | string;
        rows_written: number | string;
        sessions_started: number | string;
      }>("capacity-load", { from: now - 10 * MIN, to: now + MIN });
      const sum = (key: "rows_sent" | "rows_written" | "sessions_started") =>
        rows.reduce((total, row) => total + Number(row[key]), 0);
      return {
        sent: sum("rows_sent"),
        written: sum("rows_written"),
        sessions: sum("sessions_started"),
      };
    }

    it("rows written equal rows sent: the materialized views, the sessions rows and a retried insert do not change that", async (task) => {
      // system.part_log is optional (a server can switch it off); without it there is nothing to compare
      if (!partLogExists) return task.skip("system.part_log does not exist on this ClickHouse");
      const before = await totals();
      expect(before).toEqual({ sent: 0, written: 0, sessions: 0 });

      const now = Date.now() - 5_000;
      // three sessions, each 18 rows in the four tables, inserted as three flushes
      for (const id of ["cap-a", "cap-b", "cap-c"]) {
        await insertEvents(db.client, fleet(id, now), {
          dedupTokens: dedupTokensFor(`flush-${id}`),
        });
      }
      // a flush that is retried with the same tokens: skipped by ClickHouse, nothing to count twice
      await insertEvents(db.client, fleet("cap-a", now), {
        dedupTokens: dedupTokensFor("flush-cap-a"),
      });
      // the ended row of a session whose start was inserted earlier: a second sessions row, not counted
      await insertEvents(db.client, [
        newEvent(
          "session.ended",
          ctx("cap-a"),
          { status: "success", reason: null, duration_ms: 100 },
          now + 1000,
        ),
      ]);

      const after = await totals();
      // the retried flush was skipped by ClickHouse: its rows are in neither number
      expect(after.sent).toBe(3 * 18);
      expect(after.written).toBe(3 * 18);
      expect(after.sessions).toBe(3);
    });
  });
});

describe("the capacity snippets on worked-out data", () => {
  // Two replicas, 45 minutes of data ending at the start of the current minute. The memory limit
  // goes from 16 to 32 GiB and the CPU limit from 4 to 8 cores 20 minutes ago, and replica b appears
  // 10 minutes ago. Memory in use is 8 GiB and CPU 0.5 user + 0.25 system on every replica.
  const T = Math.floor(Date.now() / MIN) * MIN;
  const A = "replica-a.ns-test.svc.cluster.local";
  const B = "replica-b.ns-test.svc.cluster.local";
  const window = () => ({ from: T - 45 * MIN, to: Date.now() + MIN });
  const tables = { metrics: "metrics_full", partLog: "part_log_fake" };

  type MetricRow = { hostname: string; event_time: string; metric: string; value: number };

  function replicaRows(
    hostname: string,
    firstMinute: number,
    options: { scaledAt: number | null; limits: boolean },
  ): MetricRow[] {
    const out: MetricRow[] = [];
    for (let m = firstMinute; m < T; m += MIN) {
      const scaled = options.scaledAt !== null && m >= options.scaledAt;
      const at = iso(m + 30_000);
      const add = (metric: string, value: number) =>
        out.push({ hostname, event_time: at, metric, value });
      add("Uptime", 1000);
      add("CGroupMemoryUsed", 8 * GIB);
      add("CGroupUserTime", 0.5);
      add("CGroupSystemTime", 0.25);
      add("CGroupMemoryTotal", options.limits ? (scaled ? 32 : 16) * GIB : 0);
      if (options.limits) add("CGroupMaxCPU", scaled ? 8 : 4);
    }
    return out;
  }

  beforeAll(async () => {
    const insert = (table: string, values: object[]) =>
      db.client.insert({ table, values, format: "JSONEachRow" });
    await insert("metrics_full", [
      ...replicaRows(A, T - 45 * MIN, { scaledAt: T - 20 * MIN, limits: true }),
      ...replicaRows(B, T - 10 * MIN, { scaledAt: T - 20 * MIN, limits: true }),
    ]);
    await insert("part_log_orphan", [
      {
        event_type: "NewPart",
        database: db.config.database,
        table: "actions",
        rows: 5,
        error: 0,
        event_time: iso(T - 30 * MIN),
      },
    ]);
    // a dev container: no memory limit (0), no CGroupMaxCPU at all
    await insert("metrics_dev", replicaRows(A, T - 45 * MIN, { scaledAt: null, limits: false }));
  });

  it("capacity-utilization gives memory and CPU against the limits, per replica and minute", async () => {
    const { rows } = await run<{
      time: string;
      replica: string;
      mem_used_gib: number;
      mem_limit_gib: number | null;
      cpu_used_cores: number;
      cpu_limit_cores: number | null;
    }>("capacity-utilization", window(), tables);
    const at = (replica: string, minutesAgo: number) =>
      rows.find((r) => r.replica === replica && r.time === iso(T - minutesAgo * MIN));

    expect(at("replica-a", 30)).toMatchObject({
      mem_used_gib: 8,
      mem_limit_gib: 16,
      cpu_used_cores: 0.75,
      cpu_limit_cores: 4,
    });
    expect(at("replica-a", 5)).toMatchObject({ mem_limit_gib: 32, cpu_limit_cores: 8 });
    expect(at("replica-b", 5)).toMatchObject({ mem_used_gib: 8, mem_limit_gib: 32 });
    expect(at("replica-b", 30)).toBeUndefined(); // b did not exist yet
    expect(rows.filter((r) => r.replica === "replica-a")).toHaveLength(45);
    expect(rows.filter((r) => r.replica === "replica-b")).toHaveLength(10);
  });

  it("capacity-utilization shows a missing limit as NULL, not 0", async () => {
    const { rows } = await run<{
      mem_used_gib: number;
      mem_limit_gib: number | null;
      cpu_used_cores: number;
      cpu_limit_cores: number | null;
    }>("capacity-utilization", window(), { metrics: "metrics_dev" });
    expect(rows).toHaveLength(45);
    for (const row of rows) {
      expect(row).toMatchObject({
        mem_used_gib: 8,
        mem_limit_gib: null,
        cpu_used_cores: 0.75,
        cpu_limit_cores: null,
      });
    }
  });

  it("capacity-replicas counts the hosts that logged in each minute", async () => {
    const { rows } = await run<{ time: string; replicas: number | string }>(
      "capacity-replicas",
      window(),
      tables,
    );
    const at = (minutesAgo: number) =>
      Number(rows.find((r) => r.time === iso(T - minutesAgo * MIN))?.replicas);
    expect(at(30)).toBe(1);
    expect(at(11)).toBe(1);
    expect(at(10)).toBe(2);
    expect(at(1)).toBe(2);
  });

  it("capacity-limit-changes gives one annotation per change, with both values", async () => {
    const { rows } = await run<{ time: string; text: string }>(
      "capacity-limit-changes",
      window(),
      tables,
    );
    expect(rows).toEqual([
      { time: iso(T - 20 * MIN), text: "memory limit 16 → 32 GiB; CPU limit 4 → 8 cores" },
      { time: iso(T - 10 * MIN), text: "replicas 1 → 2" },
    ]);
  });

  it("capacity-limit-changes compares the first visible minute with the minute before the range", async () => {
    // the range opens exactly at the change: the minute before it is read, so the change is found
    const { rows } = await run<{ time: string; text: string }>(
      "capacity-limit-changes",
      { from: T - 20 * MIN, to: Date.now() + MIN },
      tables,
    );
    expect(rows.map((r) => r.text)).toEqual([
      "memory limit 16 → 32 GiB; CPU limit 4 → 8 cores",
      "replicas 1 → 2",
    ]);
    // and a range that opens after the first change does not show it
    const later = await run<{ text: string }>(
      "capacity-limit-changes",
      { from: T - 15 * MIN, to: Date.now() + MIN },
      tables,
    );
    expect(later.rows.map((r) => r.text)).toEqual(["replicas 1 → 2"]);
  });

  it("capacity-limit-changes has nothing to say about a steady server, a missing limit or no data", async () => {
    for (const metrics of ["metrics_dev", "metrics_empty"]) {
      const { rows } = await run("capacity-limit-changes", window(), { metrics });
      expect(rows, metrics).toEqual([]);
    }
  });

  describe("the alert queries", () => {
    it("mem_pct is the busiest replica's use of its limit over the last 10 minutes (the new 32 GiB limit)", async () => {
      expect(await alertValue("capacity-alerts-mem-pct", tables)).toBeCloseTo(25, 9);
    });

    it("cpu_pct is the average use of the CPU limit (0.75 of 8 cores)", async () => {
      expect(await alertValue("capacity-alerts-cpu-pct", tables)).toBeCloseTo(100 * (0.75 / 8), 9);
    });

    it("limits_changed is 1 when the limits or the replicas changed in the last 30 minutes, else 0", async () => {
      expect(await alertValue("capacity-alerts-limits-changed", tables)).toBe(1);
    });

    it("limits_changed is 0 for a steady server, and NULL (no data) when nothing logged", async () => {
      expect(await alertValue("capacity-alerts-limits-changed", { metrics: "metrics_dev" })).toBe(
        0,
      );
      expect(
        await alertValue("capacity-alerts-limits-changed", { metrics: "metrics_empty" }),
      ).toBeNull();
    });

    it("mem_pct and cpu_pct are NULL without a limit or without data, never 0", async () => {
      for (const metrics of ["metrics_dev", "metrics_empty"]) {
        expect(await alertValue("capacity-alerts-mem-pct", { metrics }), metrics).toBeNull();
        expect(await alertValue("capacity-alerts-cpu-pct", { metrics }), metrics).toBeNull();
      }
    });

    it("load_mismatch_pct is NULL for an idle fleet (nothing sent, nothing written), 100 for writes nobody sent", async () => {
      expect(
        await alertValue("capacity-alerts-load-mismatch-pct", { partLog: "part_log_empty" }),
      ).toBeNull();
      expect(
        await alertValue("capacity-alerts-load-mismatch-pct", { partLog: "part_log_orphan" }),
      ).toBe(100);
    });

    describe("on a stand-in part_log", () => {
      const ctx: EventEnvelope = {
        session_id: "mismatch",
        source: "real",
        agent_id: "capacity-test",
        engine: "chromium",
        provider: "local-docker",
      };
      const action = (seq: number, at: number) =>
        newEvent(
          "action",
          ctx,
          { seq, action_type: "goto", target: "x", duration_ms: 5, ok: true, error_code: null },
          at,
        );

      beforeAll(async () => {
        // 100 actions and 50 samples inside the window of the alert (60 whole minutes that ended a
        // minute ago) ...
        const inside = T - 30 * MIN;
        await insertEvents(db.client, [
          ...Array.from({ length: 100 }, (_, i) => action(i, inside + i * 10)),
          ...Array.from({ length: 50 }, (_, i) =>
            newEvent(
              "resource.sample",
              ctx,
              { origin: "container", cpu_pct: 1, mem_mb: 2, net_rx_bytes: 3, net_tx_bytes: 4 },
              inside + i * 10,
            ),
          ),
          // ... and rows the alert must not count: the minute in progress, and before the window
          action(1000, T + 1000),
          action(1001, T - 62 * MIN),
        ]);
        const row = (
          event_type: string,
          table: string,
          rows: number,
          at: number,
          database = db.config.database,
          error = 0,
        ) => ({ event_type, database, table, rows, error, event_time: iso(at) });
        await db.client.insert({
          table: "part_log_fake",
          format: "JSONEachRow",
          values: [
            row("NewPart", "actions", 60, T - 30 * MIN),
            row("NewPart", "actions", 40, T - 29 * MIN),
            row("NewPart", "resource_samples", 50, T - 29 * MIN),
            // not counted: the materialized view's table, a merge, another database, the minute in progress
            row("NewPart", "fleet_minute", 7, T - 29 * MIN),
            row("MergeParts", "actions", 500, T - 29 * MIN),
            row("NewPart", "actions", 900, T - 29 * MIN, "someone_else"),
            row("NewPart", "actions", 9, T + 1000),
            // a retried flush that ClickHouse deduplicated, and a failed insert: logged, nothing written
            row("NewPart", "actions", 40, T - 29 * MIN, db.config.database, 389),
            row("NewPart", "actions", 30, T - 29 * MIN, db.config.database, 241),
          ],
        });
      });

      it("load_mismatch_pct is 0 when written equals sent, and counts only the four tables of this database in whole minutes", async () => {
        expect(await alertValue("capacity-alerts-load-mismatch-pct", tables)).toBe(0);
      });

      it("load_mismatch_pct is |written - sent| / sent in percent", async () => {
        await db.client.insert({
          table: "part_log_fake",
          format: "JSONEachRow",
          values: [
            {
              event_type: "NewPart",
              database: db.config.database,
              table: "issues",
              rows: 3,
              error: 0,
              event_time: iso(T - 20 * MIN),
            },
          ],
        });
        // 153 written, 150 sent
        expect(await alertValue("capacity-alerts-load-mismatch-pct", tables)).toBeCloseTo(2, 9);
      });

      it("load_mismatch_pct is 100 when rows were sent and none written", async () => {
        expect(
          await alertValue("capacity-alerts-load-mismatch-pct", { partLog: "part_log_empty" }),
        ).toBe(100);
      });

      it("minutes_since_write is the age of the last successful NewPart of our five tables in this database", async () => {
        const row = (
          event_type: string,
          table: string,
          ago: number,
          database = db.config.database,
          error = 0,
        ) => ({
          event_type,
          database,
          table,
          rows: 1,
          error,
          event_time: iso(Date.now() - ago * MIN),
        });
        await db.client.insert({
          table: "part_log_age",
          format: "JSONEachRow",
          values: [
            row("NewPart", "sessions", 5),
            // all newer, none counts: another database, the rollup table, a merge, a deduplicated insert
            row("NewPart", "actions", 1, "someone_else"),
            row("NewPart", "fleet_minute", 2),
            row("MergeParts", "actions", 3),
            row("NewPart", "actions", 4, db.config.database, 389),
          ],
        });
        const minutes = await alertValue("capacity-alerts-minutes-since-write", {
          partLog: "part_log_age",
        });
        expect(minutes).toBeGreaterThanOrEqual(5);
        expect(minutes).toBeLessThan(5.5);
      });

      it("minutes_since_write is NULL when nothing was written in the last day", async () => {
        expect(
          await alertValue("capacity-alerts-minutes-since-write", { partLog: "part_log_empty" }),
        ).toBeNull();
      });
    });
  });
});
