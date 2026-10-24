import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type EventEnvelope,
  type FleetEvent,
  type IssueKind,
  newEvent,
  type SessionStatus,
} from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createReaderClient, createTestDatabase, type TestDatabase } from "./testing";

/**
 * Runs the `sql name=...` blocks of packages/db/README.md the way Grafana would: as the read-only
 * user, with the plugin's macros expanded, against a small fleet whose numbers are worked out by
 * hand. If a snippet in the README stops working or means something else, this fails.
 */

let db: TestDatabase;
let reader: ClickHouseClient;
const user = `fleetscope_dash_test_${randomBytes(4).toString("hex")}`;
const password = "dashboard-test-password";

// 30 minutes ago, aligned to the minute, so the events stay far inside the 30 day retention and
// the minute arithmetic below is exact.
const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 30 * 60_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const hours = (ms: number) => ms / 3_600_000;

interface Spec {
  id: string;
  engine: EventEnvelope["engine"];
  source?: EventEnvelope["source"];
  provider?: string;
  /** `running` = the session never ended. */
  status: SessionStatus | "running";
  reason?: string | null;
  startMin: number;
  durationMs: number;
  startupMs: number;
  connectMs: number;
  /** One entry per action: [duration_ms, error_code or null]. */
  actions?: Array<[number, string | null]>;
  issue?: IssueKind;
  /** Container samples as [cpu_pct, mem_mb]. */
  samples?: Array<[number, number]>;
}

const SPECS: Spec[] = [
  {
    id: "ok1",
    engine: "chromium",
    status: "success",
    startMin: 0,
    durationMs: 60_000,
    startupMs: 1000,
    connectMs: 500,
    actions: [
      [100, null],
      [200, null],
      [300, null],
    ],
    samples: [
      [10, 100],
      [30, 300],
    ],
  },
  {
    id: "ok2",
    engine: "chromium",
    status: "success",
    startMin: 1,
    durationMs: 120_000,
    startupMs: 2000,
    connectMs: 1000,
    actions: [
      [150, null],
      [250, null],
    ],
  },
  {
    id: "fail1",
    engine: "chromium",
    status: "failed",
    reason: "selector not found",
    startMin: 2,
    durationMs: 30_000,
    startupMs: 1000,
    connectMs: 500,
    actions: [
      [100, null],
      [500, "selector_not_found"],
    ],
  },
  {
    // Ctrl+C: not a failure of the fleet
    id: "int1",
    engine: "chromium",
    status: "failed",
    reason: "interrupted",
    startMin: 3,
    durationMs: 10_000,
    startupMs: 1000,
    connectMs: 500,
    actions: [
      [50, null],
      [50, "browser_closed"],
    ],
  },
  {
    id: "run1",
    engine: "chromium",
    status: "running",
    startMin: 4,
    durationMs: 0,
    startupMs: 1000,
    connectMs: 500,
  },
  {
    id: "block1",
    engine: "lightpanda",
    status: "blocked",
    reason: "bot wall",
    startMin: 1,
    durationMs: 20_000,
    startupMs: 200,
    connectMs: 100,
    actions: [[40, "http_403"]],
    issue: "blocked",
  },
  {
    id: "to1",
    engine: "lightpanda",
    status: "timeout",
    reason: "session exceeded 60s",
    startMin: 2,
    durationMs: 60_000,
    startupMs: 200,
    connectMs: 100,
    actions: [[60, "timeout"]],
  },
  {
    // failed with no issue and no failed action: the cause falls back to the status
    id: "unk1",
    engine: "lightpanda",
    status: "failed",
    reason: "something odd",
    startMin: 3,
    durationMs: 5000,
    startupMs: 200,
    connectMs: 100,
    actions: [[30, null]],
  },
  // simulated data must stay out of every "real" number
  {
    id: "sim1",
    engine: "chromium",
    source: "sim",
    status: "success",
    startMin: 0,
    durationMs: 36_000,
    startupMs: 0,
    connectMs: 0,
    actions: [[900, null]],
  },
  {
    // success, but an action failed first (a retry): "degraded"
    id: "deg1",
    engine: "chromium",
    source: "sim",
    status: "success",
    startMin: 0,
    durationMs: 36_000,
    startupMs: 0,
    connectMs: 0,
    actions: [
      [100, "timeout"],
      [100, null],
    ],
  },
  {
    id: "mys1",
    engine: "chromium",
    source: "sim",
    provider: "mystery",
    status: "success",
    startMin: 0,
    durationMs: 36_000,
    startupMs: 0,
    connectMs: 0,
  },
];

function eventsOf(spec: Spec): FleetEvent[] {
  const ctx: EventEnvelope = {
    session_id: spec.id,
    source: spec.source ?? "real",
    agent_id: "dash-test",
    engine: spec.engine,
    provider: spec.provider ?? "local-docker",
  };
  const start = T0 + spec.startMin * MIN;
  const out: FleetEvent[] = [
    newEvent(
      "session.started",
      ctx,
      {
        engine_version: null,
        scenario: "login-and-search",
        region: "local",
        startup_ms: spec.startupMs,
        connect_ms: spec.connectMs,
      },
      start,
    ),
  ];
  (spec.actions ?? []).forEach(([ms, code], seq) => {
    out.push(
      newEvent(
        "action",
        ctx,
        {
          seq,
          action_type: "goto",
          target: "demo.test",
          duration_ms: ms,
          ok: code === null,
          error_code: code,
        },
        start + 1000 + seq * 100,
      ),
    );
  });
  (spec.samples ?? []).forEach(([cpu, mem], i) => {
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        { origin: "container", cpu_pct: cpu, mem_mb: mem, net_rx_bytes: 1, net_tx_bytes: 1 },
        start + 2000 + i * 2000,
      ),
    );
  });
  if (spec.issue) {
    out.push(
      newEvent("issue", ctx, { kind: spec.issue, message: "seen by the test" }, start + 5000),
    );
  }
  if (spec.status !== "running") {
    out.push(
      newEvent(
        "session.ended",
        ctx,
        { status: spec.status, reason: spec.reason ?? null, duration_ms: spec.durationMs },
        start + spec.durationMs,
      ),
    );
  }
  return out;
}

// README snippets ----------------------------------------------------------------------------

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

interface Window {
  from: number;
  to: number;
  intervalS: number;
  engines: string[];
  sources: string[];
  causes?: string[];
  /** One bucket for the whole window, to see what a merge over several minutes gives. */
  singleBucket?: boolean;
}

const quoteList = (values: string[]) => values.map((v) => `'${v}'`).join(",");

/** The macros of the Grafana ClickHouse plugin, as documented for the data source. */
function expand(sql: string, w: Window): string {
  const sec = (ms: number) => Math.floor(ms / 1000);
  const dt = (ms: number) => `toDateTime(${sec(ms)})`;
  return sql
    .replace(/\$__timeFilter\((\w+)\)/g, (_, c) => `${c} >= ${dt(w.from)} AND ${c} <= ${dt(w.to)}`)
    .replace(/\$__timeInterval\((\w+)\)/g, (_, c) =>
      w.singleBucket
        ? `toDateTime(${sec(w.from)})`
        : `toStartOfInterval(toDateTime(${c}), INTERVAL ${w.intervalS} second)`,
    )
    .replace(/\$__fromTime/g, dt(w.from))
    .replace(/\$__toTime/g, dt(w.to))
    .replace(/\$__interval_s/g, String(w.intervalS))
    .replace(/\$\{engine:singlequote\}/g, quoteList(w.engines))
    .replace(/\$\{source:singlequote\}/g, quoteList(w.sources))
    .replace(/\$\{cause:singlequote\}/g, quoteList(w.causes ?? []));
}

const ALL_ENGINES = ["chromium", "chrome-headless-shell", "lightpanda"];
const baseWindow = (): Window => ({
  from: T0 - 5 * MIN,
  to: Date.now() + MIN,
  intervalS: 60,
  engines: ALL_ENGINES,
  sources: ["real"],
});

async function run<T = Record<string, unknown>>(
  name: string,
  w: Window = baseWindow(),
): Promise<T[]> {
  const snippets = await readmeSnippets();
  // Panels paste the session-facts query where the README says /* session-facts */.
  const sql = expand(
    (snippets.get(name) as string).replace(
      "/* session-facts */",
      snippets.get("session-facts") as string,
    ),
    w,
  );
  const result = await reader.query({ query: sql, format: "JSONEachRow" });
  return result.json<T>();
}

beforeAll(async () => {
  db = await createTestDatabase();
  // Keep the running row and the ended row of each session apart, so the tests prove that the
  // snippets read one row per session through FINAL.
  await db.client.command({
    query: "SYSTEM STOP MERGES {database:Identifier}.sessions",
    query_params: { database: db.config.database },
  });
  // Two flushes, as in production: the sessions start (a running row), and later they end.
  const events = SPECS.flatMap(eventsOf);
  await insertEvents(
    db.client,
    events.filter((e) => e.type !== "session.ended"),
  );
  await insertEvents(
    db.client,
    events.filter((e) => e.type === "session.ended"),
  );
  await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
  reader = createReaderClient(db.config, user, password);
});

afterAll(async () => {
  await reader.close();
  await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("README snippets", () => {
  it("are all covered by this file, and none needs a SETTINGS clause", async () => {
    const snippets = await readmeSnippets();
    expect([...snippets.keys()].sort()).toEqual(
      [
        "action-errors-per-minute",
        "action-latency",
        "actions-per-minute",
        "active-sessions",
        "browser-hours-and-cost",
        "cpu-mem-per-container",
        "fleet-cores-and-memory",
        "fleet-in-use-now",
        "recent-failures",
        "session-error-rate-over-time",
        "session-facts",
        "session-rates",
        "sessions-by-cause",
        "top-failure-causes",
      ].sort(),
    );
    for (const [name, sql] of snippets) expect(sql, name).not.toMatch(/\bSETTINGS\b/i);
  });
});

describe("the rollup snippets", () => {
  type Row = { time: string; engine: string };
  const byEngine = <T extends Row>(rows: T[], engine: string) =>
    rows.filter((r) => r.engine === engine).sort((a, b) => a.time.localeCompare(b.time));

  it("actions-per-minute counts real actions per minute and engine, without sim", async () => {
    const rows = await run<Row & { actions_per_min: number }>("actions-per-minute");
    expect(byEngine(rows, "chromium").map((r) => [r.time, r.actions_per_min])).toEqual([
      [iso(T0), 3],
      [iso(T0 + MIN), 2],
      [iso(T0 + 2 * MIN), 2],
      [iso(T0 + 3 * MIN), 2],
    ]);
    expect(byEngine(rows, "lightpanda").map((r) => r.actions_per_min)).toEqual([1, 1, 1]);
  });

  it("actions-per-minute divides by the bucket length when the bucket is longer than a minute", async () => {
    const [row] = await run<Row & { actions_per_min: number }>("actions-per-minute", {
      ...baseWindow(),
      engines: ["chromium"],
      intervalS: 300,
      singleBucket: true,
    });
    // nine actions in one bucket of 300 s = 5 minutes
    expect(row?.actions_per_min).toBeCloseTo(9 / 5, 9);
  });

  it("action-errors-per-minute counts failed actions (this is not the error rate)", async () => {
    const rows = await run<Row & { action_errors_per_min: number }>("action-errors-per-minute");
    // int1's cut-off action is in here: the rollup cannot know the session was interrupted
    expect(byEngine(rows, "chromium").map((r) => r.action_errors_per_min)).toEqual([0, 0, 1, 1]);
    expect(byEngine(rows, "lightpanda").map((r) => r.action_errors_per_min)).toEqual([1, 1, 0]);
  });

  it("the source filter works: sim actions only appear when asked for", async () => {
    const sim = await run<Row & { actions_per_min: number }>("actions-per-minute", {
      ...baseWindow(),
      sources: ["sim"],
    });
    // sim1 (1 action) and deg1 (2 actions)
    expect(sim.map((r) => [r.engine, r.actions_per_min])).toEqual([["chromium", 3]]);
  });

  it("action-latency gives p50 and p95 per minute", async () => {
    const rows = await run<Row & { p50_ms: number; p95_ms: number }>("action-latency");
    const chromium = byEngine(rows, "chromium");
    expect(chromium[0]?.p50_ms).toBe(200); // [100, 200, 300]
    expect(chromium[0]?.p95_ms).toBeCloseTo(290, 5);
    expect(chromium[2]?.p50_ms).toBe(300); // [100, 500]
    expect(chromium[2]?.p95_ms).toBeCloseTo(480, 5);
  });

  it("a percentile over several minutes is merged from the states, not an average of percentiles", async () => {
    const [merged] = await run<Row & { p50_ms: number }>("action-latency", {
      ...baseWindow(),
      engines: ["chromium"],
      singleBucket: true,
    });
    // all nine real chromium actions: 50 50 100 100 150 200 250 300 500 -> median 150.
    // The mean of the four per-minute medians (200, 200, 300, 50) would be 187.5.
    expect(merged?.p50_ms).toBe(150);
  });

  it("a minute with samples but no actions has no latency (NULL), not nan", async () => {
    const lonely = `lonely_${randomBytes(3).toString("hex")}`;
    await insertEvents(db.client, [
      newEvent(
        "resource.sample",
        {
          session_id: lonely,
          source: "real",
          agent_id: "x",
          engine: "chrome-headless-shell",
          provider: "local-docker",
        },
        { origin: "container", cpu_pct: 5, mem_mb: 50, net_rx_bytes: 1, net_tx_bytes: 1 },
        T0 + 7 * MIN + 1000,
      ),
    ]);
    const rows = await run<Row & { p50_ms: number | null }>("action-latency", {
      ...baseWindow(),
      engines: ["chrome-headless-shell"],
    });
    expect(rows).toEqual([
      { time: iso(T0 + 7 * MIN), engine: "chrome-headless-shell", p50_ms: null, p95_ms: null },
    ]);
  });

  it("cpu-mem-per-container divides the sums by the sample count, and leaves a gap where there are no samples", async () => {
    const rows = await run<
      Row & { cpu_pct_per_container: number | null; mem_mib_per_container: number | null }
    >("cpu-mem-per-container", { ...baseWindow(), engines: ["chromium"] });
    const chromium = byEngine(rows, "chromium");
    expect(chromium[0]).toMatchObject({ cpu_pct_per_container: 20, mem_mib_per_container: 200 });
    expect(chromium[1]).toMatchObject({
      cpu_pct_per_container: null,
      mem_mib_per_container: null,
    });
  });

  it("fleet-cores-and-memory turns the 2 second samples into cores and MiB", async () => {
    const rows = await run<Row & { cores_in_use: number; memory_mib_in_use: number }>(
      "fleet-cores-and-memory",
      { ...baseWindow(), engines: ["chromium"] },
    );
    const first = byEngine(rows, "chromium")[0];
    // minute 0: cpu sum 40 %, mem sum 400 MiB, two samples of 2 s in a 60 s bucket
    expect(first?.cores_in_use).toBeCloseTo((40 / 100) * (2 / 60), 9);
    expect(first?.memory_mib_in_use).toBeCloseTo(400 * (2 / 60), 9);
  });

  it("fleet-in-use-now adds the latest sample of each running session", async () => {
    // run1 is the only running session; give it two recent samples, the later one counts
    const ctx: EventEnvelope = {
      session_id: "run1",
      source: "real",
      agent_id: "dash-test",
      engine: "chromium",
      provider: "local-docker",
    };
    const now = Date.now();
    const sample = (cpu: number, mem: number, at: number) =>
      newEvent(
        "resource.sample",
        ctx,
        { origin: "container", cpu_pct: cpu, mem_mb: mem, net_rx_bytes: 1, net_tx_bytes: 1 },
        at,
      );
    await insertEvents(db.client, [sample(400, 111, now - 20_000), sample(150, 222, now - 10_000)]);
    const [row] = await run<{
      cores_in_use: number;
      memory_mib_in_use: number;
      containers: number;
    }>("fleet-in-use-now");
    expect(row).toEqual({ cores_in_use: 1.5, memory_mib_in_use: 222, containers: 1 });
  });
});

describe("the session snippets", () => {
  it("active-sessions counts a session in every minute from its start to its end (or now)", async () => {
    const rows = await run<{ time: string; engine: string; active_sessions: number }>(
      "active-sessions",
    );
    const got = new Map(rows.map((r) => [`${r.engine}@${r.time}`, r.active_sessions]));

    // an independent calculation of the same rule, for the first ten minutes (the running
    // session's tail up to "now" is not compared, to stay clear of the minute boundary)
    const expected = new Map<string, number>();
    for (const spec of SPECS.filter((s) => (s.source ?? "real") === "real")) {
      const start = Math.floor((T0 + spec.startMin * MIN) / MIN) * MIN;
      const end =
        spec.status === "running"
          ? T0 + 10 * MIN
          : Math.floor((T0 + spec.startMin * MIN + spec.durationMs) / MIN) * MIN;
      for (let m = start; m <= Math.min(end, T0 + 10 * MIN); m += MIN) {
        const key = `${spec.engine}@${iso(m)}`;
        expected.set(key, (expected.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of expected) expect(got.get(key), key).toBe(count);
    // the running session is still counted long after it started
    expect(got.get(`chromium@${iso(T0 + 8 * MIN)}`)).toBe(1);
  });

  it("works while ClickHouse still holds both versions of every session (merges are stopped for this test)", async () => {
    const result = await db.client.query({
      query: "SELECT count() AS n, uniqExact(session_id) AS sessions FROM sessions",
      format: "JSONEachRow",
    });
    const [raw] = await result.json<{ n: number; sessions: number }>();
    // 11 running rows plus 10 ended rows for 11 sessions: without FINAL every ended session would count twice
    expect(raw).toEqual({ n: 21, sessions: 11 });
  });

  describe("session-facts", () => {
    type Fact = {
      session_id: string;
      display_status: string;
      cause: string | null;
      cause_from: string | null;
      is_interrupted: number;
      actions: number;
      failed_actions: number;
      issue_count: number;
      time_to_browser_ms: number;
    };
    const facts = async (w?: Window) => {
      const rows = await run<Fact>("session-facts", w);
      return Object.fromEntries(rows.map((r) => [r.session_id, r]));
    };

    it("returns one row per session with its display status", async () => {
      const f = await facts();
      expect(Object.keys(f).sort()).toEqual(
        ["block1", "fail1", "int1", "ok1", "ok2", "run1", "to1", "unk1"].sort(),
      );
      expect(
        Object.fromEntries(Object.entries(f).map(([id, r]) => [id, r.display_status])),
      ).toEqual({
        ok1: "healthy",
        ok2: "healthy",
        fail1: "failed",
        int1: "interrupted",
        run1: "running",
        block1: "blocked",
        to1: "failed", // status timeout shows as Failed
        unk1: "failed",
      });
      expect(f.ok1).toMatchObject({
        actions: 3,
        failed_actions: 0,
        issue_count: 0,
        time_to_browser_ms: 1500,
      });
      expect(f.block1).toMatchObject({ failed_actions: 1, issue_count: 1 });
    });

    it("a successful session with a failed action is degraded (sim data)", async () => {
      const f = await facts({ ...baseWindow(), sources: ["sim"] });
      expect(f.deg1).toMatchObject({ display_status: "degraded", failed_actions: 1, cause: null });
      expect(f.sim1?.display_status).toBe("healthy");
    });

    it("gives one cause per failed session: the first issue, else the first failed action, else the status", async () => {
      const f = await facts();
      expect(f.block1).toMatchObject({ cause: "blocked", cause_from: "issue" });
      expect(f.fail1).toMatchObject({ cause: "selector_not_found", cause_from: "action" });
      expect(f.to1).toMatchObject({ cause: "timeout", cause_from: "action" });
      expect(f.unk1).toMatchObject({ cause: "failed", cause_from: "status" });
    });

    it("has no cause for sessions that are healthy, running or interrupted", async () => {
      const f = await facts();
      for (const id of ["ok1", "ok2", "run1", "int1"]) {
        expect(f[id], id).toMatchObject({ cause: null, cause_from: null });
      }
      expect(f.int1?.is_interrupted).toBe(1);
    });

    it("finds a session that started before the range but ended inside it, with its issues and actions", async () => {
      // the window opens after block1 started (T0+1m) and before it ended (T0+1m20s)
      const w = { ...baseWindow(), from: T0 + MIN + 10_000, engines: ["lightpanda"] };
      const f = await facts(w);
      expect(f.block1).toMatchObject({ cause: "blocked", cause_from: "issue", failed_actions: 1 });
    });
  });

  it("session-rates excludes interrupted and running sessions from the rates and counts them apart", async () => {
    const rows = await run<Record<string, number | string | null>>("session-rates");
    const chromium = rows.find((r) => r.engine === "chromium");
    expect(chromium).toMatchObject({
      ended: 3, // ok1, ok2, fail1: not int1 (interrupted), not run1 (running)
      healthy: 2,
      degraded: 0,
      failed: 1,
      blocked: 0,
      interrupted: 1,
    });
    expect(chromium?.success_rate).toBeCloseTo(100 * (2 / 3), 9);
    expect(chromium?.error_rate).toBeCloseTo(100 * (1 / 3), 9);

    const lightpanda = rows.find((r) => r.engine === "lightpanda");
    // blocked, timeout and failed all count against the engine
    expect(lightpanda).toMatchObject({
      ended: 3,
      healthy: 0,
      failed: 2,
      blocked: 1,
      interrupted: 0,
    });
    expect(lightpanda?.success_rate).toBe(0);
    expect(lightpanda?.error_rate).toBe(100);
  });

  it("session-rates counts a degraded session as a success, and returns no row when nothing ended", async () => {
    const sim = await run<Record<string, number>>("session-rates", {
      ...baseWindow(),
      sources: ["sim"],
    });
    expect(sim).toHaveLength(1);
    expect(sim[0]).toMatchObject({
      engine: "chromium",
      ended: 3,
      healthy: 2,
      degraded: 1,
      success_rate: 100,
      error_rate: 0,
    });

    // a window in which no session ended: no rows, so no verdict (the panel maps that to "No ended sessions")
    const none = await run("session-rates", {
      ...baseWindow(),
      from: T0 - 3 * 60 * MIN,
      to: T0 - 2 * 60 * MIN,
    });
    expect(none).toEqual([]);
  });

  it("session-error-rate-over-time buckets by the minute a session ended, interrupted excluded", async () => {
    type R = { time: string; engine: string; error_rate: number };
    const rows = await run<R>("session-error-rate-over-time");
    const pick = (engine: string) =>
      rows
        .filter((r) => r.engine === engine)
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((r) => [r.time, r.error_rate]);
    // ok1 ended at T0+1m, fail1 at T0+2m30s, ok2 at T0+3m; int1 (T0+3m10s) is left out
    expect(pick("chromium")).toEqual([
      [iso(T0 + MIN), 0],
      [iso(T0 + 2 * MIN), 100],
      [iso(T0 + 3 * MIN), 0],
    ]);
    // block1 ended at T0+1m20s, to1 at T0+3m, unk1 at T0+3m05s
    expect(pick("lightpanda")).toEqual([
      [iso(T0 + MIN), 100],
      [iso(T0 + 3 * MIN), 100],
    ]);
  });

  it("recent-failures lists real failures with their cause and leaves out interrupted, running and successful sessions", async () => {
    const rows = await run<{
      session_id: string;
      status: string;
      reason: string;
      cause: string;
      cause_from: string;
    }>("recent-failures");
    expect(Object.fromEntries(rows.map((r) => [r.session_id, [r.cause, r.cause_from]]))).toEqual({
      fail1: ["selector_not_found", "action"],
      block1: ["blocked", "issue"],
      to1: ["timeout", "action"],
      unk1: ["failed", "status"],
    });
    expect(rows.find((r) => r.session_id === "block1")).toMatchObject({
      status: "blocked",
      reason: "bot wall",
    });
    // newest end first: unk1 ended at T0+3m05s
    expect(rows[0]?.session_id).toBe("unk1");
  });

  it("top-failure-causes groups the causes and names the engines", async () => {
    const rows = await run<{
      cause: string;
      cause_from: string;
      sessions: number;
      engines: string;
    }>("top-failure-causes");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.sessions === 1)).toBe(true);
    expect(rows.find((r) => r.cause === "blocked")).toMatchObject({
      cause_from: "issue",
      engines: "lightpanda 1",
    });
    expect(rows.find((r) => r.cause === "selector_not_found")?.engines).toBe("chromium 1");
  });

  it("sessions-by-cause lists each session once for the causes chosen in the cause variable", async () => {
    const rows = await run<{ session_id: string; cause: string }>("sessions-by-cause", {
      ...baseWindow(),
      causes: ["timeout", "blocked"],
    });
    expect(rows.map((r) => r.session_id).sort()).toEqual(["block1", "to1"]);
    expect(await run("sessions-by-cause", { ...baseWindow(), causes: ["nope"] })).toEqual([]);
  });

  it("browser-hours-and-cost adds startup and connect time, counts a running session until now, and prices through pricing_current", async () => {
    const rows = await run<{
      engine: string;
      sessions: number;
      browser_hours: number;
      estimated_cost_usd: number;
      unpriced_sessions: number;
    }>("browser-hours-and-cost");

    const chromium = rows.find((r) => r.engine === "chromium");
    // ended: ok1 61.5 s, ok2 123 s, fail1 31.5 s, int1 11.5 s (interrupted still used a browser)
    const endedMs = 61_500 + 123_000 + 31_500 + 11_500;
    // run1: 1.5 s of startup + connect, plus the time since it started (26 to 27 minutes)
    expect(chromium?.sessions).toBe(5);
    expect(chromium?.browser_hours).toBeGreaterThan(hours(endedMs + 1_500 + 26 * MIN));
    expect(chromium?.browser_hours).toBeLessThan(hours(endedMs + 1_500 + 28 * MIN));
    expect(chromium?.estimated_cost_usd).toBeCloseTo((chromium?.browser_hours ?? 0) * 0.1, 9);
    expect(chromium?.unpriced_sessions).toBe(0);

    const lightpanda = rows.find((r) => r.engine === "lightpanda");
    expect(lightpanda?.browser_hours).toBeCloseTo(hours(20_300 + 60_300 + 5_300), 9);
  });

  it("browser-hours-and-cost counts sessions that have no price instead of pricing them at zero", async () => {
    const [chromium] = await run<{
      sessions: number;
      browser_hours: number;
      estimated_cost_usd: number;
      unpriced_sessions: number;
    }>("browser-hours-and-cost", { ...baseWindow(), sources: ["sim"] });
    // sim1 and deg1 (local-docker) are priced, mys1 (provider "mystery") has no price
    expect(chromium?.sessions).toBe(3);
    expect(chromium?.unpriced_sessions).toBe(1);
    expect(chromium?.browser_hours).toBeCloseTo(hours(3 * 36_000), 9);
    expect(chromium?.estimated_cost_usd).toBeCloseTo(hours(2 * 36_000) * 0.1, 9);
  });
});
