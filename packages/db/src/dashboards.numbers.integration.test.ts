import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DashboardRunner,
  expandedSql,
  insertSpecs,
  MIN,
  num,
  type Range,
  type Row,
  type SessionSpec,
  toClickHouse,
} from "../fixtures/dashboards";
import { knownFleet, R5_ID, spec } from "../fixtures/known-fleet";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";

/**
 * QA M2: the numbers the dashboards show, checked against a known fleet worked out by hand.
 *
 * This runs the SQL that is stored in infra/grafana/dashboards/*.json (not the README snippets, which
 * the backend's dashboard-sql test already covers) as the read-only Grafana user, with the macros
 * and variables expanded by the same code `pnpm grafana:check` uses.
 *
 * Time model: T0 is 2 hours ago, aligned to 5 minutes. The range is [T0, T0 + 60 min], so it is in
 * the past and only the running sessions depend on "now". Every session starts on a whole minute and
 * its actions are at start + 1.0 s, + 1.1 s ..., so each session's actions sit in its start minute.
 *
 * The fleet (REAL sessions, minutes after T0, [duration of the action, error_code]):
 *
 *  id   engine   status       start  dur    startup+connect  actions                       notes
 *  R1   chromium success      5      60 s   1000+500         100, 200                      healthy; cpu 10,30 mem 100,300; heap 38.5,40.5; 3 requests
 *  R2   chromium success      10     120 s  2000+1000        300                           healthy; cpu 20,40 mem 200,150
 *  R3   chromium success      12     30 s   1000+1000        400 timeout, 100              degraded (a retry)
 *  R4   chromium success      14     30 s   0+0              50                            degraded (issue unsupported_api)
 *  R5   chromium failed       16     10 s   1000+1000        100, 500 selector_not_found  failed, cause selector_not_found (action); UUID id
 *  R6   chromium failed       18     10 s   1000+1000        100 selector_not_found       failed, issue captcha wins the cause
 *  R7   chromium failed       20     5 s    1000+500         10, 10 browser_closed         reason "interrupted" -> interrupted
 *  R8   chromium (running)    30     -      1000+500         20                            never ended
 *  R9   lightpanda blocked    11     20 s   200+100          40 http_403                   issue captcha; version 0.2.8
 *  R10  lightpanda timeout    13     60 s   200+100          60 timeout                    failed, cause timeout (action)
 *  R11  lightpanda crashed    15     8 s    200+100          30                            failed, cause "crashed" (status); version null
 *  R12  lightpanda success    17     40 s   200+100          80, 90                        healthy; cpu 5,15 mem 50,90; heap null,null; version 0.2.9
 *  R13  headless  success     19     20 s   500+250          70                            healthy, no samples
 *  R14  chromium failed       -3     300 s  1000+500         100 selector_not_found       started BEFORE the range, ended at +2 min (inside)
 *  R15  chromium success      70     1 s                                                    after the range
 *  R16  chromium success      -30    60 s                                                   ended before the range
 * SIM: S1 chromium success (+6, 36 s, 0+0, action 900), S2 lightpanda failed (+8, 5 s, unsupported_api),
 *      S3 chromium success with provider "mystery" (+9, 36 s): no price.
 */

let db: TestDatabase;
let admin: ClickHouseClient;
let dash: DashboardRunner;
const user = `fleetscope_qa_${randomBytes(4).toString("hex")}`;
const password = "qa-dashboard-password";

const T0 = Math.floor((Date.now() - 120 * MIN) / (5 * MIN)) * (5 * MIN);
const m = (minutes: number) => T0 + minutes * MIN;
const RANGE: Range = { from: m(0), to: m(60) };
const PRICE = 0.1; // $ per browser-hour, migration 0008
const cost = (ms: number) => (ms / 3_600_000) * PRICE;

const REAL = { source: "real" as const };

const one = async (
  name: "overview" | "sessions" | "session",
  where: string,
  filters = {},
  range = RANGE,
) => {
  const rows = await dash.run(name, where, range, filters);
  expect(rows, `${where} should return one row`).toHaveLength(1);
  return rows[0] as Row;
};
const col = (rows: Row[], name: string) => rows.map((r) => r[name]);

beforeAll(async () => {
  db = await createTestDatabase();
  admin = db.client;
  // keep both versions of every session row apart: the dashboards must read them through FINAL
  await admin.command({
    query: "SYSTEM STOP MERGES {database:Identifier}.sessions",
    query_params: { database: db.config.database },
  });
  await insertSpecs((events) => insertEvents(admin, events), knownFleet(T0));
  await ensureGrafanaUser(admin, { user, password, database: db.config.database });
  dash = new DashboardRunner({ url: db.config.url, user, password, database: db.config.database });
});

afterAll(async () => {
  await admin.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("Overview: verdict, outcomes, KPIs (source = real)", () => {
  it("the verdict is the success rate of the 12 sessions that ended, interrupted and running left out", async () => {
    // ended (non-interrupted) in range: R1-R6, R9-R13, R14 = 12; succeeded: R1 R2 R3 R4 R12 R13 = 6
    const row = await one("overview", 'panel "Fleet verdict ↗", query A', REAL);
    expect(num(row.ended)).toBe(12);
    expect(num(row.success_rate)).toBeCloseTo(50, 9);
    expect(row.verdict).toBe("failed");
  });

  it("Outcomes counts each display status once", async () => {
    const row = await one("overview", 'panel "Outcomes ↗", query A', REAL);
    expect([row.healthy, row.degraded, row.failed, row.blocked].map(num)).toEqual([4, 2, 5, 1]);
    // 4 + 2 + 5 + 1 = 12 = the ended count of the verdict
  });

  it("Success rate, Sessions and Interrupted agree with the verdict", async () => {
    expect(
      num((await one("overview", 'panel "Success rate ↗", query A', REAL)).success_rate),
    ).toBeCloseTo(50, 9);
    // started in range: R1-R13 = 13 (R14 started before, R15 after, R16 before)
    expect(num((await one("overview", 'panel "Sessions ↗", query A', REAL)).session_count)).toBe(
      13,
    );
    expect(num((await one("overview", 'panel "Interrupted ↗", query A', REAL)).interrupted)).toBe(
      1,
    );
  });

  it("a session that started before the range and ended inside counts in the outcomes but not in Sessions or cost", async () => {
    // R14 only: engine chromium, range starting at +1 min so R1..R8 are the only others; compare with and without it
    const onlyEdge: Range = { from: m(1), to: m(3) };
    const verdict = await one("overview", 'panel "Fleet verdict ↗", query A', REAL, onlyEdge);
    expect([num(verdict.ended), verdict.verdict]).toEqual([1, "failed"]);
    expect(
      num((await one("overview", 'panel "Sessions ↗", query A', REAL, onlyEdge)).session_count),
    ).toBe(0);
    expect(
      num(
        (await one("overview", 'panel "Estimated cost ↗", query A', REAL, onlyEdge))
          .estimated_cost_usd,
      ),
    ).toBe(0);
  });

  it("Simulated share is sim / all sessions started in range, and follows the filters", async () => {
    const all = await one("overview", 'panel "Simulated share ↗", query A'); // 3 sim of 16
    expect(num(all.simulated_share)).toBeCloseTo(18.75, 9);
    expect(
      num(
        (await one("overview", 'panel "Simulated share ↗", query A', { source: "sim" }))
          .simulated_share,
      ),
    ).toBe(100);
    expect(
      num((await one("overview", 'panel "Simulated share ↗", query A', REAL)).simulated_share),
    ).toBe(0);
  });

  it("sim data stays out of the real numbers and has its own: 2 of 3 succeeded", async () => {
    const row = await one("overview", 'panel "Fleet verdict ↗", query A', { source: "sim" });
    expect(num(row.ended)).toBe(3);
    expect(num(row.success_rate)).toBeCloseTo(66.666666667, 6);
    // default (source All) adds both: 8 of 15
    const both = await one("overview", 'panel "Fleet verdict ↗", query A');
    expect(num(both.ended)).toBe(15);
    expect(num(both.success_rate)).toBeCloseTo(53.333333333, 6);
  });

  it("a range with no ended session is no_data and a null rate, not 0", async () => {
    const empty: Range = { from: m(100), to: m(110) };
    const row = await one("overview", 'panel "Fleet verdict ↗", query A', {}, empty);
    expect([num(row.ended), row.success_rate, row.verdict]).toEqual([0, null, "no_data"]);
    expect(
      (await one("overview", 'panel "Success rate ↗", query A', {}, empty)).success_rate,
    ).toBeNull();
  });

  it("p95 action latency is merged from the rollup and equals the interpolated p95 of the raw rows", async () => {
    // 18 real actions in range, sorted: 10 10 20 30 40 50 60 70 80 90 100 100 100 100 200 300 400 500
    // position (18-1) * 0.95 = 16.15 -> 400 + 0.15 * (500 - 400) = 415. R14/R15/R16 actions are outside the range.
    const kpi = await one("overview", 'panel "p95 action latency ↗", query A', REAL);
    expect(num(kpi.p95_ms)).toBeCloseTo(415, 6);
    const raw = await dash.rows(
      `SELECT quantile(0.95)(duration_ms) AS p FROM actions WHERE source = 'real' AND ts >= toDateTime(${m(0) / 1000}) AND ts <= toDateTime(${m(60) / 1000})`,
    );
    expect(num(raw[0]?.p)).toBeCloseTo(415, 6);
    // lightpanda only: 30 40 60 80 90 -> position 3.8 -> 80 + 0.8 * 10 = 88
    const lp = await one("overview", 'panel "p95 action latency ↗", query A', {
      ...REAL,
      engines: ["lightpanda"],
    });
    expect(num(lp.p95_ms)).toBeCloseTo(88, 6);
  });

  it("p95 is NULL, not 0 or nan, when there are no actions", async () => {
    const row = await one(
      "overview",
      'panel "p95 action latency ↗", query A',
      {},
      { from: m(100), to: m(110) },
    );
    expect(row.p95_ms).toBeNull();
  });

  it("Estimated cost = browser-hours (startup + connect + duration) x $0.10", async () => {
    // lightpanda + headless-shell, real: R9 20300 + R10 60300 + R11 8300 + R12 40300 + R13 20750 = 149950 ms
    const row = await one("overview", 'panel "Estimated cost ↗", query A', {
      ...REAL,
      engines: ["lightpanda", "chrome-headless-shell"],
    });
    expect(num(row.estimated_cost_usd)).toBeCloseTo(cost(149_950), 9);
  });

  it("Estimated cost counts a running session until now", async () => {
    // chromium real started in range: R1-R7 = 61500+123000+32000+30000+12000+12000+6500 = 277000 ms,
    // plus R8 running: 1500 + (now - start of R8)
    const before = Date.now();
    const row = await one("overview", 'panel "Estimated cost ↗", query A', {
      ...REAL,
      engines: ["chromium"],
    });
    const after = Date.now();
    const low = cost(277_000 + 1500 + (before - m(30)) - 2000);
    const high = cost(277_000 + 1500 + (after - m(30)) + 2000);
    expect(num(row.estimated_cost_usd)).toBeGreaterThan(low);
    expect(num(row.estimated_cost_usd)).toBeLessThan(high);
  });

  it("Estimated cost is NULL (Not available), not a partial sum, when a session has no price", async () => {
    // S3 has provider "mystery"; S1 alone is priced: 36000 ms
    const sim = await one("overview", 'panel "Estimated cost ↗", query A', {
      source: "sim",
      engines: ["chromium"],
    });
    expect(sim.estimated_cost_usd).toBeNull();
    const lp = await one("overview", 'panel "Estimated cost ↗", query A', {
      source: "sim",
      engines: ["lightpanda"],
    });
    expect(num(lp.estimated_cost_usd)).toBeCloseTo(cost(5000), 12);
  });
});

describe("Overview: charts", () => {
  const series = (rows: Row[], engine: string) =>
    rows
      .filter((r) => r.engine === engine)
      .map((r) => [r.time, num(r.error_rate) ?? r.error_rate] as const)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const bucket = (minutes: number) => toClickHouse(m(minutes));

  it("Error rate by engine is per session, per 5 minute bucket of ended_at, interrupted excluded", async () => {
    const rows = await dash.run("overview", 'panel "Error rate by engine ↗", query A', RANGE, REAL);
    // chromium: +0 R14 failed 1/1; +5 R1 0/1; +10 R2 R3 R4 0/3; +15 R5 R6 2/2; +20 only R7 (interrupted): NULL, not 0 or 100
    expect(series(rows, "chromium")).toEqual([
      [bucket(0), 100],
      [bucket(5), 0],
      [bucket(10), 0],
      [bucket(15), 100],
      [bucket(20), null],
    ]);
    // lightpanda: +10 R9 blocked, R10 timeout: 2/2; +15 R11 crashed, R12 success: 1/2
    expect(series(rows, "lightpanda")).toEqual([
      [bucket(10), 100],
      [bucket(15), 50],
    ]);
    expect(series(rows, "chrome-headless-shell")).toEqual([[bucket(15), 0]]);
  });

  it("Actions per minute equals the raw action count per minute and engine (source = real)", async () => {
    const rollup = await dash.run(
      "overview",
      'panel "Actions per minute by engine ↗", query A',
      RANGE,
      REAL,
    );
    const raw = await dash.rows(`
      SELECT toString(toStartOfMinute(toDateTime(ts))) AS time, engine, count() AS n
      FROM actions
      WHERE source = 'real' AND ts >= toDateTime(${m(0) / 1000}) AND ts <= toDateTime(${m(60) / 1000})
      GROUP BY time, engine ORDER BY time, engine`);
    const key = (r: Row, v: unknown) => `${r.time} ${r.engine} ${num(v)}`;
    expect(rollup.map((r) => key(r, r.actions_per_min)).sort()).toEqual(
      raw.map((r) => key(r, r.n)).sort(),
    );
  });

  it("Active sessions counts a session in every minute from its start to its end (running: until the end of the range)", async () => {
    const rows = await dash.run(
      "overview",
      'panel "Active sessions by engine ↗", query A',
      RANGE,
      REAL,
    );
    const at = (engine: string) =>
      new Map(
        rows
          .filter((r) => r.engine === engine)
          .map((r) => [String(r.time), num(r.active_sessions)]),
      );
    const lp = at("lightpanda");
    // R9 11:00-11:20, R10 13:00-14:00 (the end minute counts), R11 15:00-15:08, R12 17:00-17:40
    expect([...lp.entries()].sort()).toEqual(
      [11, 13, 14, 15, 17].map((x) => [toClickHouse(m(x)), 1] as const).sort(),
    );
    const cr = at("chromium");
    expect(cr.get(toClickHouse(m(12)))).toBe(2); // R2 (10:00-12:00) and R3 (12:00-12:30)
    expect(cr.get(toClickHouse(m(11)))).toBe(1);
    expect(cr.get(toClickHouse(m(0)))).toBe(1); // R14 started at -3, clipped to the range start
    expect(cr.get(toClickHouse(m(2)))).toBe(1);
    expect(cr.get(toClickHouse(m(3)))).toBeUndefined();
    // R8 is still running: 30..60 inclusive, 31 minutes, 1 each
    for (let x = 30; x <= 60; x++) expect(cr.get(toClickHouse(m(x))), `minute ${x}`).toBe(1);
  });
});

describe("Overview: By engine, Recent failures, Top failure causes", () => {
  it("By engine has one row per engine with hand-computed numbers", async () => {
    const rows = await dash.run("overview", 'panel "By engine ↗", query A', RANGE, REAL);
    const by = Object.fromEntries(rows.map((r) => [r.engine as string, r]));
    expect(Object.keys(by).sort()).toEqual(["chrome-headless-shell", "chromium", "lightpanda"]);

    const c = by.chromium as Row;
    expect(c.version).toBe("1.0.0");
    expect(num(c.sessions)).toBe(8); // R1-R8
    expect(num(c.success_rate)).toBeCloseTo((4 / 7) * 100, 9); // ended R1-R6, R14 = 7; R1 R2 R3 R4 succeeded
    expect(c.status).toBe("failed");
    // 12 actions: 10 10 20 50 100 100 100 100 200 300 400 500 -> position 10.45 -> 400 + 0.45 * 100 = 445
    expect(num(c.p95_ms)).toBeCloseTo(445, 6);
    expect(num(c.cpu_pct)).toBeCloseTo(25, 6); // (10 + 30 + 20 + 40) / 4 samples
    expect(num(c.avg_peak_mib)).toBeCloseTo(250, 6); // peaks 300 (R1) and 200 (R2)
    expect(c.top_cause).toBe("selector_not_found ×2"); // R5 and R14 (captcha ×1)
    expect(num(c.active_now)).toBe(0);
    expect(num(c.estimated_cost_usd)).toBeGreaterThan(cost(277_000 + 1500));

    const l = by.lightpanda as Row;
    expect(l.version).toBe("0.2.9"); // the newest start with a version; R11 in between has none
    expect(num(l.sessions)).toBe(4);
    expect(num(l.success_rate)).toBeCloseTo(25, 9);
    expect(l.status).toBe("failed");
    expect(num(l.p95_ms)).toBeCloseTo(88, 6);
    expect(num(l.cpu_pct)).toBeCloseTo(10, 6);
    expect(num(l.avg_peak_mib)).toBeCloseTo(90, 6);
    expect(num(l.estimated_cost_usd)).toBeCloseTo(cost(129_200), 9);
    expect(l.top_cause).toBe("captcha ×1"); // a three-way tie: the first name alphabetically (README)

    const h = by["chrome-headless-shell"] as Row;
    expect(num(h.success_rate)).toBe(100);
    expect(h.status).toBe("healthy");
    expect(num(h.p95_ms)).toBe(70);
    // no samples at all: NULL ("Not available"), never 0
    expect(h.cpu_pct).toBeNull();
    expect(h.avg_peak_mib).toBeNull();
    expect(h.top_cause).toBeNull();
    expect(num(h.estimated_cost_usd)).toBeCloseTo(cost(20_750), 9);
  });

  it("Recent failures lists the 6 non-successful, non-interrupted sessions that ended in range, newest first", async () => {
    const rows = await dash.run("overview", 'panel "Recent failures ↗", query A', RANGE, REAL);
    // newest ended first: R6 (18:10) R5 (16:10) R11 (15:08) R10 (14:00) R9 (11:20) R14 (2:00)
    expect(col(rows, "session_id")).toEqual(["R6", R5_ID, "R11", "R10", "R9", "R14"]);
    expect(col(rows, "status")).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "blocked",
      "failed",
    ]);
    expect(col(rows, "cause_text")).toEqual([
      "captcha: boom",
      "selector_not_found: selector not found",
      "crashed: oom",
      "timeout: exceeded 60s",
      "captcha: bot wall",
      "selector_not_found: x",
    ]);
    // a UUID is shortened to its first 8 characters, other ids are kept as they are
    expect(col(rows, "session")).toEqual(["R6", "e5d1c0de", "R11", "R10", "R9", "R14"]);
    const r5 = rows.find((r) => r.session_id === R5_ID) as Row;
    expect(num(r5.from_ms)).toBe(m(16) - 5000);
    expect(num(r5.to_ms)).toBe(m(16) + 10_000 + 5000);
    expect(rows.every((r) => r.source === "real")).toBe(true);
    expect(col(rows, "session_id")).not.toContain("R7"); // interrupted
    expect(col(rows, "session_id")).not.toContain("R8"); // running
  });

  it("Top failure causes: one cause per session, the first issue before the first failed action before the status", async () => {
    const rows = await dash.run("overview", 'panel "Top failure causes ↗", query A', RANGE, REAL);
    expect(rows.map((r) => [r.cause, r.cause_from, num(r.sessions)])).toEqual([
      ["captcha", "issue", 2], // R6 (chromium), R9 (lightpanda); R6 also has a failed selector action, the issue wins
      ["selector_not_found", "action", 2], // R5, R14
      ["crashed", "status", 1], // R11: no issue, no failed action
      ["timeout", "action", 1], // R10
    ]);
    // R7's browser_closed (interrupted) and the sim unsupported_api never show up
    expect(col(rows, "cause")).not.toContain("browser_closed");
    expect(col(rows, "cause")).not.toContain("unsupported_api");
    const captcha = rows[0] as Row;
    expect(String(captcha.engines).split(", ").sort()).toEqual(["chromium 1", "lightpanda 1"]);
    expect(captcha.session_id).toBe("R6"); // the latest one that ended with that cause
    expect(num(captcha.from_ms)).toBe(m(18) - 5000);
    expect(num(captcha.to_ms)).toBe(m(18) + 10_000 + 5000);
    expect(String((rows[1] as Row).engines)).toBe("chromium 2");
  });

  it("with sim included the sim cause appears and is the only unsupported_api", async () => {
    const rows = await dash.run("overview", 'panel "Top failure causes ↗", query A', RANGE, {
      source: "sim",
    });
    expect(rows.map((r) => [r.cause, num(r.sessions)])).toEqual([["unsupported_api", 1]]);
  });
});

describe("Overview: the rollup against the raw tables", () => {
  it("fleet_minute counts, errors and container averages equal the raw tables for every (minute, engine, source)", async () => {
    const rollup = await dash.rows(`
      SELECT toString(minute) AS minute, engine, source,
             countMerge(actions) AS actions, countMerge(action_errors) AS errors,
             countMerge(samples) AS samples, sumMerge(cpu_pct_sum) AS cpu_sum, sumMerge(mem_mb_sum) AS mem_sum
      FROM fleet_minute GROUP BY minute, engine, source ORDER BY minute, engine, source`);
    const raw = await dash.rows(`
      SELECT minute, engine, source, sum(a) AS actions, sum(e) AS errors, sum(s) AS samples, sum(c) AS cpu_sum, sum(mm) AS mem_sum FROM (
        SELECT toString(toStartOfMinute(toDateTime(ts))) AS minute, engine, source, count() AS a, countIf(NOT ok) AS e, 0 AS s, 0.0 AS c, 0.0 AS mm
        FROM actions GROUP BY minute, engine, source
        UNION ALL
        SELECT toString(toStartOfMinute(toDateTime(ts))), engine, source, 0, 0, count(), sum(toFloat64(cpu_pct)), sum(toFloat64(mem_mb))
        FROM resource_samples WHERE origin = 'container' GROUP BY 1, 2, 3
      ) GROUP BY minute, engine, source ORDER BY minute, engine, source`);
    const norm = (rows: Row[]) =>
      rows.map((r) => [
        r.minute,
        r.engine,
        r.source,
        num(r.actions),
        num(r.errors),
        num(r.samples),
        Math.round(Number(r.cpu_sum)),
        Math.round(Number(r.mem_sum)),
      ]);
    expect(norm(rollup)).toEqual(norm(raw));
  });

  it("the rollup counts the actions of an interrupted session (documented), the session rates do not", async () => {
    const errors = await dash.rows(
      `SELECT countMerge(action_errors) AS n FROM fleet_minute WHERE engine = 'chromium' AND source = 'real' AND minute = toDateTime(${m(20) / 1000})`,
    );
    expect(num(errors[0]?.n)).toBe(1); // R7's cut-off action
    const verdict = await one(
      "overview",
      'panel "Fleet verdict ↗", query A',
      { ...REAL, engines: ["chromium"] },
      { from: m(19), to: m(21) },
    );
    expect(num(verdict.ended)).toBe(0); // R7 is not counted as ended
  });
});

describe("Sessions dashboard", () => {
  const SESSIONS = 'panel "Sessions ↗", query A';
  const ids = (rows: Row[]) => col(rows, "session_id").sort();

  it("lists every real session that ran in the range (R-M2-03), with its display status", async () => {
    const rows = await dash.run("sessions", SESSIONS, RANGE, REAL);
    // R1-R13 started in the range; R14 started 3 minutes BEFORE it and ended inside; R15 (after) and
    // R16 (ended before) are not listed
    expect(ids(rows)).toEqual(
      [
        R5_ID,
        "R1",
        "R10",
        "R11",
        "R12",
        "R13",
        "R14",
        "R2",
        "R3",
        "R4",
        "R6",
        "R7",
        "R8",
        "R9",
      ].sort(),
    );
    const status = Object.fromEntries(rows.map((r) => [r.session_id as string, r.status]));
    expect(status).toMatchObject({
      R1: "healthy",
      R2: "healthy",
      R3: "degraded",
      R4: "degraded",
      [R5_ID]: "failed",
      R6: "failed",
      R7: "interrupted",
      R8: "running",
      R9: "blocked",
      R10: "failed",
      R11: "failed",
      R12: "healthy",
      R13: "healthy",
      R14: "failed",
    });
    // newest first
    expect(col(rows, "started")[0]).toBe(toClickHouse(m(30)).concat(".000"));
  });

  it("each row's numbers: duration, time to browser, actions, peak memory, cost, cause", async () => {
    const rows = await dash.run("sessions", SESSIONS, RANGE, REAL);
    const get = (id: string) => rows.find((r) => r.session_id === id) as Row;
    const r1 = get("R1");
    expect([
      num(r1.duration_ms),
      num(r1.time_to_browser_ms),
      num(r1.actions),
      num(r1.failed_actions),
    ]).toEqual([60_000, 1500, 2, 0]);
    expect(num(r1.peak_memory_mib)).toBe(300);
    expect(num(r1.estimated_cost_usd)).toBeCloseTo(cost(61_500), 12);
    expect(r1.cause).toBeNull();
    expect(r1.scenario).toBe("checkout");
    expect(num(get("R3").failed_actions)).toBe(1);
    // no samples: Not available, not 0
    expect(get("R13").peak_memory_mib).toBeNull();
    // running: no duration yet, cost still computed (until now)
    const r8 = get("R8");
    expect(r8.duration_ms).toBeNull();
    expect(num(r8.estimated_cost_usd)).toBeGreaterThan(cost(1500 + 80 * MIN));
    expect(num(r8.to_ms)).toBeGreaterThan(Date.now() - 60_000); // end (or now) + 5 s
    // causes are "code: reason"; interrupted and healthy rows have none
    expect(get(R5_ID).cause).toBe("selector_not_found: selector not found");
    expect(get("R9").cause).toBe("captcha: bot wall");
    expect(get("R11").cause).toBe("crashed: oom");
    expect(get("R7").cause).toBeNull();
    expect(get("R8").cause).toBeNull();
    expect(get("R11").version).toBeNull();
  });

  it("the status, engine, scenario and cause filters narrow the table", async () => {
    expect(
      ids(await dash.run("sessions", SESSIONS, RANGE, { ...REAL, status: ["failed", "blocked"] })),
    ).toEqual([R5_ID, "R10", "R11", "R14", "R6", "R9"].sort());
    expect(
      ids(await dash.run("sessions", SESSIONS, RANGE, { ...REAL, status: ["running"] })),
    ).toEqual(["R8"]);
    expect(
      ids(await dash.run("sessions", SESSIONS, RANGE, { ...REAL, status: ["interrupted"] })),
    ).toEqual(["R7"]);
    expect(
      ids(await dash.run("sessions", SESSIONS, RANGE, { ...REAL, engines: ["lightpanda"] })),
    ).toEqual(["R10", "R11", "R12", "R9"]);
    expect(
      ids(await dash.run("sessions", SESSIONS, RANGE, { ...REAL, scenario: ["checkout"] })),
    ).toEqual(["R1"]);
    expect(ids(await dash.run("sessions", SESSIONS, RANGE, { ...REAL, cause: "captcha" }))).toEqual(
      ["R6", "R9"],
    );
    // all sources: sim rows are labelled
    const all = await dash.run("sessions", SESSIONS, RANGE);
    expect(all).toHaveLength(17); // 14 real + 3 sim
    expect(
      all
        .filter((r) => r.source === "sim")
        .map((r) => r.session_id)
        .sort(),
    ).toEqual(["S1", "S2", "S3"]);
  });

  it("the agent and scenario variable queries list the distinct values in range", async () => {
    expect(
      col(await dash.run("sessions", 'variable "scenario"', RANGE), "scenario").sort(),
    ).toEqual(["checkout", "login-and-search"]);
    expect(col(await dash.run("sessions", 'variable "agent"', RANGE), "agent_id")).toEqual([
      "qa-agent",
    ]);
  });
});

describe("Sessions dashboard: the filter boxes and the list", () => {
  // QA-M2-15 (nit, open): the Sessions list holds every session that RAN in the range (R-M2-03), but the
  // agent and scenario boxes offer only the values of sessions that STARTED in it. A session that
  // started before the range cannot be picked by its own scenario or agent.
  it.fails("the agent and scenario boxes offer the values of every session the list shows", async () => {
    const edge: Range = { from: m(1), to: m(3) }; // only R14 (started at -3 min, ended at +2 min) ran here
    const listed = await dash.run("sessions", 'panel "Sessions ↗", query A', edge, REAL);
    expect(listed.map((r) => r.session_id)).toEqual(["R14"]);
    const scenarios = col(await dash.run("sessions", 'variable "scenario"', edge), "scenario");
    const agents = col(await dash.run("sessions", 'variable "agent"', edge), "agent_id");
    expect(scenarios).toContain(listed[0]?.scenario);
    expect(agents).toContain(listed[0]?.agent);
  });
});

describe("Session detail", () => {
  const what = async (id: string) =>
    (await one("session", 'panel "What happened", query A', { session: id })).what_happened;
  const rangeOf = (startMin: number, endSec: number): Range => ({
    from: m(startMin) - 5000,
    to: m(startMin) + endSec * 1000 + 5000,
  });

  it("Status and What happened tell the story of every kind of session", async () => {
    const status = async (id: string) =>
      (await one("session", 'panel "Status", query A', { session: id })).display_status;
    expect([
      await status("R1"),
      await status("R3"),
      await status(R5_ID),
      await status("R7"),
      await status("R8"),
      await status("R9"),
    ]).toEqual(["healthy", "degraded", "failed", "interrupted", "running", "blocked"]);
    expect(await what("R1")).toBe("Completed, no issues");
    expect(await what("R4")).toBe("Completed with 1 issue: unsupported_api");
    expect(await what("R3")).toBe("Completed after 1 failed action(s): timeout");
    // action #1 starts 1100 ms after the session start and lasts 500 ms: 1.60 s
    expect(await what(R5_ID)).toBe(
      "Failed at 1.60 s: action #1 click button.buy, selector_not_found",
    );
    // blocked by an issue (captcha) after an action failed with another code (http_403): both are named
    expect(await what("R9")).toBe(
      "Blocked at 1.04 s: captcha; action #0 goto demo.test failed: http_403",
    );
    expect(await what("R10")).toBe("Failed at 1.06 s: action #0 goto demo.test, timeout");
    expect(await what("R11")).toBe("Failed: oom");
    expect(await what("R7")).toBe("Interrupted by the runner (not counted as a failure)");
    expect(await what("R8")).toBe("Running");
  });

  it("What happened gives the cause of the tables when it differs from the failed action (QA-M2-12)", async () => {
    // The tables say the cause is "captcha" (the issue wins over the failed action); the sentence
    // names the failed action and, since the two differ, the cause as well.
    expect(await what("R6")).toBe(
      "Failed at 1.10 s: action #0 goto demo.test, selector_not_found (cause: captcha)",
    );
    const table = await dash.run("sessions", 'panel "Sessions ↗", query A', RANGE, REAL);
    expect(table.find((r) => r.session_id === "R6")?.cause).toBe("captcha: boom");
  });

  it("header stats: engine, source, duration, actions, time to browser, peaks, requests, cost", async () => {
    const s = { session: "R1" };
    expect((await one("session", 'panel "Engine", query A', s)).engine_version).toBe(
      "chromium 1.0.0",
    );
    expect(
      (await one("session", 'panel "Engine", query A', { session: "R11" })).engine_version,
    ).toBe("lightpanda version not reported");
    expect((await one("session", 'panel "Source", query A', { session: "S1" })).source).toBe("sim");
    expect(num((await one("session", 'panel "Duration", query A', s)).duration_ms)).toBe(60_000);
    expect((await one("session", 'panel "Actions", query A', s)).actions).toBe("2 ok · 0 failed");
    expect((await one("session", 'panel "Actions", query A', { session: R5_ID })).actions).toBe(
      "1 ok · 1 failed",
    );
    expect(
      num((await one("session", 'panel "Time to browser", query A', s)).time_to_browser_ms),
    ).toBe(1500);
    expect(num((await one("session", 'panel "Peak CPU", query A', s)).peak)).toBe(30);
    expect(num((await one("session", 'panel "Peak memory", query A', s)).peak)).toBe(300);
    expect(num((await one("session", 'panel "Peak JS heap", query A', s)).peak)).toBe(40.5);
    expect(num((await one("session", 'panel "Requests", query A', s)).requests)).toBe(3);
    expect(
      num((await one("session", 'panel "Est. cost", query A', s)).estimated_cost_usd),
    ).toBeCloseTo(cost(61_500), 12);
  });

  it("Est. cost of a session whose provider has no price is NULL (nan printed as Not available), never 0", async () => {
    const row = await one("session", 'panel "Est. cost", query A', { session: "S3" });
    expect(row.estimated_cost_usd).toBeNull();
  });

  it("a metric the engine does not report is NULL, never 0", async () => {
    // R12 has container samples but its two CDP samples are null; R13 has no samples at all
    expect(
      (await one("session", 'panel "Peak JS heap", query A', { session: "R12" })).peak,
    ).toBeNull();
    expect(
      num((await one("session", 'panel "Peak memory", query A', { session: "R12" })).peak),
    ).toBe(90);
    expect((await one("session", 'panel "Peak CPU", query A', { session: "R13" })).peak).toBeNull();
    expect(
      (await one("session", 'panel "Peak memory", query A', { session: "R13" })).peak,
    ).toBeNull();
  });

  it("the Actions table is ordered by seq with offsets from the session start", async () => {
    // the stat and the table share the title "Actions": the table is the second query with that label
    const rows = await dash.run(
      "session",
      'panel "Actions", query A',
      RANGE,
      { session: R5_ID },
      1,
    );
    expect(
      rows.map((r) => [
        num(r.seq),
        num(r.start_ms),
        r.action_type,
        r.target,
        num(r.duration_ms),
        r.result,
        r.error_code,
      ]),
    ).toEqual([
      [0, 1000, "goto", "demo.test", 100, "ok", null],
      [1, 1100, "click", "button.buy", 500, "failed", "selector_not_found"],
    ]);
  });

  it("the CPU, memory and JS heap charts return the samples in range and skip nulls", async () => {
    const r = rangeOf(5, 60);
    expect(
      (await dash.run("session", 'panel "CPU", query A', r, { session: "R1" })).map((x) =>
        num(x.cpu_pct),
      ),
    ).toEqual([10, 30]);
    expect(
      (await dash.run("session", 'panel "Memory", query A', r, { session: "R1" })).map((x) =>
        num(x.mem_mb),
      ),
    ).toEqual([100, 300]);
    expect(
      (await dash.run("session", 'panel "JS heap", query A', r, { session: "R1" })).map((x) =>
        num(x.js_heap_mb),
      ),
    ).toEqual([38.5, 40.5]);
    // R12: both CDP samples are null -> no rows (the chart shows its No value text)
    expect(
      await dash.run("session", 'panel "JS heap", query A', rangeOf(17, 40), { session: "R12" }),
    ).toEqual([]);
    expect(
      await dash.run("session", 'panel "CPU", query A', rangeOf(17, 40), { session: "R12" }),
    ).toHaveLength(2);
    // a range that does not cover the session: nothing
    expect(
      await dash.run(
        "session",
        'panel "CPU", query A',
        { from: m(40), to: m(41) },
        { session: "R1" },
      ),
    ).toEqual([]);
  });

  it("annotations mark the failed actions and the issues", async () => {
    const failed = await dash.run("session", 'annotation "Failed actions"', rangeOf(16, 10), {
      session: R5_ID,
    });
    expect(failed.map((r) => r.text)).toEqual(["#1 click button.buy: selector_not_found"]);
    const issues = await dash.run("session", 'annotation "Issues"', rangeOf(14, 30), {
      session: "R4",
    });
    expect(issues.map((r) => r.text)).toEqual(["unsupported_api: seen by the test"]);
  });

  it("Network keeps null status and bytes as null", async () => {
    const rows = await dash.run("session", 'panel "Network", query A', RANGE, { session: "R1" });
    expect(rows.map((r) => [num(r.status), num(r.bytes), num(r.duration_ms)])).toEqual([
      [200, 1000, 50],
      [404, 10, 20],
      [null, null, 5],
    ]);
  });
});

describe("the dashboards against the README", () => {
  async function snippets() {
    const readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const map = new Map<string, string>();
    for (const match of readme.matchAll(/```sql name=([a-z-]+)\n([\s\S]*?)\n```/g))
      map.set(match[1] as string, match[2] as string);
    return map;
  }

  it("session-rates (README) and By engine (dashboard) give the same success rate per engine", async () => {
    const readme = await snippets();
    const sql = (readme.get("session-rates") as string).replace(
      "/* session-facts */",
      readme.get("session-facts") as string,
    );
    const rows = await dash.rows(
      expandedSql({ sql, maxDataPoints: undefined, minInterval: undefined }, RANGE, REAL),
    );
    const byEngine = await dash.run("overview", 'panel "By engine ↗", query A', RANGE, REAL);
    for (const r of rows) {
      const d = byEngine.find((x) => x.engine === r.engine) as Row;
      expect(num(d.success_rate), String(r.engine)).toBeCloseTo(num(r.success_rate) as number, 9);
    }
  });

  it("top-failure-causes (README) and the dashboard list the same causes with the same counts", async () => {
    const readme = await snippets();
    const sql = (readme.get("top-failure-causes") as string).replace(
      "/* session-facts */",
      readme.get("session-facts") as string,
    );
    const rows = await dash.rows(
      expandedSql({ sql, maxDataPoints: undefined, minInterval: undefined }, RANGE, REAL),
    );
    const dashRows = await dash.run(
      "overview",
      'panel "Top failure causes ↗", query A',
      RANGE,
      REAL,
    );
    expect(dashRows.map((r) => [r.cause, num(r.sessions)])).toEqual(
      rows.map((r) => [r.cause, num(r.sessions)]),
    );
  });

  /** Runs a README snippet (with session-facts pasted in) the way a panel would. */
  async function readmeRows(name: string, range: Range, filters = {}): Promise<Row[]> {
    const readme = await snippets();
    const sql = (readme.get(name) as string).replace(
      "/* session-facts */",
      readme.get("session-facts") as string,
    );
    return dash.rows(
      expandedSql({ sql, maxDataPoints: undefined, minInterval: undefined }, range, filters),
    );
  }

  it("estimated-cost-total (README) and the Estimated cost KPI agree: a price, an unpriced session (NULL), nothing at all (0) (QA-M2-13)", async () => {
    const empty: Range = { from: m(100), to: m(110) };
    const cases: Array<[string, Range, Parameters<typeof one>[2]]> = [
      ["priced only", RANGE, { ...REAL, engines: ["lightpanda", "chrome-headless-shell"] }],
      ["one session has no price", RANGE, { source: "sim", engines: ["chromium"] }],
      ["sim lightpanda only", RANGE, { source: "sim", engines: ["lightpanda"] }],
      ["nothing ran", empty, {}],
    ];
    const seen: Array<number | null> = [];
    for (const [label, range, filters] of cases) {
      const [readme] = await readmeRows("estimated-cost-total", range, filters);
      const kpi = await one("overview", 'panel "Estimated cost ↗", query A', filters, range);
      const expected = num(readme?.estimated_cost_usd);
      if (expected === null) expect(num(kpi.estimated_cost_usd), label).toBeNull();
      else expect(num(kpi.estimated_cost_usd), label).toBeCloseTo(expected, 12);
      seen.push(num(kpi.estimated_cost_usd));
    }
    expect(seen[0]).toBeCloseTo(cost(149_950), 9);
    expect(seen[1]).toBeNull();
    expect(seen[2]).toBeCloseTo(cost(5000), 12);
    expect(seen[3]).toBe(0);
  });

  it("browser-hours-and-cost (README) and By engine give the same cost per engine, NULL where a session is unpriced", async () => {
    const filters = { source: "sim" as const };
    const readme = await readmeRows("browser-hours-and-cost", RANGE, filters);
    const byEngine = await dash.run("overview", 'panel "By engine ↗", query A', RANGE, filters);
    expect(readme.map((r) => r.engine)).toEqual(byEngine.map((r) => r.engine));
    for (const r of readme) {
      const d = byEngine.find((x) => x.engine === r.engine) as Row;
      const want = num(r.estimated_cost_usd);
      if (want === null) expect(num(d.estimated_cost_usd), String(r.engine)).toBeNull();
      else expect(num(d.estimated_cost_usd), String(r.engine)).toBeCloseTo(want, 12);
    }
    expect(byEngine.find((r) => r.engine === "chromium")?.estimated_cost_usd).toBeNull(); // S3 has no price
  });

  it("top-cause-per-engine (README) and By engine pick the same cause, and a tie goes to the first name alphabetically", async () => {
    const readme = await readmeRows("top-cause-per-engine", RANGE, REAL);
    const byEngine = await dash.run("overview", 'panel "By engine ↗", query A', RANGE, REAL);
    for (const r of readme) {
      const d = byEngine.find((x) => x.engine === r.engine) as Row;
      expect(d.top_cause, String(r.engine)).toBe(`${r.top_cause} ×${num(r.top_n)}`);
    }
    // lightpanda: captcha, crashed and timeout once each -> "captcha" (a before c before t)
    expect(byEngine.find((r) => r.engine === "lightpanda")?.top_cause).toBe("captcha ×1");
    expect(byEngine.find((r) => r.engine === "chromium")?.top_cause).toBe("selector_not_found ×2");
  });

  it("every session-facts copy in the Overview and Sessions dashboards is the README's text", async () => {
    const readme = await snippets();
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const facts = norm(readme.get("session-facts") as string);
    const { queriesOf } = await import("../fixtures/dashboards");
    for (const name of ["overview", "sessions"] as const) {
      for (const q of queriesOf(name)) {
        if (!q.sql.includes("picked AS")) continue;
        expect(norm(q.sql), `${name}: ${q.where}`).toContain(facts);
      }
    }
  });
});

describe("Overview: right now (Active now, CPU, Memory)", () => {
  it("counts running sessions with a container sample in the last 30 s, from the latest sample of each", async () => {
    const now = Date.now();
    const live: SessionSpec[] = [
      // two samples; the LATEST (now - 5 s) is cpu 50 / mem 100, the older one (150 / 300) must not be added
      spec({
        id: "L1",
        engine: "chromium",
        status: "running",
        startedAt: now - 60_000,
        samples: [
          [150, 300, 30_000],
          [50, 100, 55_000],
        ],
      }),
      spec({
        id: "L2",
        engine: "lightpanda",
        status: "running",
        startedAt: now - 40_000,
        samples: [[25, 40, 36_000]],
      }),
      // running, but its sampler stopped 2 minutes ago
      spec({
        id: "L3",
        engine: "chromium",
        status: "running",
        startedAt: now - 600_000,
        samples: [[90, 90, 480_000]],
      }),
      // ended, with a fresh sample: not active
      spec({
        id: "L4",
        engine: "chromium",
        status: "success",
        startedAt: now - 30_000,
        durationMs: 20_000,
        samples: [[80, 80, 27_000]],
      }),
      // simulated, running, fresh
      spec({
        id: "L5",
        engine: "chromium",
        source: "sim",
        status: "running",
        startedAt: now - 20_000,
        samples: [[10, 20, 17_000]],
      }),
    ];
    await insertSpecs((events) => insertEvents(admin, events), live);
    const range: Range = { from: now - 3_600_000, to: now };
    const kpi = async (title: string, f = {}) =>
      one("overview", `panel "${title} ↗", query A`, f, range);

    expect(num((await kpi("Active now", REAL)).active_now)).toBe(2); // L1, L2
    expect(num((await kpi("Active now")).active_now)).toBe(3); // + L5 (sim)
    expect(num((await kpi("Active now", { ...REAL, engines: ["lightpanda"] })).active_now)).toBe(1);

    expect(num((await kpi("CPU in use", REAL)).cpu_cores)).toBeCloseTo(0.75, 6); // (50 + 25) / 100, not (150 + 50 + 25) / 100
    expect(num((await kpi("Memory in use", REAL)).memory_mib)).toBeCloseTo(140, 6);
    expect(num((await kpi("CPU in use")).cpu_cores)).toBeCloseTo(0.85, 6);

    // the README snippet gives the same numbers as the three KPIs (it uses the same 30 s window)
    const readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const snippet = /```sql name=fleet-in-use-now\n([\s\S]*?)\n```/.exec(readme)?.[1] as string;
    const [inUse] = await dash.rows(
      expandedSql({ sql: snippet, maxDataPoints: undefined, minInterval: undefined }, range, REAL),
    );
    expect(num(inUse?.cores_in_use)).toBeCloseTo(0.75, 6);
    expect(num(inUse?.memory_mib_in_use)).toBeCloseTo(140, 6);
    expect(num(inUse?.containers)).toBe(2);

    const rows = await dash.run("overview", 'panel "By engine ↗", query A', range, REAL);
    const active = Object.fromEntries(rows.map((r) => [r.engine as string, num(r.active_now)]));
    expect(active).toMatchObject({ chromium: 1, lightpanda: 1 });
  });

  it("with no running session CPU and memory in use are 0 (a count of nothing), and Active now is 0", async () => {
    const quiet: Range = { from: m(0), to: m(60) };
    const row = await one(
      "overview",
      'panel "CPU in use ↗", query A',
      { engines: ["chrome-headless-shell"] },
      quiet,
    );
    expect(num(row.cpu_cores)).toBe(0);
    expect(
      num(
        (
          await one(
            "overview",
            'panel "Active now ↗", query A',
            { engines: ["chrome-headless-shell"] },
            quiet,
          )
        ).active_now,
      ),
    ).toBe(0);
  });
});
