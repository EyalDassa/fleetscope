import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DashboardRunner,
  insertSpecs,
  MIN,
  num,
  type Range,
  type Row,
  type SessionSpec,
} from "../fixtures/dashboards";
import { spec } from "../fixtures/known-fleet";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase, testPassword } from "./testing";

/**
 * QA M3: the Browsers dashboard (engine comparison, compatibility matrix) and the session-facts
 * lower bound, run as the read-only user on a fleet whose numbers were worked out by hand.
 *
 * REAL fleet (source real). Ended = ended inside the range, interrupted ones left out of the
 * comparison. "ttb" is startup_ms + connect_ms. Price: 0.10 USD per browser-hour for every engine on
 * "local-docker"; "mystery" has no price. Hours = (startup + connect + duration) / 3.6e6.
 *
 *  id  engine  scenario          status          +min dur s  st+con   container mem   heap     actions (ms, error)
 *  C1  chrom   login-and-search  success          5    60   1000+500  100,300         40       100, 200
 *  C2  chrom   login-and-search  success          6   120   2000+1000 200,150         -        300
 *  C3  chrom   checkout-form     failed + issue   7    30   1000+1000 400             -        400 timeout (issue timeout)
 *  C4  chrom   checkout-form     interrupted      8     5   1000+1000 9999            -        1000 browser_closed
 *  H1  shell   login-and-search  success          5    60   1500+500  80,90           10,null  50
 *  H2  shell   login-and-search  success          6    60   3000+1000 120             null     150
 *  H3  shell   checkout-form     failed           7    20   1000+1000 60              null     250 unsupported_feature
 *  H4  shell   login-and-search  success "mystery" 9   60   1000+1000 70              -        -
 *  L1  lpanda  login-and-search  success          5    10   100+100   10              null     20
 *  L2  lpanda  heavy-page-crawl  failed + issue   6    10   200+200   20,30           null     60 unsupported_api (issue unsupported_api)
 *  L3  lpanda  heavy-page-crawl  failed + issue   7    10   300+100   (no sample)     -        - (issue unsupported_api)
 *  L4  lpanda  login-and-search  failed           8    10   100+100   15              -        70 unsupported_feature
 *  L5  lpanda  login-and-search  success          9    10   100+100   40              -        -
 *
 * SIM fleet (R-M2-18, the one-day lower bound), all chromium:
 *  Z1 running, started 3 days before the range      -> out of scope
 *  Z2 running, started 23 hours before the range    -> kept
 *  Z3 success, started 3 days before, ended at +10  -> out of scope
 *  Z4 success, started 23 hours before, ended at +10 -> kept (ttb 2000)
 */

let db: TestDatabase;
let admin: ClickHouseClient;
let dash: DashboardRunner;
const user = `fleetscope_qa3_${randomBytes(4).toString("hex")}`;
const password = testPassword();

const T0 = Math.floor((Date.now() - 120 * MIN) / (5 * MIN)) * (5 * MIN);
const m = (minutes: number) => T0 + minutes * MIN;
const RANGE: Range = { from: m(0), to: m(60) };
const PRICE = 0.1;
const hours = (ms: number) => ms / 3_600_000;

const CHROM = "chromium";
const SHELL = "chrome-headless-shell";
const PANDA = "lightpanda";

const real = (
  s: Partial<SessionSpec> & Pick<SessionSpec, "id" | "engine" | "status" | "scenario">,
  minute: number,
  durationS: number,
  startupMs: number,
  connectMs: number,
): SessionSpec =>
  spec({
    startedAt: m(minute),
    durationMs: durationS * 1000,
    startupMs,
    connectMs,
    ...s,
  });

function fleet(): SessionSpec[] {
  return [
    real(
      {
        id: "C1",
        engine: CHROM,
        status: "success",
        scenario: "login-and-search",
        samples: [
          [1, 100],
          [1, 300],
        ],
        heap: [40],
        actions: [
          [100, null],
          [200, null],
        ],
      },
      5,
      60,
      1000,
      500,
    ),
    real(
      {
        id: "C2",
        engine: CHROM,
        status: "success",
        scenario: "login-and-search",
        samples: [
          [1, 200],
          [1, 150],
        ],
        actions: [[300, null]],
      },
      6,
      120,
      2000,
      1000,
    ),
    real(
      {
        id: "C3",
        engine: CHROM,
        status: "failed",
        reason: "boom",
        scenario: "checkout-form",
        samples: [[1, 400]],
        actions: [[400, "timeout"]],
        issue: "timeout",
      },
      7,
      30,
      1000,
      1000,
    ),
    real(
      {
        id: "C4",
        engine: CHROM,
        status: "failed",
        reason: "interrupted",
        scenario: "checkout-form",
        samples: [[1, 9999]],
        actions: [[1000, "browser_closed"]],
      },
      8,
      5,
      1000,
      1000,
    ),
    real(
      {
        id: "H1",
        engine: SHELL,
        status: "success",
        scenario: "login-and-search",
        samples: [
          [1, 80],
          [1, 90],
        ],
        heap: [10, null],
        actions: [[50, null]],
      },
      5,
      60,
      1500,
      500,
    ),
    real(
      {
        id: "H2",
        engine: SHELL,
        status: "success",
        scenario: "login-and-search",
        samples: [[1, 120]],
        heap: [null],
        actions: [[150, null]],
      },
      6,
      60,
      3000,
      1000,
    ),
    real(
      {
        id: "H3",
        engine: SHELL,
        status: "failed",
        reason: "x",
        scenario: "checkout-form",
        samples: [[1, 60]],
        heap: [null],
        actions: [[250, "unsupported_feature"]],
      },
      7,
      20,
      1000,
      1000,
    ),
    real(
      {
        id: "H4",
        engine: SHELL,
        status: "success",
        scenario: "login-and-search",
        provider: "mystery",
        samples: [[1, 70]],
      },
      9,
      60,
      1000,
      1000,
    ),
    real(
      {
        id: "L1",
        engine: PANDA,
        status: "success",
        scenario: "login-and-search",
        samples: [[1, 10]],
        heap: [null],
        actions: [[20, null]],
      },
      5,
      10,
      100,
      100,
    ),
    real(
      {
        id: "L2",
        engine: PANDA,
        status: "failed",
        reason: "x",
        scenario: "heavy-page-crawl",
        samples: [
          [1, 20],
          [1, 30],
        ],
        heap: [null],
        actions: [[60, "unsupported_api"]],
        issue: "unsupported_api",
      },
      6,
      10,
      200,
      200,
    ),
    real(
      {
        id: "L3",
        engine: PANDA,
        status: "failed",
        reason: "x",
        scenario: "heavy-page-crawl",
        issue: "unsupported_api",
      },
      7,
      10,
      300,
      100,
    ),
    real(
      {
        id: "L4",
        engine: PANDA,
        status: "failed",
        reason: "x",
        scenario: "login-and-search",
        samples: [[1, 15]],
        actions: [[70, "unsupported_feature"]],
      },
      8,
      10,
      100,
      100,
    ),
    real(
      {
        id: "L5",
        engine: PANDA,
        status: "success",
        scenario: "login-and-search",
        samples: [[1, 40]],
      },
      9,
      10,
      100,
      100,
    ),
  ];
}

const day = 24 * 60 * MIN;
function zombies(): SessionSpec[] {
  const sim = (s: Partial<SessionSpec> & Pick<SessionSpec, "id" | "status">): SessionSpec =>
    spec({ engine: CHROM, source: "sim", scenario: "login-and-search", ...s });
  return [
    sim({
      id: "Z1",
      status: "running",
      startedAt: m(0) - 3 * day,
      startupMs: 1000,
      connectMs: 1000,
    }),
    sim({
      id: "Z2",
      status: "running",
      startedAt: m(0) - 23 * 60 * MIN,
      startupMs: 1000,
      connectMs: 1000,
    }),
    sim({
      id: "Z3",
      status: "success",
      startedAt: m(0) - 3 * day,
      durationMs: 3 * day + 10 * MIN,
      startupMs: 1000,
      connectMs: 1000,
    }),
    sim({
      id: "Z4",
      status: "success",
      startedAt: m(0) - 23 * 60 * MIN,
      durationMs: 23 * 60 * MIN + 10 * MIN,
      startupMs: 1000,
      connectMs: 1000,
    }),
  ];
}

const REAL = { source: "real" as const };
const SIM = { source: "sim" as const };
const byKey = (rows: Row[], key: string) => new Map(rows.map((r) => [String(r[key]), r]));
const COMPARISON = 'panel "Engine comparison ↗", query A';
const MATRIX = 'panel "Compatibility matrix: scenario × engine ↗", query A';

beforeAll(async () => {
  db = await createTestDatabase();
  admin = db.client;
  await insertSpecs((events) => insertEvents(admin, events), [...fleet(), ...zombies()]);
  await ensureGrafanaUser(admin, { user, password, database: db.config.database });
  dash = new DashboardRunner({ url: db.config.url, user, password, database: db.config.database });
});

afterAll(async () => {
  await admin.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("Browsers: engine comparison (hand-computed)", () => {
  let rows: Map<string, Row>;
  beforeAll(async () => {
    rows = byKey(await dash.run("browsers", COMPARISON, RANGE, REAL), "engine");
  });

  it("has one row per engine, in name order", async () => {
    const all = await dash.run("browsers", COMPARISON, RANGE, REAL);
    expect(all.map((r) => r.engine)).toEqual([SHELL, PANDA, CHROM].sort());
  });

  it("chromium: the interrupted session is out of every number except action latency", () => {
    const r = rows.get(CHROM) as Row;
    expect(num(r.sessions)).toBe(3); // C1 C2 C3, not C4
    expect(num(r.success_rate)).toBeCloseTo(200 / 3, 9); // C1 C2 succeed
    expect(num(r.time_to_browser_p50_ms)).toBe(2000); // 1500, 2000, 3000
    expect(num(r.time_to_browser_p95_ms)).toBeGreaterThanOrEqual(2000);
    expect(num(r.time_to_browser_p95_ms)).toBeLessThanOrEqual(3000);
    expect(num(r.peak_mem_mib_p50)).toBe(300); // per-session max 300, 200, 400 (C4's 9999 left out)
    // actions 100, 200, 300, 400 and C4's 1000 (documented: the rollup keeps interrupted actions)
    expect(num(r.action_p95_ms)).toBeGreaterThan(400);
    expect(num(r.action_p95_ms)).toBeLessThanOrEqual(1000);
    // (61500 + 123000 + 32000) ms of browser time, 3 sessions, per 1000 sessions
    expect(num(r.cost_per_1k_sessions_usd)).toBeCloseTo(((1000 * hours(216_500)) / 3) * PRICE, 9);
    expect(num(r.js_heap_available)).toBe(1);
  });

  it("chrome-headless-shell: a session without a price makes the cost NULL, not a partial sum", () => {
    const r = rows.get(SHELL) as Row;
    expect(num(r.sessions)).toBe(4);
    expect(num(r.success_rate)).toBeCloseTo(75, 9); // H3 failed
    expect(num(r.time_to_browser_p50_ms)).toBe(2000); // 2000, 4000, 2000, 2000
    expect(num(r.peak_mem_mib_p50)).toBeGreaterThanOrEqual(80); // 60 70 90 120: 80 or 90
    expect(num(r.peak_mem_mib_p50)).toBeLessThanOrEqual(90);
    expect(r.cost_per_1k_sessions_usd).toBeNull();
    expect(num(r.js_heap_available)).toBe(1); // H1 has a 10 MiB heap among its nulls
    expect(num(r.action_p95_ms)).toBeGreaterThanOrEqual(150);
    expect(num(r.action_p95_ms)).toBeLessThanOrEqual(250);
  });

  it("lightpanda: no heap is 'not available' (0), a session without samples is left out of the median, not counted as 0", () => {
    const r = rows.get(PANDA) as Row;
    expect(num(r.sessions)).toBe(5);
    expect(num(r.success_rate)).toBeCloseTo(40, 9); // L1 L5
    expect(num(r.time_to_browser_p50_ms)).toBe(200); // 200 200 200 400 400
    expect(num(r.time_to_browser_p95_ms)).toBe(400);
    // peaks 10, 30, 15, 40 (L3 has none). With L3 counted as 0 the median would be 15 (0 10 15 30 40).
    expect(num(r.peak_mem_mib_p50)).toBeGreaterThanOrEqual(22.5);
    expect(num(r.peak_mem_mib_p50)).toBeLessThanOrEqual(30);
    expect(num(r.js_heap_available)).toBe(0);
    // 10200 + 10400 + 10400 + 10200 + 10200 = 51400 ms over 5 sessions
    expect(num(r.cost_per_1k_sessions_usd)).toBeCloseTo(((1000 * hours(51_400)) / 5) * PRICE, 9);
  });

  it("an engine filter gives the same rows as the matching row of the unfiltered comparison (push-down)", async () => {
    for (const engine of [CHROM, SHELL, PANDA]) {
      const one = await dash.run("browsers", COMPARISON, RANGE, { ...REAL, engines: [engine] });
      expect(one, engine).toHaveLength(1);
      expect(one[0], engine).toEqual(rows.get(engine));
    }
    const two = await dash.run("browsers", COMPARISON, RANGE, { ...REAL, engines: [SHELL, PANDA] });
    expect(two.map((r) => r.engine)).toEqual([SHELL, PANDA].sort());
  });

  it("a range with no ended session has no rows (the panel says so itself)", async () => {
    const empty = await dash.run("browsers", COMPARISON, { from: m(70), to: m(80) }, REAL);
    expect(empty).toEqual([]);
  });

  it("the sim source is separate: no real session leaks into it", async () => {
    const sim = await dash.run("browsers", COMPARISON, RANGE, SIM);
    expect(sim.map((r) => [r.engine, num(r.sessions)])).toEqual([[CHROM, 1]]); // Z4 only
  });
});

describe("Browsers: bar gauges read the same table", () => {
  it("the three bar gauges expose the engine as the name and the right column as the value", async () => {
    const t = await dash.run(
      "browsers",
      'panel "Time to usable browser, p50 ↗", query A',
      RANGE,
      REAL,
    );
    const p = await dash.run(
      "browsers",
      'panel "Peak memory per session, p50 ↗", query A',
      RANGE,
      REAL,
    );
    const a = await dash.run("browsers", 'panel "p95 action latency ↗", query A', RANGE, REAL);
    // the harness returns the table's rows: the transformation (rowsToFields) uses these columns
    for (const rows of [t, p, a])
      expect(rows.map((r) => r.engine)).toEqual([SHELL, PANDA, CHROM].sort());
    expect(t.map((r) => num(r.time_to_browser_p50_ms))).toEqual([2000, 2000, 200]);
    expect(p.map((r) => num(r.peak_mem_mib_p50)).every((v) => v !== null && v > 0)).toBe(true);
    expect(a.every((r) => r.action_p95_ms !== undefined)).toBe(true);
  });
});

describe("Browsers: compatibility matrix (hand-computed)", () => {
  // The panel pivots the README snippet: one row per scenario, three columns per engine.
  const cell = (r: Row, prefix: string) => [
    num(r[`${prefix}_n`]),
    r[`${prefix}_rate`] === null ? null : Number(num(r[`${prefix}_rate`])?.toFixed(6)),
    r[`${prefix}_cause`],
  ];
  const pick = (r: Row) => ({
    scenario: r.scenario,
    chromium: cell(r, "chromium"),
    shell: cell(r, "chrome_headless_shell"),
    panda: cell(r, "lightpanda"),
  });

  it("one row per scenario, a cell per engine: interrupted sessions left out, the top cause named, a missing cell is NULL not 0%", async () => {
    const rows = (await dash.run("browsers", MATRIX, RANGE, REAL)).map(pick);
    expect(rows).toEqual([
      {
        scenario: "checkout-form",
        chromium: [1, 0, "timeout"], // C3 (C4 interrupted is left out)
        shell: [1, 0, "unsupported_feature"], // H3: an action code, no issue
        panda: [0, null, null], // none ran
      },
      {
        scenario: "heavy-page-crawl",
        chromium: [0, null, null],
        shell: [0, null, null],
        panda: [2, 0, "unsupported_api"], // L2 L3
      },
      {
        scenario: "login-and-search",
        chromium: [2, 100, null], // C1 C2
        shell: [3, 100, null], // H1 H2 H4
        panda: [3, 66.666667, "unsupported_feature"], // L1 L5 ok, L4 failed
      },
    ]);
  });

  it("the matrix covers exactly the sessions of the comparison: 3 + 4 + 5 = 12", async () => {
    const rows = await dash.run("browsers", MATRIX, RANGE, REAL);
    const total = rows.reduce(
      (n, r) =>
        n +
        (num(r.chromium_n) ?? 0) +
        (num(r.chrome_headless_shell_n) ?? 0) +
        (num(r.lightpanda_n) ?? 0),
      0,
    );
    expect(total).toBe(12);
  });

  it("a Lightpanda-only filter gives the Lightpanda cells of the full matrix and nothing for the others", async () => {
    const full = (await dash.run("browsers", MATRIX, RANGE, REAL)).map(pick);
    const only = (await dash.run("browsers", MATRIX, RANGE, { ...REAL, engines: [PANDA] })).map(
      pick,
    );
    expect(only.map((r) => [r.scenario, r.panda])).toEqual(
      full.filter((r) => Number(r.panda[0]) > 0).map((r) => [r.scenario, r.panda]),
    );
    for (const r of only) {
      expect(r.chromium).toEqual([0, null, null]);
      expect(r.shell).toEqual([0, null, null]);
    }
  });
});

describe("Browsers: time series panels", () => {
  it("memory per container: average of container samples per bucket; NULL (not 0) where the engine has none", async () => {
    // one-minute window around minute +9: H4 (70) and L5 (40); lightpanda's heap-only samples are not in the average
    const win: Range = { from: m(9), to: m(10) };
    const rows = await dash.run(
      "browsers",
      'panel "Memory per container by engine ↗", query A',
      win,
      REAL,
    );
    const memory = new Map(rows.map((r) => [String(r.engine), num(r.mem_mib_per_container)]));
    expect(memory.get(SHELL)).toBe(70);
    expect(memory.get(PANDA)).toBe(40);
    expect(memory.has(CHROM)).toBe(false); // no sample at all: no row, never 0
    // minute +5: C1 (100, 300) -> 200, H1 (80, 90) -> 85, L1 10 (its null heap sample must not dilute it)
    const five = await dash.run(
      "browsers",
      'panel "Memory per container by engine ↗", query A',
      { from: m(5), to: m(6) - 1 },
      REAL,
    );
    expect(new Map(five.map((r) => [String(r.engine), num(r.mem_mib_per_container)]))).toEqual(
      new Map([
        [CHROM, 200],
        [SHELL, 85],
        [PANDA, 10],
      ]),
    );
  });

  it("p95 action latency by engine: one engine-only filter shows only that engine", async () => {
    const rows = await dash.run(
      "browsers",
      'panel "p95 action latency by engine ↗", query A',
      RANGE,
      { ...REAL, engines: [PANDA] },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.engine))).toEqual(new Set([PANDA]));
    for (const r of rows) {
      const v = num(r.p95_ms);
      expect(v === null || (v >= 20 && v <= 70)).toBe(true); // actions 20 60 70
    }
  });
});

describe("session-facts lower bound (R-M2-18)", () => {
  it("a 3-day-old session is out of scope, a 23-hour-old one is kept (ended inside the range)", async () => {
    const rows = await dash.run("browsers", COMPARISON, RANGE, SIM);
    expect(rows).toHaveLength(1);
    // Z4 only: Z3 started 3 days before the range. 1 session, success, ttb 2000
    expect([
      num(rows[0]?.sessions),
      num(rows[0]?.success_rate),
      num(rows[0]?.time_to_browser_p50_ms),
    ]).toEqual([1, 100, 2000]);
    // 2000 ms + 23 h 10 min of browser time
    expect(num(rows[0]?.cost_per_1k_sessions_usd)).toBeCloseTo(
      1000 * hours(2000 + 1390 * MIN) * PRICE,
      9,
    );
  });

  it("the Overview verdict agrees: one session ended (the 23-hour one), none started in the range", async () => {
    const rows = await dash.run("overview", 'panel "Fleet verdict ↗", query A', RANGE, SIM);
    // ended in range: Z4 only (Z3 is out of scope); started in range: none (all started before it)
    expect(rows).toHaveLength(1);
    expect([num(rows[0]?.ended), num(rows[0]?.session_count), rows[0]?.verdict]).toEqual([
      1,
      0,
      "healthy",
    ]);
  });

  it("the one-day bound is relative to the START of the range: a range that starts later brings the 23-hour session out of scope", async () => {
    // from = +2 h: Z2/Z4 started 25 h before it, so they are out; Z4 also ended at +10, before the range
    const later: Range = { from: m(120), to: m(180) };
    expect(await dash.run("browsers", COMPARISON, later, SIM)).toEqual([]);
  });

  it("the filter variants return the same sim facts (engine push-down does not change them)", async () => {
    const all = await dash.run("browsers", COMPARISON, RANGE, SIM);
    const chromium = await dash.run("browsers", COMPARISON, RANGE, { ...SIM, engines: [CHROM] });
    expect(chromium).toEqual(all);
    expect(await dash.run("browsers", COMPARISON, RANGE, { ...SIM, engines: [PANDA] })).toEqual([]);
  });
});
