import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDashboards } from "./check";
import {
  describeDifference,
  factsBodies,
  normalizeSql,
  readSessionFacts,
  sessionFactsProblems,
} from "./session-facts";
import { dashboardJson, statPanel } from "./test-fixtures";

// A small stand-in for the README block. The real one is compared in CI against the real dashboards.
const BLOCK = `WITH
    picked AS
    (
        SELECT *
        FROM sessions FINAL
        WHERE engine IN (\${engine:singlequote}) AND started_at <= $__toTime
    )
SELECT p.session_id AS session_id, multiIf(p.status = 'running', 'running', 'failed') AS display_status
FROM picked AS p`;

/** The block as a panel pastes it: indented inside `WITH facts AS ( ... )`, with comments. */
const wrap = (block: string, tail = "SELECT count() FROM facts"): string =>
  `-- a comment\nWITH facts AS\n(\n${block
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}\n)\n${tail}`;

describe("readSessionFacts", () => {
  it("takes the fenced block named session-facts, also with Windows line ends", () => {
    const readme =
      "intro\n\n```sql name=other\nSELECT 1\n```\n\n```sql name=session-facts\nSELECT 2\nFROM t\n```\n";
    expect(readSessionFacts(readme)).toBe("SELECT 2\nFROM t");
    expect(readSessionFacts(readme.replace(/\n/g, "\r\n"))).toBe("SELECT 2\r\nFROM t");
    expect(readSessionFacts("```sql name=other\nSELECT 1\n```")).toBeUndefined();
  });
});

describe("normalizeSql", () => {
  it("ignores comments, indentation and spacing around ( ) and commas", () => {
    expect(normalizeSql("SELECT  a ,\n  b  -- note\nFROM  t /* x */ WHERE ( a = 1 )")).toBe(
      "SELECT a,b FROM t WHERE(a = 1)",
    );
  });
  it("keeps strings exactly", () => {
    expect(normalizeSql("SELECT 'a  ,  b' , \"c  d\"")).toBe("SELECT 'a  ,  b',\"c  d\"");
  });
});

describe("factsBodies", () => {
  it("returns every facts CTE, normalised, and nothing for queries without one", () => {
    expect(factsBodies(wrap("SELECT 1"))).toEqual(["SELECT 1"]);
    expect(factsBodies("SELECT 1 FROM t")).toEqual([]);
    const two = `${wrap("SELECT 1")}\nUNION ALL\nWITH facts AS (SELECT 2) SELECT 3 FROM facts`;
    expect(factsBodies(two)).toEqual(["SELECT 1", "SELECT 2"]);
  });
  it("finds a facts CTE that is not the first, and ignores one in a comment or a string", () => {
    expect(factsBodies("WITH a AS (SELECT 1), facts AS (SELECT 2) SELECT * FROM facts")).toEqual([
      "SELECT 2",
    ]);
    expect(factsBodies("-- WITH facts AS (SELECT 9)\nSELECT 'facts AS (x)'")).toEqual([]);
  });
});

describe("sessionFactsProblems", () => {
  it("accepts an exact copy, however it is indented and commented", () => {
    expect(sessionFactsProblems(wrap(BLOCK), BLOCK, "fleetscope-overview")).toEqual([]);
    expect(
      sessionFactsProblems(wrap(BLOCK).replace(/SELECT \*/, "SELECT   * /* all */"), BLOCK, "x"),
    ).toEqual([]);
  });

  it("accepts a query without a facts CTE", () => {
    expect(sessionFactsProblems("SELECT 1", BLOCK, "x")).toEqual([]);
  });

  it("reports an edited copy with a short diff that shows both sides", () => {
    const edited = BLOCK.replace("'failed'", "'blocked'");
    const [problem] = sessionFactsProblems(wrap(edited), BLOCK, "fleetscope-overview");
    expect(problem?.message).toMatch(
      /differs from the session-facts block of packages\/db\/README\.md/,
    );
    expect(problem?.detail).toContain("README:");
    expect(problem?.detail).toContain("panel:");
    expect(problem?.detail).toMatch(/\[failed\]/);
    expect(problem?.detail).toMatch(/\[blocked\]/);
    expect(problem?.detail?.length).toBeLessThan(500);
  });

  it("reports an extra or a missing piece, and a changed filter on a dashboard that may not change it", () => {
    expect(sessionFactsProblems(wrap(`${BLOCK}\nWHERE 1`), BLOCK, "x")).toHaveLength(1);
    expect(
      sessionFactsProblems(wrap(BLOCK.replace("FROM picked AS p", "")), BLOCK, "x"),
    ).toHaveLength(1);
    const oneSession = BLOCK.replace(
      /WHERE engine IN .*\$__toTime/,
      "WHERE session_id = decodeURLComponent('${session:percentencode}')",
    );
    expect(sessionFactsProblems(wrap(oneSession), BLOCK, "fleetscope-sessions")).toHaveLength(1);
  });

  it("lets only the Session dashboard select one session in picked", () => {
    const oneSession = BLOCK.replace(
      /WHERE engine IN .*\$__toTime/,
      "WHERE session_id = decodeURLComponent('${session:percentencode}')",
    );
    expect(sessionFactsProblems(wrap(oneSession), BLOCK, "fleetscope-session")).toEqual([]);
    // ... but not any other change next to it
    const alsoEdited = oneSession.replace("'running'", "'busy'");
    expect(sessionFactsProblems(wrap(alsoEdited), BLOCK, "fleetscope-session")).toHaveLength(1);
    // ... and the filter must be about the session variable
    const notTheSession = BLOCK.replace(
      /WHERE engine IN .*\$__toTime/,
      "WHERE engine = 'chromium'",
    );
    expect(sessionFactsProblems(wrap(notTheSession), BLOCK, "fleetscope-session")).toHaveLength(1);
  });
});

describe("describeDifference", () => {
  it("is undefined for equal text and marks the differing part otherwise", () => {
    expect(describeDifference("abc", "abc")).toBeUndefined();
    expect(describeDifference("abc def ghi", "abc XYZ ghi")).toBe(
      "README: abc [def] ghi\n    panel:  abc [XYZ] ghi",
    );
  });
  it("clips a long difference", () => {
    const text = describeDifference("start", `start${"x".repeat(500)}`) ?? "";
    expect(text.length).toBeLessThan(300);
    expect(text).toContain("...");
  });
});

describe("checkDashboards with the session-facts rule", () => {
  function run(sqls: Record<string, string>, sessionFacts: string | undefined) {
    const dir = mkdtempSync(join(tmpdir(), "fs-facts-"));
    const panels = Object.entries(sqls).map(([title, sql]) => statPanel(title, sql));
    writeFileSync(join(dir, "d.json"), JSON.stringify(dashboardJson({ panels })));
    return checkDashboards({ dir, connection: undefined, sessionFacts });
  }

  it("names the dashboard file and the panel of the copy that differs", async () => {
    const report = await run(
      { Good: wrap(BLOCK), Edited: wrap(BLOCK.replace("'failed'", "'blocked'")) },
      BLOCK,
    );
    expect(report.problemCount).toBe(1);
    const problem = report.files[0]?.problems[0];
    expect(report.files[0]?.file).toBe("d.json");
    expect(problem?.where).toBe('panel "Edited", query A');
    expect(problem?.detail).toContain("First difference");
  });

  it("does not run the rule when no README block is given", async () => {
    const report = await run({ Edited: wrap(BLOCK.replace("'failed'", "'blocked'")) }, undefined);
    expect(report.problemCount).toBe(0);
  });
});
