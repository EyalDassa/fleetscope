import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DashboardName,
  DashboardRunner,
  ENGINES,
  expandedSql,
  insertSpecs,
  MIN,
  num,
  queriesOf,
  type Range,
  type Row,
  type SessionSpec,
  toClickHouse,
} from "../fixtures/dashboards";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";

/**
 * QA M2, edge data: the dashboards' SQL on an empty database, one session, only simulated data, an
 * unknown session id, hostile text in the session box, and 10,000 sessions (with timings).
 * Everything runs as the read-only user, like Grafana.
 */

interface Harness {
  db: TestDatabase;
  admin: ClickHouseClient;
  dash: DashboardRunner;
  user: string;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = await createTestDatabase();
  const user = `fleetscope_qa_${randomBytes(4).toString("hex")}`;
  const password = "qa-dashboard-password";
  await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
  return {
    db,
    admin: db.client,
    user,
    dash: new DashboardRunner({ url: db.config.url, user, password, database: db.config.database }),
    close: async () => {
      await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
      await db.cleanup();
    },
  };
}

const NAMES: DashboardName[] = ["overview", "sessions", "session"];
const now = () => Date.now();
const lastHour = (): Range => ({ from: now() - 60 * MIN, to: now() });
const col = (rows: Row[], name: string) => rows.map((r) => r[name]);

const spec = (
  s: Partial<SessionSpec> & Pick<SessionSpec, "id" | "engine" | "status">,
): SessionSpec => ({
  startedAt: 0,
  durationMs: 0,
  startupMs: 0,
  connectMs: 0,
  ...s,
});

// ------------------------------------------------------------------------------------------------

describe("an empty database", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("every query of every dashboard runs without an error, with and without a session id", async () => {
    for (const name of NAMES) {
      for (const query of queriesOf(name)) {
        for (const session of ["", "does-not-exist"]) {
          const sql = expandedSql(query, lastHour(), { session });
          await expect(h.dash.rows(sql), `${name}: ${query.where}`).resolves.toBeInstanceOf(Array);
        }
      }
    }
  });

  it("every query also runs for a 30 day range and for a range in the future", async () => {
    const ranges: Range[] = [
      { from: now() - 30 * 24 * 60 * MIN, to: now() },
      { from: now() + 60 * MIN, to: now() + 120 * MIN },
    ];
    for (const range of ranges) {
      for (const name of NAMES) {
        for (const query of queriesOf(name)) {
          await expect(
            h.dash.rows(expandedSql(query, range)),
            `${name}: ${query.where}`,
          ).resolves.toBeInstanceOf(Array);
        }
      }
    }
  });

  it("Overview says no data honestly: no_data and null ratios, 0 for counts, no rows for charts", async () => {
    const run = (title: string) => h.dash.run("overview", `panel "${title}", query A`, lastHour());
    const verdict = (await run("Fleet verdict ↗"))[0];
    expect([num(verdict?.ended), verdict?.success_rate, verdict?.verdict]).toEqual([
      0,
      null,
      "no_data",
    ]);
    const outcomes = (await run("Outcomes ↗"))[0];
    expect(
      [outcomes?.healthy, outcomes?.degraded, outcomes?.failed, outcomes?.blocked].map(num),
    ).toEqual([0, 0, 0, 0]);
    expect((await run("Simulated share ↗"))[0]?.simulated_share).toBeNull();
    expect((await run("Success rate ↗"))[0]?.success_rate).toBeNull();
    expect((await run("p95 action latency ↗"))[0]?.p95_ms).toBeNull();
    expect(num((await run("Sessions ↗"))[0]?.session_count)).toBe(0);
    expect(num((await run("Interrupted ↗"))[0]?.interrupted)).toBe(0);
    expect(num((await run("Active now ↗"))[0]?.active_now)).toBe(0);
    expect(num((await run("Estimated cost ↗"))[0]?.estimated_cost_usd)).toBe(0);
    for (const chart of [
      "Error rate by engine ↗",
      "Active sessions by engine ↗",
      "Actions per minute by engine ↗",
      "By engine ↗",
      "Recent failures ↗",
      "Top failure causes ↗",
    ]) {
      expect(await run(chart), chart).toEqual([]);
    }
  });

  it("Session detail for an id that does not exist: no row in any panel, so each shows its own No value text (QA-M2-04)", async () => {
    const detail = (title: string, nth = 0) =>
      h.dash.run(
        "session",
        `panel "${title}", query A`,
        lastHour(),
        { session: "does-not-exist" },
        nth,
      );
    for (const title of [
      "Status",
      "What happened",
      "Engine",
      "Source",
      "Duration",
      "Actions",
      "Time to browser",
      "Peak CPU",
      "Peak memory",
      "Peak JS heap",
      "Requests",
      "Est. cost",
    ]) {
      expect(await detail(title), title).toEqual([]);
    }
    for (const [title, nth] of [
      ["Actions", 1],
      ["Issues", 0],
      ["CPU", 0],
      ["Memory", 0],
      ["JS heap", 0],
      ["Network", 0],
    ] as const) {
      expect(await detail(title, nth), title).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------------

describe("one session", () => {
  let h: Harness;
  const start = Math.floor((now() - 10 * MIN) / MIN) * MIN;
  beforeAll(async () => {
    h = await harness();
    await insertSpecs(
      (events) => insertEvents(h.admin, events),
      [
        spec({
          id: "only-one",
          engine: "lightpanda",
          status: "success",
          startedAt: start,
          durationMs: 30_000,
          startupMs: 300,
          connectMs: 100,
          engineVersion: null,
          actions: [[250, null]],
        }),
      ],
    );
  });
  afterAll(async () => {
    await h.close();
  });
  const range = (): Range => ({ from: start - 5 * MIN, to: now() });

  it("the verdict is 100% healthy and every table has exactly one row", async () => {
    const verdict = (await h.dash.run("overview", 'panel "Fleet verdict ↗", query A', range()))[0];
    expect([num(verdict?.ended), num(verdict?.success_rate), verdict?.verdict]).toEqual([
      1,
      100,
      "healthy",
    ]);
    const by = await h.dash.run("overview", 'panel "By engine ↗", query A', range());
    expect(by).toHaveLength(1);
    expect(by[0]).toMatchObject({
      engine: "lightpanda",
      version: null,
      status: "healthy",
      p95_ms: 250,
      cpu_pct: null,
      avg_peak_mib: null,
      top_cause: null,
    });
    expect(await h.dash.run("overview", 'panel "Recent failures ↗", query A', range())).toEqual([]);
    expect(await h.dash.run("overview", 'panel "Top failure causes ↗", query A', range())).toEqual(
      [],
    );
    expect(await h.dash.run("sessions", 'panel "Sessions ↗", query A', range())).toHaveLength(1);
  });

  it("the p95 of one action is that action, and a 15 minute chart has one point per chart", async () => {
    const kpi = (await h.dash.run("overview", 'panel "p95 action latency ↗", query A', range()))[0];
    expect(num(kpi?.p95_ms)).toBe(250);
    const chart = await h.dash.run("overview", 'panel "Error rate by engine ↗", query A', range());
    expect(chart.map((r) => [r.engine, num(r.error_rate)])).toEqual([["lightpanda", 0]]);
  });

  it("a range that ends before the session started shows nothing for it", async () => {
    const before: Range = { from: start - 30 * MIN, to: start - 10 * MIN };
    expect(
      num((await h.dash.run("overview", 'panel "Sessions ↗", query A', before))[0]?.session_count),
    ).toBe(0);
    expect(
      (await h.dash.run("overview", 'panel "Fleet verdict ↗", query A', before))[0]?.verdict,
    ).toBe("no_data");
  });

  it("hostile text in the session box finds nothing and is not an error (quote)", async () => {
    for (const session of [
      "only-one' OR 1=1 --",
      "' OR ''='",
      'only-one"',
      "%",
      "only-one ",
      "ONLY-ONE",
    ]) {
      const rows = await h.dash.run("session", 'panel "Status", query A', range(), { session });
      expect(rows, session).toEqual([]);
    }
  });

  // QA-M2-05 (fixed): `${session:singlequote}` escaped the quote but not the backslash, and ClickHouse reads a
  // backslash as an escape, so `\' OR 1=1 --` left the string literal. The box now uses
  // decodeURLComponent('${session:percentencode}'), which has no quote or backslash to escape.
  it("hostile text in the session box cannot leave the string (backslash then quote, and more)", async () => {
    for (const session of [
      "\\' OR 1=1 --",
      "\\\\' OR 1=1 --",
      "\\",
      "'",
      "%27 OR 1=1 --",
      "%5C%27 OR 1=1 --",
      "%",
      "%ZZ",
      "only-one'; DROP TABLE sessions; --",
      "only-one\u0000",
      "\u{1F600} \u00e9",
      "a".repeat(5000),
    ]) {
      for (const [panel, nth] of [
        ["Status", 0],
        ["Engine", 0],
        ["Actions", 1],
        ["Network", 0],
      ] as const) {
        const rows = await h.dash.run(
          "session",
          `panel "${panel}", query A`,
          range(),
          { session },
          nth,
        );
        expect(rows, `${panel}: ${session.slice(0, 20)}`).toEqual([]);
      }
    }
    // the same text in the cause box of the Sessions dashboard matches nothing and breaks nothing
    for (const cause of ["\\' OR 1=1 --", "'", "%27"]) {
      const rows = await h.dash.run("sessions", 'panel "Sessions ↗", query A', range(), { cause });
      expect(rows, cause).toEqual([]);
    }
    // and the real id still works through the same path
    const real = await h.dash.run("session", 'panel "Status", query A', range(), {
      session: "only-one",
    });
    expect(real[0]?.display_status).toBe("healthy");
  });
});

// ------------------------------------------------------------------------------------------------

describe("only simulated data", () => {
  let h: Harness;
  const start = Math.floor((now() - 20 * MIN) / MIN) * MIN;
  beforeAll(async () => {
    h = await harness();
    await insertSpecs(
      (events) => insertEvents(h.admin, events),
      [
        spec({
          id: "sim-a",
          engine: "chromium",
          source: "sim",
          status: "success",
          startedAt: start,
          durationMs: 30_000,
          actions: [[100, null]],
        }),
        spec({
          id: "sim-b",
          engine: "lightpanda",
          source: "sim",
          status: "failed",
          reason: "x",
          startedAt: start + MIN,
          durationMs: 10_000,
          actions: [[20, "unsupported_api"]],
        }),
      ],
    );
  });
  afterAll(async () => {
    await h.close();
  });
  const range = (): Range => ({ from: start - 5 * MIN, to: now() });

  it("source = real sees nothing (no_data), source = sim or All sees both sessions, labelled sim", async () => {
    const real = (
      await h.dash.run("overview", 'panel "Fleet verdict ↗", query A', range(), { source: "real" })
    )[0];
    expect([num(real?.ended), real?.verdict]).toEqual([0, "no_data"]);
    expect(
      await h.dash.run("sessions", 'panel "Sessions ↗", query A', range(), { source: "real" }),
    ).toEqual([]);
    for (const source of [undefined, "sim" as const]) {
      const rows = await h.dash.run("sessions", 'panel "Sessions ↗", query A', range(), { source });
      expect(rows).toHaveLength(2);
      expect(new Set(col(rows, "source"))).toEqual(new Set(["sim"]));
      expect(
        num(
          (
            await h.dash.run("overview", 'panel "Simulated share ↗", query A', range(), { source })
          )[0]?.simulated_share,
        ),
      ).toBe(100);
    }
  });

  it("By engine and Top causes work for sim and say which engine", async () => {
    const by = await h.dash.run("overview", 'panel "By engine ↗", query A', range());
    expect(Object.fromEntries(by.map((r) => [r.engine, num(r.success_rate)]))).toEqual({
      chromium: 100,
      lightpanda: 0,
    });
    const causes = await h.dash.run("overview", 'panel "Top failure causes ↗", query A', range());
    expect(causes.map((r) => [r.cause, r.cause_from, r.engines])).toEqual([
      ["unsupported_api", "action", "lightpanda 1"],
    ]);
  });
});

// ------------------------------------------------------------------------------------------------

describe("the rollup at the edge of the time range", () => {
  let h: Harness;
  const minute = Math.floor((now() - 30 * MIN) / MIN) * MIN;
  beforeAll(async () => {
    h = await harness();
    // Three actions, all after `from`, all inside the minute that starts 30 s before `from`.
    await insertSpecs(
      (events) => insertEvents(h.admin, events),
      [
        spec({
          id: "edge",
          engine: "chromium",
          status: "success",
          startedAt: minute + 35_000,
          durationMs: 5000,
          actions: [
            [100, null],
            [200, null],
            [900, null],
          ],
        }),
        // one slow action two minutes before `from`: it must stay OUT of the range
        spec({
          id: "before",
          engine: "chromium",
          status: "success",
          startedAt: minute - 90_000,
          durationMs: 5000,
          actions: [[5000, null]],
        }),
      ],
    );
  });
  afterAll(async () => {
    await h.close();
  });

  // QA-M2-06 (fixed, R-M2-01 moved the KPI into panel 1): Grafana ranges such as "Last 1 hour" almost never start on a minute, and `$__timeFilter(minute)`
  // drops the whole minute that contains `from`, so the actions between `from` and the next minute vanish
  // from p95 / actions per minute although the session table (exact) still shows them.
  it("the p95 KPI and the actions per minute count actions that happened after `from`, in the minute that contains `from`", async () => {
    const range: Range = { from: minute + 30_000, to: minute + 10 * MIN };
    const raw = await h.dash.rows(
      `SELECT count() AS n FROM actions WHERE ts >= fromUnixTimestamp64Milli(${range.from}) AND ts <= fromUnixTimestamp64Milli(${range.to})`,
    );
    expect(num(raw[0]?.n)).toBe(3);
    const kpi = await h.dash.run("overview", 'panel "p95 action latency ↗", query A', range);
    // 100, 200, 900: position 1.9 -> 200 + 0.9 * 700 = 830. The 5000 ms action of the minute before is out.
    expect(num(kpi[0]?.p95_ms)).toBeCloseTo(830, 6);
    const chart = await h.dash.run(
      "overview",
      'panel "Actions per minute by engine ↗", query A',
      range,
    );
    expect(chart.map((r) => [r.time, num(r.actions_per_min)])).toEqual([
      [toClickHouse(minute), 3], // the minute that contains `from`, whole
    ]);
    const byEngine = await h.dash.run("overview", 'panel "By engine ↗", query A', range);
    expect(byEngine.map((r) => r.engine)).toEqual(["chromium"]);
    expect(num(byEngine[0]?.p95_ms)).toBeCloseTo(830, 6);
  });

  it("a range that starts on a minute boundary gives the same answer", async () => {
    const range: Range = { from: minute, to: minute + 10 * MIN };
    const kpi = await h.dash.run("overview", 'panel "p95 action latency ↗", query A', range);
    expect(num(kpi[0]?.p95_ms)).toBeCloseTo(830, 6);
  });
});

// ------------------------------------------------------------------------------------------------

describe("10,000 sessions", () => {
  let h: Harness;
  const N = 10_000;
  const base = Math.floor((now() - 50 * MIN) / MIN) * MIN;
  const timings: Array<[string, number, number]> = [];

  function sessionSpec(i: number): SessionSpec {
    const failed = i % 20 === 0;
    const blocked = i % 50 === 1;
    const interrupted = i % 100 === 7;
    return {
      id: `bulk-${String(i).padStart(5, "0")}`,
      engine: ENGINES[i % 3] as (typeof ENGINES)[number],
      source: "real",
      status: interrupted ? "failed" : failed ? "failed" : blocked ? "blocked" : "success",
      reason: interrupted
        ? "interrupted"
        : failed
          ? "selector not found"
          : blocked
            ? "bot wall"
            : null,
      startedAt: base + i * 250,
      durationMs: 20_000 + (i % 7) * 1000,
      startupMs: 300,
      connectMs: 100,
      scenario: ["login-and-search", "checkout", "scrape-catalog"][i % 3],
      agent: `agent-${i % 8}`,
      actions: [
        [100 + (i % 50) * 10, null],
        [200, null],
        [300, failed ? "selector_not_found" : null],
      ],
      issue: blocked ? "captcha" : undefined,
      samples: [
        [10 + (i % 40), 100 + (i % 300)],
        [20 + (i % 40), 120 + (i % 300)],
      ],
    };
  }

  beforeAll(async () => {
    h = await harness();
    for (let from = 0; from < N; from += 1000) {
      const specs = Array.from({ length: 1000 }, (_, k) => sessionSpec(from + k));
      await insertSpecs((events) => insertEvents(h.admin, events), specs);
    }
  }, 240_000);
  afterAll(async () => {
    if (process.env.QA_TIMINGS) {
      process.stdout.write(
        `\n10k timings (ms):\n${timings.map(([n, ms, rows]) => `${ms.toFixed(0).padStart(7)}  ${String(rows).padStart(5)} rows  ${n}`).join("\n")}\n`,
      );
    }
    await h.close();
  });

  const range = (): Range => ({ from: base - MIN, to: now() });

  it("the numbers are exact: 9,200 healthy, 500 failed, 200 blocked, 100 interrupted", async () => {
    const r = range();
    const verdict = (await h.dash.run("overview", 'panel "Fleet verdict ↗", query A', r))[0];
    // ended without interrupted: 10,000 - 100 = 9,900; unsuccessful: 500 + 200 = 700
    expect([num(verdict?.ended), verdict?.verdict]).toEqual([9900, "degraded"]);
    expect(num(verdict?.success_rate)).toBeCloseTo((9200 / 9900) * 100, 9);
    const outcomes = (await h.dash.run("overview", 'panel "Outcomes ↗", query A', r))[0];
    expect(
      [outcomes?.healthy, outcomes?.degraded, outcomes?.failed, outcomes?.blocked].map(num),
    ).toEqual([9200, 0, 500, 200]);
    expect(
      num((await h.dash.run("overview", 'panel "Sessions ↗", query A', r))[0]?.session_count),
    ).toBe(10_000);
    expect(
      num((await h.dash.run("overview", 'panel "Interrupted ↗", query A', r))[0]?.interrupted),
    ).toBe(100);
    const causes = await h.dash.run("overview", 'panel "Top failure causes ↗", query A', r);
    expect(causes.map((c) => [c.cause, num(c.sessions)])).toEqual([
      ["selector_not_found", 500],
      ["captcha", 200],
    ]);
    // 3 actions per session
    const apm = await h.dash.run("overview", 'panel "Actions per minute by engine ↗", query A', r);
    expect(apm.reduce((sum, row) => sum + (num(row.actions_per_min) ?? 0), 0)).toBe(30_000);
  });

  it("the Sessions table returns exactly the newest 1,000 rows", async () => {
    const rows = await h.dash.run("sessions", 'panel "Sessions ↗", query A', range());
    expect(rows).toHaveLength(1000);
    expect(rows[0]?.session_id).toBe("bulk-09999");
  });

  it("every Overview and Sessions query finishes in a few seconds (timings are recorded)", async () => {
    const r = range();
    for (const name of ["overview", "sessions"] as const) {
      for (const query of queriesOf(name)) {
        const sql = expandedSql(query, r);
        const t = await h.dash.time(name, query.where, r);
        timings.push([`${name}: ${query.where}`, t.ms, t.rows]);
        expect(sql.length).toBeGreaterThan(0);
        // a generous bound: the point is to catch a query that scans or joins badly, not to benchmark
        expect(t.ms, `${name}: ${query.where}`).toBeLessThan(15_000);
      }
    }
  }, 240_000);

  it("Session detail for one of the 10,000 is quick and right", async () => {
    const session = "bulk-05000"; // 5000 % 20 == 0: failed
    const r: Range = { from: base + 5000 * 250 - 5000, to: base + 5000 * 250 + 40_000 };
    const started = now();
    const status = await h.dash.run("session", 'panel "Status", query A', r, { session });
    const what = await h.dash.run("session", 'panel "What happened", query A', r, { session });
    expect(status[0]?.display_status).toBe("failed");
    expect(String(what[0]?.what_happened)).toMatch(
      /^Failed at \d+\.\d\d s: action #2 click button\.buy, selector_not_found$/,
    );
    expect(now() - started).toBeLessThan(5000);
  });
});
