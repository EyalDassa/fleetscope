import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDashboards, makeVariableState } from "./check";
import type { Fetch } from "./clickhouse-http";
import type { VariableDefinition } from "./dashboards";
import type { JsonObject } from "./json";
import { CH, dashboardJson, statPanel } from "./test-fixtures";

const connection = {
  url: "http://ch.test:8123",
  user: "grafana_ro",
  password: "pw",
  database: "fleetscope",
};
const now = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));

function writeDashboards(dashboards: Record<string, JsonObject>): string {
  const dir = mkdtempSync(join(tmpdir(), "fs-check-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, json] of Object.entries(dashboards)) {
    writeFileSync(join(dir, name), JSON.stringify(json));
  }
  return dir;
}

/** A fake ClickHouse: answers the variable query, fails SQL that mentions `nope`, accepts the rest. */
function fakeClickHouse(): { fetchImpl: Fetch; sent: string[] } {
  const sent: string[] = [];
  const fetchImpl = (async (_url: URL | string, init?: RequestInit) => {
    const sql = String(init?.body);
    sent.push(sql);
    if (sql.includes("nope")) {
      return new Response(
        "Code: 47. DB::Exception: Unknown expression identifier `nope` in scope SELECT nope FROM sessions. (UNKNOWN_IDENTIFIER)",
        { status: 404 },
      );
    }
    if (sql.includes("DISTINCT agent")) {
      return new Response(
        JSON.stringify({ meta: [{ name: "agent" }], data: [["claude"], ["gpt"]] }),
        {
          status: 200,
        },
      );
    }
    return new Response(JSON.stringify({ meta: [{ name: "n" }], data: [[1]] }), { status: 200 });
  }) as unknown as Fetch;
  return { fetchImpl, sent };
}

const variables = {
  list: [
    {
      name: "engine",
      type: "custom",
      query: "chromium,lightpanda",
      multi: true,
      includeAll: true,
      current: { value: ["$__all"] },
    },
    {
      name: "agent",
      type: "query",
      datasource: CH,
      query: { rawSql: "SELECT DISTINCT agent FROM sessions WHERE $__timeFilter(started_at)" },
      multi: true,
      includeAll: true,
      current: { value: ["$__all"] },
    },
  ],
};

describe("checkDashboards", () => {
  it("passes on an empty folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-empty-"));
    const report = await checkDashboards({ dir, connection, now });
    expect(report).toEqual({ files: [], problemCount: 0, queriesRun: 0 });
  });

  it("runs every query, in the All mode and with single values, and fills in variables and macros", async () => {
    const { fetchImpl, sent } = fakeClickHouse();
    const dir = writeDashboards({
      "ok.json": dashboardJson({
        templating: variables,
        panels: [
          statPanel(
            "Sessions",
            "SELECT count() FROM sessions WHERE $__timeFilter(started_at) AND $__conditionalAll(engine IN (${engine:singlequote}), $engine) AND agent IN ($agent)",
          ),
          statPanel("Plain", "SELECT 1 FROM sessions"),
        ],
      }),
    });

    const report = await checkDashboards({ dir, connection, now, fetchImpl });

    expect(report.problemCount).toBe(0);
    // variable query + Sessions in two modes + Plain once (the variables make no difference to it)
    expect(report.queriesRun).toBe(4);
    const sessions = sent.filter((sql) => sql.includes("count() FROM sessions"));
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toContain("AND 1=1 AND agent IN ('claude','gpt')");
    expect(sessions[1]).toContain("engine IN ('chromium')");
    expect(sessions[1]).toContain("agent IN ('claude')");
    expect(sessions[0]).toMatch(
      /started_at >= toDateTime\(\d+\) AND started_at <= toDateTime\(\d+\)/,
    );
    expect(sent.join("\n")).not.toContain("$");
  });

  it("names the dashboard, the panel and the ClickHouse error when a query fails", async () => {
    const { fetchImpl } = fakeClickHouse();
    const dir = writeDashboards({
      "bad.json": dashboardJson({
        title: "Broken dashboard",
        panels: [
          statPanel("Fine", "SELECT 1"),
          statPanel("Success rate", "SELECT nope FROM sessions"),
        ],
      }),
    });

    const report = await checkDashboards({ dir, connection, now, fetchImpl });

    expect(report.problemCount).toBe(1);
    const file = report.files[0];
    expect(file?.file).toBe("bad.json");
    expect(file?.title).toBe("Broken dashboard");
    const problem = file?.problems[0];
    expect(problem?.where).toBe('panel "Success rate", query A');
    expect(problem?.message).toMatch(
      /ClickHouse error: Code: 47\. DB::Exception: Unknown expression identifier `nope`/,
    );
    expect(problem?.detail).toContain("SELECT nope FROM sessions");
  });

  it("reports an unknown variable or macro without sending anything to ClickHouse", async () => {
    const { fetchImpl, sent } = fakeClickHouse();
    const dir = writeDashboards({
      "typo.json": dashboardJson({
        panels: [
          statPanel("Typo", "SELECT 1 WHERE engine = $engnie"),
          statPanel("Macro", "SELECT 1 WHERE $__timeFilter()"),
        ],
      }),
    });
    const report = await checkDashboards({ dir, connection, now, fetchImpl });
    expect(report.problemCount).toBe(2);
    expect(report.files[0]?.problems[0]?.message).toMatch(/"\$engnie" is neither a variable/);
    expect(report.files[0]?.problems[1]?.message).toMatch(/\$__timeFilter expects 1 argument/);
    expect(sent).toEqual([]);
  });

  it("hints at pnpm db:grafana-user when the read-only user cannot log in", async () => {
    const fetchImpl = (async () =>
      new Response(
        "Code: 516. DB::Exception: grafana_ro: Authentication failed (AUTHENTICATION_FAILED)",
        {
          status: 403,
        },
      )) as unknown as Fetch;
    const dir = writeDashboards({
      "a.json": dashboardJson({ panels: [statPanel("P", "SELECT 1")] }),
    });
    const report = await checkDashboards({ dir, connection, now, fetchImpl });
    expect(report.files[0]?.problems[0]?.message).toMatch(/pnpm db:grafana-user/);
  });

  it("applies the structural and design rules without a connection", async () => {
    const dir = writeDashboards({
      "a.json": dashboardJson({
        uid: "dup",
        panels: [
          statPanel("Zero default", "SELECT ifNull(x, 0) FROM t", {
            fieldConfig: { defaults: {} },
          }),
        ],
      }),
      "b.json": dashboardJson({ uid: "dup", title: "Other" }),
    });
    const report = await checkDashboards({ dir, connection: undefined, now });
    const a = report.files.find((f) => f.file === "a.json");
    const b = report.files.find((f) => f.file === "b.json");
    expect(a?.problems.map((p) => p.message).join("\n")).toMatch(
      /noValue[\s\S]*turns a missing value into 0/,
    );
    expect(b?.problems[0]?.message).toMatch(/uid "dup" is also used by a\.json/);
    expect(report.queriesRun).toBe(0);
  });

  it("can downgrade links to missing dashboards to warnings", async () => {
    const dir = writeDashboards({
      "a.json": dashboardJson({ links: [{ title: "x", url: "/d/not-there" }] }),
    });
    const strict = await checkDashboards({ dir, connection: undefined, now });
    const lenient = await checkDashboards({
      dir,
      connection: undefined,
      now,
      allowDanglingLinks: true,
    });
    expect(strict.problemCount).toBe(1);
    expect(lenient.problemCount).toBe(0);
    expect(lenient.files[0]?.warnings[0]?.message).toMatch(/\/d\/not-there/);
  });

  it("warns when every query returns no rows", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ meta: [{ name: "n" }], data: [] }), {
        status: 200,
      })) as unknown as Fetch;
    const dir = writeDashboards({
      "a.json": dashboardJson({ panels: [statPanel("P", "SELECT 1")] }),
    });
    const report = await checkDashboards({ dir, connection, now, fetchImpl });
    expect(report.problemCount).toBe(0);
    expect(report.files[0]?.warnings[0]?.message).toMatch(/pnpm db:seed/);
  });
});

describe("makeVariableState", () => {
  const def = (partial: Partial<VariableDefinition>): VariableDefinition => ({
    name: "v",
    type: "custom",
    multi: false,
    includeAll: false,
    allValue: undefined,
    queryText: "",
    sql: undefined,
    current: [],
    jsonOptions: [],
    ...partial,
  });
  const options = ["real", "sim"];

  it("opens on All when the dashboard says so, otherwise on the current value or the first option", () => {
    expect(
      makeVariableState(def({ includeAll: true, current: ["$__all"] }), options, "default"),
    ).toMatchObject({ all: true });
    expect(makeVariableState(def({ includeAll: true }), options, "default")).toMatchObject({
      all: true,
    });
    expect(makeVariableState(def({ current: ["sim"] }), options, "default")).toMatchObject({
      all: false,
      selected: ["sim"],
    });
    expect(makeVariableState(def({}), options, "default")).toMatchObject({
      all: false,
      selected: ["real"],
    });
  });

  it("picks one concrete value in the filtered mode", () => {
    expect(
      makeVariableState(def({ includeAll: true, current: ["$__all"] }), options, "filtered"),
    ).toMatchObject({
      all: false,
      selected: ["real"],
    });
    expect(makeVariableState(def({}), [], "filtered")?.selected[0]).toMatch(/placeholder/);
  });

  it("treats constants and text boxes as fixed values and skips types it cannot model", () => {
    expect(
      makeVariableState(def({ type: "constant", queryText: "http://x" }), [], "default"),
    ).toMatchObject({
      selected: ["http://x"],
    });
    expect(
      makeVariableState(def({ type: "textbox", queryText: "", current: ["abc"] }), [], "default"),
    ).toMatchObject({
      selected: ["abc"],
    });
    expect(makeVariableState(def({ type: "adhoc" }), [], "default")).toBeUndefined();
  });
});
