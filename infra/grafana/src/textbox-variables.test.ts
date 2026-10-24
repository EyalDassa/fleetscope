import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDashboards, makeVariableState } from "./check";
import type { Fetch } from "./clickhouse-http";
import type { VariableDefinition } from "./dashboards";
import { dashboardJson, statPanel } from "./test-fixtures";

// R-M2-13: text boxes (`cause`, `session`) used to stay empty in both modes, so the branch that
// filters by them never ran, and every Session detail query ran on no data.

const textbox = (name: string, partial: Partial<VariableDefinition> = {}): VariableDefinition => ({
  name,
  type: "textbox",
  multi: false,
  includeAll: false,
  allValue: undefined,
  queryText: "",
  sql: undefined,
  current: [],
  jsonOptions: [],
  ...partial,
});

describe("makeVariableState for text boxes", () => {
  it("is empty by default and gets a placeholder in the filtered mode", () => {
    expect(makeVariableState(textbox("cause"), [], "default")?.selected).toEqual([""]);
    const filtered = makeVariableState(textbox("cause"), [], "filtered");
    expect(filtered?.selected[0]).toMatch(/placeholder/);
    expect(filtered?.all).toBe(false);
  });

  it("gives the session box the newest real session in the filtered mode only", () => {
    expect(makeVariableState(textbox("session"), [], "default", "S-NEWEST")?.selected).toEqual([
      "",
    ]);
    expect(makeVariableState(textbox("session"), [], "filtered", "S-NEWEST")?.selected).toEqual([
      "S-NEWEST",
    ]);
    // another box does not get the session id
    expect(makeVariableState(textbox("cause"), [], "filtered", "S-NEWEST")?.selected[0]).toMatch(
      /placeholder/,
    );
    // with no real session, the session box falls back to the placeholder
    expect(makeVariableState(textbox("session"), [], "filtered")?.selected[0]).toMatch(
      /placeholder/,
    );
  });

  it("keeps a value the dashboard already sets", () => {
    const preset = textbox("session", { current: ["FIXED"] });
    expect(makeVariableState(preset, [], "default", "S-NEWEST")?.selected).toEqual(["FIXED"]);
    expect(makeVariableState(preset, [], "filtered", "S-NEWEST")?.selected).toEqual(["FIXED"]);
    const queryDefault = textbox("cause", { queryText: "timeout" });
    expect(makeVariableState(queryDefault, [], "filtered")?.selected).toEqual(["timeout"]);
  });
});

describe("checkDashboards with text boxes", () => {
  const sent: string[] = [];
  const fetchImpl = (async (_url: URL | string, init?: RequestInit) => {
    const sql = String(init?.body);
    sent.push(sql);
    if (sql.startsWith("SELECT session_id FROM sessions FINAL ORDER BY started_at DESC LIMIT 1")) {
      return new Response(
        JSON.stringify({ meta: [{ name: "session_id" }], data: [["s-newest-0001"]] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ meta: [{ name: "n" }], data: [[1]] }), { status: 200 });
  }) as unknown as Fetch;

  const dashboard = dashboardJson({
    templating: {
      list: [
        { name: "session", type: "textbox", query: "", current: { value: "" } },
        { name: "cause", type: "textbox", query: "", current: { value: "" } },
      ],
    },
    panels: [
      statPanel(
        "Per session",
        "SELECT count() FROM actions WHERE session_id = ${session:singlequote}",
      ),
      statPanel(
        "Filtered by cause",
        "SELECT count() FROM sessions WHERE $__conditionalAll(cause = ${cause:singlequote}, $cause)",
      ),
    ],
  });

  function run(extra: { fetchImpl?: Fetch } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fs-textbox-"));
    writeFileSync(join(dir, "d.json"), JSON.stringify(dashboard));
    sent.length = 0;
    return checkDashboards({
      dir,
      connection: { url: "http://ch.test:8123", user: "u", password: "p", database: "d" },
      now: new Date(Date.UTC(2024, 0, 1, 12)),
      fetchImpl: extra.fetchImpl ?? fetchImpl,
    });
  }

  it("runs the per-session query once empty and once with the newest real session", async () => {
    const report = await run();
    expect(report.problemCount).toBe(0);
    const perSession = sent.filter((sql) => sql.includes("FROM actions"));
    expect(perSession).toEqual([
      "SELECT count() FROM actions WHERE session_id = ''",
      "SELECT count() FROM actions WHERE session_id = 's-newest-0001'",
    ]);
  });

  it("runs the cause filter branch, which used to be 1=1 in both modes", async () => {
    await run();
    const byCause = sent.filter((sql) => sql.includes("FROM sessions WHERE"));
    expect(byCause[0]).toBe("SELECT count() FROM sessions WHERE 1=1");
    expect(byCause[1]).toMatch(/WHERE cause = 'fleetscope-check-placeholder'$/);
  });

  it("warns, and still runs, when there is no session to use", async () => {
    const empty = (async (_url: URL | string, init?: RequestInit) => {
      const sql = String(init?.body);
      const data = sql.startsWith("SELECT session_id FROM sessions FINAL") ? [] : [[1]];
      return new Response(JSON.stringify({ meta: [{ name: "n" }], data }), { status: 200 });
    }) as unknown as Fetch;
    const report = await run({ fetchImpl: empty });
    expect(report.problemCount).toBe(0);
    const warning = report.files[0]?.warnings.find((w) => w.where === 'variable "session"');
    expect(warning?.message).toMatch(
      /no real session id was found.*sessions table is empty.*db:seed/,
    );
  });

  it("warns with the ClickHouse error when the lookup fails", async () => {
    const failing = (async (_url: URL | string, init?: RequestInit) => {
      if (String(init?.body).startsWith("SELECT session_id FROM sessions FINAL")) {
        return new Response("Code: 497. DB::Exception: Not enough privileges", { status: 403 });
      }
      return new Response(JSON.stringify({ meta: [{ name: "n" }], data: [[1]] }), { status: 200 });
    }) as unknown as Fetch;
    const report = await run({ fetchImpl: failing });
    expect(report.problemCount).toBe(0);
    expect(report.files[0]?.warnings[0]?.message).toMatch(/Code: 497/);
  });
});
