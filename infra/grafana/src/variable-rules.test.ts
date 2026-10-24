import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDashboards } from "./check";
import { dashboardJson, statPanel } from "./test-fixtures";
import { textboxProblems } from "./variable-rules";

// R-M2-19: a text box may reach SQL only as decodeURLComponent('${name:percentencode}').

const boxes = ["session", "cause"];
const SAFE_SESSION = "decodeURLComponent('${session:percentencode}')";

describe("textboxProblems: what is allowed", () => {
  it("accepts the percentencode form inside decodeURLComponent('...')", () => {
    expect(textboxProblems(`SELECT 1 FROM t WHERE session_id = ${SAFE_SESSION}`, boxes)).toEqual(
      [],
    );
    // spacing and line breaks inside the call are fine, and so is a second use
    expect(
      textboxProblems(
        `WHERE a = decodeURLComponent( '\${session:percentencode}' )\n  OR b = decodeURLComponent(\n'\${session:percentencode}')`,
        boxes,
      ),
    ).toEqual([]);
  });

  it("does not count the variable argument of $__conditionalAll as a use", () => {
    const sql = `WHERE $__conditionalAll(f.cause = decodeURLComponent('\${cause:percentencode}'), $cause)`;
    expect(textboxProblems(sql, boxes)).toEqual([]);
    expect(textboxProblems(sql.replace("$cause)", "${cause})"), boxes)).toEqual([]);
  });

  it("leaves the multi-select query variables alone: their values come from the database", () => {
    const sql =
      "WHERE engine IN (${engine:singlequote}) AND source IN (${source:singlequote}) AND agent IN ($agent)";
    expect(textboxProblems(sql, boxes)).toEqual([]);
    // ... and a variable that is not a text box in this dashboard is none of the rule's business
    expect(textboxProblems("WHERE x = ${session:singlequote}", [])).toEqual([]);
  });

  it("does not take a longer name for the variable, or a comment for a use", () => {
    expect(
      textboxProblems("WHERE a = $sessions AND b = $session_id AND c = $my_session", boxes),
    ).toEqual([]);
    expect(textboxProblems("SELECT 1 -- ${session:singlequote}\n/* '${cause}' */", boxes)).toEqual(
      [],
    );
  });

  it("accepts SQL that does not use a text box at all", () => {
    expect(textboxProblems("SELECT 1", boxes)).toEqual([]);
  });
});

describe("textboxProblems: what fails", () => {
  const fails = (sql: string): string[] => textboxProblems(sql, boxes).map((p) => p.detail);

  it("rejects singlequote, the form this rule exists for", () => {
    const [problem] = textboxProblems(
      "SELECT 1 FROM t WHERE session_id = ${session:singlequote}",
      boxes,
    );
    expect(problem?.message).toMatch(/text box variable \$\{session:singlequote\}/);
    expect(problem?.message).toMatch(/decodeURLComponent\('\$\{session:percentencode\}'\)/);
    expect(problem?.detail).toBe(
      "Found: SELECT 1 FROM t WHERE session_id = ${session:singlequote}",
    );
  });

  it("shows a bounded snippet of a long query, not all of it", () => {
    const long = `SELECT ${"a, ".repeat(60)}x FROM t WHERE session_id = \${session:singlequote} ${"AND y = 1 ".repeat(20)}`;
    const [problem] = textboxProblems(long, boxes);
    expect(problem?.detail.startsWith("Found: ...")).toBe(true);
    expect(problem?.detail.endsWith("...")).toBe(true);
    expect(problem?.detail.length).toBeLessThan(140);
    expect(problem?.detail).toContain("${session:singlequote}");
  });

  it("rejects a quoted variable, a bare variable and the old [[name]] form", () => {
    expect(fails("WHERE a = '${session}'")).toHaveLength(1);
    expect(fails("WHERE a = $session")).toHaveLength(1);
    expect(fails("WHERE a = [[session]] OR b = [[cause:raw]]")).toHaveLength(2);
    expect(fails("WHERE a = ${session}")[0]).toContain("${session}");
  });

  it("rejects any other format", () => {
    for (const format of ["raw", "csv", "sqlstring", "doublequote", "queryparam"]) {
      expect(fails(`WHERE a = \${session:${format}}`), format).toHaveLength(1);
    }
  });

  it("rejects percentencode that is not wrapped the safe way", () => {
    expect(fails("WHERE a = '${session:percentencode}'")).toHaveLength(1); // no decode: not what is meant
    expect(fails("WHERE a = decodeURLComponent(${session:percentencode})")).toHaveLength(1); // not a string
    expect(fails('WHERE a = decodeURLComponent("${session:percentencode}")')).toHaveLength(1); // " is an identifier
    expect(fails("WHERE a = lower('${session:percentencode}')")).toHaveLength(1); // some other function
    expect(fails("WHERE a = decodeURLComponent('x${session:percentencode}')")).toHaveLength(1); // not the whole string
  });

  it("rejects an unsafe use inside the condition of $__conditionalAll", () => {
    const sql = "WHERE $__conditionalAll(f.cause = ${cause:singlequote}, $cause)";
    const found = textboxProblems(sql, boxes);
    expect(found).toHaveLength(1); // the condition, not the $cause argument
    expect(found[0]?.message).toContain("${cause:singlequote}");
    // the snippet is the dashboard's own SQL, with the macro's variable argument masked
    expect(found[0]?.detail).toBe(
      "Found: WHERE $__conditionalAll(f.cause = ${cause:singlequote}, ______)",
    );
  });

  it("reports every unsafe use, each with its own snippet", () => {
    const found = textboxProblems(
      `WHERE a = \${session:singlequote} AND b = ${SAFE_SESSION} AND c = '\${cause}'`,
      boxes,
    );
    expect(found).toHaveLength(2);
    expect(found[0]?.detail).toContain("a = ${session:singlequote}");
    expect(found[1]?.detail).toContain("c = '${cause}'");
  });
});

describe("checkDashboards: the text box rule", () => {
  function run(sqls: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "fs-textbox-rule-"));
    const dashboard = dashboardJson({
      title: "Session",
      templating: {
        list: [
          { name: "session", type: "textbox", query: "" },
          {
            name: "engine",
            type: "custom",
            query: "chromium,lightpanda",
            multi: true,
            includeAll: true,
          },
        ],
      },
      panels: Object.entries(sqls).map(([title, sql]) => statPanel(title, sql)),
    });
    writeFileSync(join(dir, "d.json"), JSON.stringify(dashboard));
    return checkDashboards({ dir, connection: undefined });
  }

  it("passes the safe form and the multi-select singlequote form", async () => {
    const report = await run({
      Status: `SELECT 1 FROM sessions WHERE session_id = ${SAFE_SESSION}`,
      Engines: "SELECT 1 FROM sessions WHERE engine IN (${engine:singlequote})",
    });
    expect(report.problemCount).toBe(0);
  });

  it("names the dashboard, the panel and the offending snippet", async () => {
    const report = await run({
      Good: `SELECT 1 FROM sessions WHERE session_id = ${SAFE_SESSION}`,
      Careless: "SELECT 1 FROM sessions WHERE session_id = ${session:singlequote}",
    });
    expect(report.problemCount).toBe(1);
    const file = report.files[0];
    expect(file?.file).toBe("d.json");
    const problem = file?.problems[0];
    expect(problem?.where).toBe('panel "Careless", query A');
    expect(problem?.message).toMatch(/text box variable \$\{session:singlequote\}/);
    expect(problem?.detail).toContain("session_id = ${session:singlequote}");
  });
});
