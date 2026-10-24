import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDashboardLinks,
  checkStructure,
  type DashboardFile,
  extractQueries,
  loadDashboardFiles,
  parseCustomOptions,
  variableDefinitions,
} from "./dashboards";
import type { JsonObject } from "./json";
import { CH, dashboardJson, statPanel } from "./test-fixtures";

function file(name: string, json: JsonObject | undefined, parseError?: string): DashboardFile {
  return { file: name, path: name, json, parseError };
}

describe("loadDashboardFiles", () => {
  it("returns nothing for a missing or empty folder", () => {
    expect(loadDashboardFiles(join(tmpdir(), "fleetscope-does-not-exist"))).toEqual([]);
    expect(loadDashboardFiles(mkdtempSync(join(tmpdir(), "fs-empty-")))).toEqual([]);
  });

  it("reads *.json in name order and reports files that do not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-dash-"));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ uid: "b" }));
    writeFileSync(join(dir, "a.json"), "{ not json");
    writeFileSync(join(dir, "c.json"), "[1, 2]");
    writeFileSync(join(dir, "ignored.txt"), "x");
    mkdirSync(join(dir, "sub.json"));
    const files = loadDashboardFiles(dir).filter((f) => f.file !== "sub.json");
    expect(files.map((f) => f.file)).toEqual(["a.json", "b.json", "c.json"]);
    expect(files[0]?.parseError).toMatch(/JSON/);
    expect(files[1]?.json).toEqual({ uid: "b" });
    expect(files[2]?.parseError).toMatch(/not a JSON object/);
  });
});

describe("checkStructure", () => {
  it("accepts a sound dashboard", () => {
    const result = checkStructure([file("a.json", dashboardJson())]);
    expect(result.dashboards).toHaveLength(1);
    expect(result.problems.size).toBe(0);
  });

  it("reports invalid JSON, missing uid or title, and the v2 schema", () => {
    const result = checkStructure([
      file("broken.json", undefined, "Unexpected token"),
      file("nouid.json", { title: "x" }),
      file("v2.json", {
        uid: "v2",
        title: "V2",
        apiVersion: "dashboard.grafana.app/v2",
        elements: {},
      }),
    ]);
    expect(result.problems.get("broken.json")?.[0]?.message).toMatch(/not valid JSON/);
    expect(result.problems.get("nouid.json")?.[0]?.message).toMatch(/uid/);
    expect(result.problems.get("v2.json")?.[0]?.message).toMatch(/v2 dashboard schema/);
    expect(result.dashboards).toHaveLength(0);
  });

  it("rejects duplicate UIDs and titles", () => {
    const result = checkStructure([
      file("a.json", dashboardJson({ uid: "same", title: "A" })),
      file("b.json", dashboardJson({ uid: "same", title: "A" })),
    ]);
    const messages = (result.problems.get("b.json") ?? []).map((p) => p.message);
    expect(messages.some((m) => m.includes('uid "same" is also used by a.json'))).toBe(true);
    expect(messages.some((m) => m.includes('title "A" is also used by a.json'))).toBe(true);
  });

  it("warns about a numeric id", () => {
    const result = checkStructure([file("a.json", dashboardJson({ id: 7 }))]);
    expect(result.problems.size).toBe(0);
    expect(result.warnings.get("a.json")?.[0]?.message).toMatch(/"id" is 7/);
  });
});

describe("extractQueries: data sources", () => {
  const query = (panel: JsonObject): ReturnType<typeof extractQueries> =>
    extractQueries(dashboardJson({ panels: [panel] }));

  it("collects the SQL of ClickHouse panels, including panels inside rows", () => {
    const row = {
      type: "row",
      title: "Row",
      collapsed: true,
      panels: [statPanel("Inner", "SELECT 2")],
    };
    const result = extractQueries(dashboardJson({ panels: [statPanel("Outer", "SELECT 1"), row] }));
    expect(result.problems).toEqual([]);
    expect(result.queries.map((q) => q.sql)).toEqual(["SELECT 1", "SELECT 2"]);
    expect(result.queries[0]?.where).toBe('panel "Outer", query A');
  });

  it("fails a panel without a data source", () => {
    const panel = statPanel("No source", "SELECT 1");
    delete panel.datasource;
    const result = query(panel);
    expect(result.problems[0]?.message).toMatch(/no data source set/);
    expect(result.problems[0]?.where).toBe('panel "No source", query A');
  });

  it("fails another data source, a legacy name and a mixed panel with untyped queries", () => {
    expect(
      query(statPanel("P", "SELECT 1", { datasource: { type: "prometheus", uid: "prom" } }))
        .problems[0]?.message,
    ).toMatch(/"prom" is not/);
    expect(
      query(statPanel("P", "SELECT 1", { datasource: "ClickHouse" })).problems[0]?.message,
    ).toMatch(/"ClickHouse" is not/);
    expect(
      query(statPanel("P", "SELECT 1", { datasource: { uid: "${DS_X}" } })).problems[0]?.message,
    ).toMatch(/DS_/);
    const mixed = statPanel("P", "SELECT 1", {
      datasource: { type: "datasource", uid: "-- Mixed --" },
    });
    expect(query(mixed).problems[0]?.message).toMatch(/Mixed/);
  });

  it("lets a query override the panel's data source", () => {
    const panel = statPanel("Mixed", "SELECT 1", {
      datasource: { type: "datasource", uid: "-- Mixed --" },
    });
    (panel.targets as JsonObject[])[0] = { refId: "A", datasource: CH, rawSql: "SELECT 1" };
    expect(query(panel).problems).toEqual([]);
  });

  it("accepts Grafana's built-in data sources and text panels without checking SQL", () => {
    const builtIn = { type: "datasource", uid: "grafana" };
    const result = extractQueries(
      dashboardJson({
        panels: [
          statPanel("Grafana", "SELECT 1", {
            datasource: builtIn,
            targets: [{ refId: "A", queryType: "randomWalk" }],
          }),
          { type: "text", title: "Notes", options: { content: "hello" } },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.queries).toEqual([]);
  });

  it("fails a query without SQL, and a builder query that was never saved as SQL", () => {
    const empty = statPanel("Empty", "");
    expect(query(empty).problems[0]?.message).toMatch(/no "rawSql"/);
    const builder = statPanel("Builder", "");
    (builder.targets as JsonObject[])[0] = {
      refId: "A",
      editorType: "builder",
      builderOptions: {},
    };
    expect(query(builder).problems[0]?.message).toMatch(/query-builder query without "rawSql"/);
  });

  it("warns about library panels instead of checking them", () => {
    const result = query({
      type: "stat",
      title: "Shared",
      libraryPanel: { uid: "x", name: "Shared" },
    });
    expect(result.warnings[0]?.message).toMatch(/library panel/);
    expect(result.problems).toEqual([]);
  });
});

describe("extractQueries: variables and annotations", () => {
  it("collects query variables and annotation queries", () => {
    const result = extractQueries(
      dashboardJson({
        templating: {
          list: [
            {
              name: "agent",
              type: "query",
              datasource: CH,
              query: { rawSql: "SELECT DISTINCT agent FROM sessions" },
            },
            { name: "engine", type: "custom", query: "a,b" },
          ],
        },
        annotations: {
          list: [
            {
              builtIn: 1,
              name: "Annotations & Alerts",
              datasource: { type: "grafana", uid: "-- Grafana --" },
            },
            {
              name: "Failed actions",
              datasource: CH,
              target: { rawSql: "SELECT now() AS time, 'x' AS text" },
            },
          ],
        },
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.queries.map((q) => [q.kind, q.where])).toEqual([
      ["variable", 'variable "agent"'],
      ["annotation", 'annotation "Failed actions"'],
    ]);
  });

  it("fails a query variable on the wrong data source", () => {
    const result = extractQueries(
      dashboardJson({
        templating: {
          list: [{ name: "agent", type: "query", datasource: { uid: "other" }, query: "SELECT 1" }],
        },
      }),
    );
    expect(result.problems[0]?.where).toBe('variable "agent"');
  });
});

describe("variableDefinitions and parseCustomOptions", () => {
  it("reads the parts the check needs", () => {
    const [def] = variableDefinitions(
      dashboardJson({
        templating: {
          list: [
            {
              name: "engine",
              type: "custom",
              multi: true,
              includeAll: true,
              allValue: ".*",
              query: "a,b",
              current: { value: ["$__all"] },
              options: [{ value: "$__all" }, { value: "a" }, { value: "b" }],
            },
          ],
        },
      }),
    );
    expect(def).toMatchObject({
      name: "engine",
      multi: true,
      includeAll: true,
      allValue: ".*",
      current: ["$__all"],
      jsonOptions: ["a", "b"],
    });
  });

  it("parses plain lists, Text : value pairs and escaped commas", () => {
    expect(parseCustomOptions("real,sim")).toEqual(["real", "sim"]);
    expect(parseCustomOptions("Healthy : healthy, Failed : failed")).toEqual(["healthy", "failed"]);
    expect(parseCustomOptions("a\\,b, c")).toEqual(["a,b", "c"]);
    expect(parseCustomOptions("")).toEqual([]);
  });
});

describe("checkDashboardLinks", () => {
  const withLink = (
    uid: string,
    url: string,
  ): ReturnType<typeof checkStructure>["dashboards"][number] => ({
    file: `${uid}.json`,
    uid,
    title: uid,
    json: dashboardJson({
      uid,
      links: [{ title: "x", url }],
      panels: [{ links: [{ url: "https://example.com/d/zzz" }] }],
    }),
  });

  it("accepts links to dashboards in the folder and ignores other URLs", () => {
    const problems = checkDashboardLinks([
      withLink("one", "/d/two?var-x=1"),
      withLink("two", "/d/one"),
    ]);
    expect(problems.size).toBe(0);
  });

  it("reports a link to a dashboard that does not exist", () => {
    const problems = checkDashboardLinks([withLink("one", "/d/missing?x=1")]);
    expect(problems.get("one.json")?.[0]?.message).toMatch(/\/d\/missing/);
  });
});
