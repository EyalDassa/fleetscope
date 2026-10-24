import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDashboards } from "./check";
import type { Fetch } from "./clickhouse-http";
import { extractQueries } from "./dashboards";
import type { JsonObject } from "./json";
import { dashboardJson, readerPanel, statPanel, testPassword } from "./test-fixtures";

// R-M2-01: panels that show the result of another panel's query (Grafana's "Dashboard" data source).

const SUMMARY_SQL = "SELECT 1 AS session_count, 2 AS healthy, 3 AS failed, 'healthy' AS verdict";
const summary = statPanel("Fleet verdict", SUMMARY_SQL, { id: 1 });

describe("extractQueries: the Dashboard data source", () => {
  it("accepts readers of a panel with SQL, and runs only the source's SQL", () => {
    const result = extractQueries(
      dashboardJson({
        panels: [
          summary,
          readerPanel(2, "Sessions", 1, "/^session_count$/"),
          readerPanel(3, "Healthy", 1, "/^healthy$/"),
        ],
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.queries.map((q) => [q.where, q.panelId])).toEqual([
      ['panel "Fleet verdict", query A', 1],
    ]);
    expect(result.dashboardReads.map((r) => [r.where, r.sourcePanelIds])).toEqual([
      ['panel "Sessions"', [1]],
      ['panel "Healthy"', [1]],
    ]);
  });

  it("fails a panelId that does not exist, and lists the ones that do", () => {
    const result = extractQueries(
      dashboardJson({ panels: [summary, readerPanel(2, "Sessions", 99, "/^a$/")] }),
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.where).toBe('panel "Sessions", query A');
    expect(result.problems[0]?.message).toMatch(
      /reads panel 99, which does not exist.*panel ids: 1, 2/,
    );
    expect(result.dashboardReads).toEqual([]);
  });

  it("fails a missing or non-numeric panelId", () => {
    const noId = readerPanel(2, "No id", 1, "/^a$/");
    (noId.targets as JsonObject[])[0] = { datasource: noId.datasource, refId: "A" };
    const text = readerPanel(3, "Text id", 1, "/^a$/");
    (text.targets as JsonObject[])[0] = { datasource: text.datasource, refId: "A", panelId: "1" };
    const result = extractQueries(dashboardJson({ panels: [summary, noId, text] }));
    expect(result.problems.map((p) => p.where)).toEqual([
      'panel "No id", query A',
      'panel "Text id", query A',
    ]);
    expect(result.problems[0]?.message).toMatch(/no numeric "panelId"/);
  });

  it("fails a panel that reads itself, or another reader, or a panel without SQL", () => {
    const result = extractQueries(
      dashboardJson({
        panels: [
          summary,
          readerPanel(2, "Reads itself", 2, "/^a$/"),
          readerPanel(3, "Reads a reader", 4, "/^a$/"),
          readerPanel(4, "A reader", 1, "/^a$/"),
          { id: 5, type: "text", title: "Notes" },
          readerPanel(6, "Reads text", 5, "/^a$/"),
        ],
      }),
    );
    const byPanel = new Map(result.problems.map((p) => [p.where, p.message]));
    expect(byPanel.get('panel "Reads itself", query A')).toMatch(/reads itself/);
    expect(byPanel.get('panel "Reads a reader", query A')).toMatch(
      /which has no ClickHouse SQL of its own.*cannot read another one/,
    );
    expect(byPanel.get('panel "Reads text", query A')).toMatch(/no ClickHouse SQL of its own/);
    expect(byPanel.has('panel "A reader", query A')).toBe(false);
  });

  it("fails a query refId that the source does not have", () => {
    const reader = readerPanel(2, "Sessions", 1, "/^a$/");
    (reader.targets as JsonObject[])[0] = {
      datasource: reader.datasource,
      panelId: 1,
      panelRefId: "Z",
      refId: "A",
    };
    const result = extractQueries(dashboardJson({ panels: [summary, reader] }));
    expect(result.problems[0]?.message).toMatch(/reads query Z of panel 1.*has only: A/);
  });

  it("fails two panels with the same id", () => {
    const result = extractQueries(
      dashboardJson({ panels: [summary, statPanel("Also id 1", "SELECT 1", { id: 1 })] }),
    );
    expect(result.problems[0]?.message).toMatch(/same id \(1\) as panel "Fleet verdict"/);
  });

  it("does not check field names of a panel with transformations", () => {
    const withTransform = readerPanel(2, "Renamed", 1, "/^whatever$/", {
      transformations: [{ id: "organize", options: {} }],
    });
    const [read] = extractQueries(
      dashboardJson({ panels: [summary, withTransform] }),
    ).dashboardReads;
    expect(read?.skipFields).toBe(true);
  });
});

/** A fake ClickHouse: the summary query returns the columns above; anything else one column `n`. */
function fakeClickHouse(options: { failSummary?: boolean } = {}): Fetch {
  return (async (_url: URL | string, init?: RequestInit) => {
    const sql = String(init?.body);
    if (sql.includes("AS session_count")) {
      if (options.failSummary) {
        return new Response("Code: 47. DB::Exception: Unknown identifier `x`", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          meta: ["session_count", "healthy", "failed", "verdict"].map((name) => ({ name })),
          data: [[1, 2, 3, "healthy"]],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ meta: [{ name: "n" }], data: [[1]] }), { status: 200 });
  }) as unknown as Fetch;
}

function run(panels: JsonObject[], fetchImpl: Fetch) {
  const dir = mkdtempSync(join(tmpdir(), "fs-dashsrc-"));
  writeFileSync(join(dir, "d.json"), JSON.stringify(dashboardJson({ panels })));
  return checkDashboards({
    dir,
    connection: { url: "http://ch.test:8123", user: "u", password: testPassword(), database: "d" },
    now: new Date(Date.UTC(2024, 0, 1, 12)),
    fetchImpl,
  });
}

describe("checkDashboards: the Dashboard data source", () => {
  it("passes when the fields exist, and runs the shared query once", async () => {
    const report = await run(
      [
        summary,
        readerPanel(2, "Sessions", 1, "/^session_count$/"),
        readerPanel(3, "Healthy", 1, "/^(healthy|failed)$/"),
        readerPanel(4, "Verdict", 1, "verdict"),
      ],
      fakeClickHouse(),
    );
    expect(report.problemCount).toBe(0);
    expect(report.queriesRun).toBe(1);
  });

  it("names the panel, the field and the source when a field is not in the result", async () => {
    const report = await run(
      [
        summary,
        readerPanel(2, "Sessions", 1, "/^session_cnt$/"),
        readerPanel(3, "Lists a missing one", 1, "/^(healthy|crashed)$/"),
      ],
      fakeClickHouse(),
    );
    const problems = report.files[0]?.problems ?? [];
    expect(problems.map((p) => p.where)).toEqual([
      'panel "Sessions"',
      'panel "Lists a missing one"',
    ]);
    expect(problems[0]?.message).toMatch(
      /\/\^session_cnt\$\/.*available: session_count, healthy, failed, verdict/,
    );
    expect(problems[0]?.detail).toContain('panel "Fleet verdict", query A');
    expect(problems[1]?.message).toMatch(/lists "crashed"/);
  });

  it("reports the source's own error once, not once per reader", async () => {
    const report = await run(
      [summary, readerPanel(2, "Sessions", 1, "/^a$/"), readerPanel(3, "Healthy", 1, "/^b$/")],
      fakeClickHouse({ failSummary: true }),
    );
    const problems = report.files[0]?.problems ?? [];
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe('panel "Fleet verdict", query A');
    expect(problems[0]?.message).toMatch(/Code: 47/);
  });

  it("warns, and does not guess, when the reader has transformations", async () => {
    const report = await run(
      [
        summary,
        readerPanel(2, "Renamed", 1, "/^whatever$/", { transformations: [{ id: "organize" }] }),
      ],
      fakeClickHouse(),
    );
    expect(report.problemCount).toBe(0);
    expect(report.files[0]?.warnings[0]?.message).toMatch(/transformations/);
  });

  it("checks the ids without a connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-dashsrc-"));
    writeFileSync(
      join(dir, "d.json"),
      JSON.stringify(dashboardJson({ panels: [summary, readerPanel(2, "Lost", 42, "/^a$/")] })),
    );
    const report = await checkDashboards({ dir, connection: undefined });
    expect(report.files[0]?.problems[0]?.message).toMatch(/reads panel 42/);
  });
});
