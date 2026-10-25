import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DashboardRunner,
  expandedSql,
  insertSpecs,
  MIN,
  num,
  queriesOf,
  type Range,
} from "../fixtures/dashboards";
import { knownFleet } from "../fixtures/known-fleet";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase, testPassword } from "./testing";

/**
 * QA, public-sites: adding the Target and Site variables must not change a single demo number.
 * The known fleet (hand-computed in dashboards.numbers.integration.test.ts) has no `target` or
 * `site` in its events, like every row written before migration 0010. Every query of Overview and
 * Browsers must return the same rows with Target = All, Target = Demo site and Site = demo-site,
 * and nothing at all for Target = Public sites.
 */
let db: TestDatabase;
let admin: ClickHouseClient;
let dash: DashboardRunner;
const password = testPassword();
const user = `fleetscope_qa_${randomBytes(4).toString("hex")}`;
const T0 = Math.floor((Date.now() - 120 * MIN) / (5 * MIN)) * (5 * MIN);
const RANGE: Range = { from: T0, to: T0 + 60 * MIN };

beforeAll(async () => {
  db = await createTestDatabase();
  admin = db.client;
  await insertSpecs((events) => insertEvents(admin, events), knownFleet(T0));
  await ensureGrafanaUser(admin, { user, password, database: db.config.database });
  dash = new DashboardRunner({
    url: db.config.url,
    user,
    password,
    database: db.config.database,
  });
});

afterAll(async () => {
  await admin.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("rows written without target/site", () => {
  it("read demo / demo-site", async () => {
    const rs = await admin.query({
      query: "SELECT target, site, count() AS n FROM sessions FINAL GROUP BY target, site",
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as { target: string; site: string; n: string }[];
    expect(rows.map((r) => [r.target, r.site])).toEqual([["demo", "demo-site"]]);
    expect(num(rows[0]?.n)).toBeGreaterThan(10);
  });
});

/** Panels that read the per-minute rollup; they show nothing while Target or Site is set (DESIGN.md). */
const ROLLUP_PANELS = new Set([
  'panel "Fleet verdict ↗", query A',
  'panel "By engine ↗", query A',
  'panel "Actions per minute by engine ↗", query A',
  'panel "Engine comparison ↗", query A',
  'panel "p95 action latency by engine ↗", query A',
  'panel "Memory per container by engine ↗", query A',
]);
const ONLY_ROLLUP = new Set([
  'panel "Actions per minute by engine ↗", query A',
  'panel "p95 action latency by engine ↗", query A',
  'panel "Memory per container by engine ↗", query A',
]);
const ROLLUP_COLUMNS = [
  "action_p95_ms",
  "p95_ms",
  "cpu_pct",
  "mem_mib_per_container",
  "actions_per_min",
  "p95",
  "time",
];
const withoutRollup = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !ROLLUP_COLUMNS.includes(k)));

for (const name of ["overview", "browsers"] as const) {
  describe(`${name}: Target = All, Target = Demo site and Site = demo-site give the same numbers`, () => {
    const queries = queriesOf(name);
    it("has queries to compare", () => {
      expect(queries.length).toBeGreaterThan(5);
    });
    for (const [i, item] of queries.entries()) {
      it(`${item.where} (#${i})`, async () => {
        const run = (filters: Parameters<typeof expandedSql>[2]) =>
          dash.rows(expandedSql(item, RANGE, filters, name));
        const all = await run({});
        const filtered = [
          await run({ target: "demo" }),
          await run({ site: ["demo-site"] }),
          await run({ target: "demo", site: ["demo-site"] }),
        ];
        if (!ROLLUP_PANELS.has(item.where)) {
          for (const rows of filtered) expect(rows).toEqual(all);
          return;
        }
        // By design (DESIGN.md "Rollup panels and Target / Site"): fleet_minute has no target or site,
        // so with a filter set these panels lose their rollup numbers (null / no rows). All else is equal.
        if (ONLY_ROLLUP.has(item.where)) {
          expect(all.length).toBeGreaterThan(0);
          for (const rows of filtered) expect(rows).toEqual([]);
          return;
        }
        for (const rows of filtered) {
          expect(rows.map((r) => withoutRollup(r))).toEqual(
            all.map((r) => withoutRollup(r)).filter((r) => Object.keys(r).length > 0 || false),
          );
        }
      });
    }
    it("the comparison is not vacuous: some query returns data", async () => {
      let withData = 0;
      for (const item of queries) {
        if ((await dash.rows(expandedSql(item, RANGE, {}, name))).length > 0) withData++;
      }
      expect(withData).toBeGreaterThan(5);
    });
  });
}

describe("Target = Public sites over a range with no public session", () => {
  it("Overview Sessions shows 0 sessions", async () => {
    const rows = await dash.run("overview", 'panel "Sessions ↗", query A', RANGE, {
      target: "public",
    });
    expect(num(rows[0]?.session_count)).toBe(0);
  });
});
