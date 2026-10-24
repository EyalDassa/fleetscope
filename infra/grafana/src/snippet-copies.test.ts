import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDashboards } from "./check";
import { readNamedSnippets, snippetCopyProblems, snippetNameOf } from "./snippet-copies";
import { dashboardJson, statPanel } from "./test-fixtures";

const README = [
  "```sql name=capacity-demo",
  "SELECT count() AS n",
  "FROM sessions",
  "```",
  "```sql name=session-facts",
  "SELECT 1",
  "```",
].join("\n");
const snippets = readNamedSnippets(README);
const where = "panel P, query A";

describe("snippetCopyProblems", () => {
  it("reads every named block and the marker comment", () => {
    expect([...snippets.keys()]).toEqual(["capacity-demo", "session-facts"]);
    expect(snippetNameOf("-- snippet: capacity-demo\nSELECT 1")).toBe("capacity-demo");
    expect(snippetNameOf("SELECT 1 -- snippet: x")).toBeUndefined(); // only a comment line of its own
  });

  it("accepts an exact copy, whatever the comments and spacing", () => {
    const sql = "-- snippet: capacity-demo\n-- more\nSELECT   count() AS n  FROM sessions";
    expect(snippetCopyProblems(sql, snippets, { where, requireCopy: true })).toEqual({
      problems: [],
      used: "capacity-demo",
    });
  });

  it("refuses an edited copy and shows the difference", () => {
    const sql = "-- snippet: capacity-demo\nSELECT count() AS n FROM sessions FINAL";
    const { problems } = snippetCopyProblems(sql, snippets, { where, requireCopy: false });
    expect(problems[0]?.message).toContain("is not the README block `capacity-demo`");
    expect(problems[0]?.detail).toBeDefined();
  });

  it("refuses a block the README does not have", () => {
    const { problems } = snippetCopyProblems("-- snippet: nope\nSELECT 1", snippets, {
      where,
      requireCopy: false,
    });
    expect(problems[0]?.message).toContain("does not have");
  });

  it("without a marker: free where a copy is optional, an implicit copy or a problem where required", () => {
    const edited = "SELECT count() AS n FROM sessions FINAL";
    expect(snippetCopyProblems(edited, snippets, { where, requireCopy: false }).problems).toEqual(
      [],
    );
    expect(
      snippetCopyProblems(edited, snippets, { where, requireCopy: true }).problems[0]?.message,
    ).toContain("not a copy of any");
    const exact = "SELECT count() AS n FROM sessions";
    expect(snippetCopyProblems(exact, snippets, { where, requireCopy: true })).toEqual({
      problems: [],
      used: "capacity-demo",
    });
  });

  it("leaves session-facts to its own rule", () => {
    expect(
      snippetCopyProblems(
        "-- snippet: session-facts\nWITH facts AS (SELECT 2) SELECT 1",
        snippets,
        {
          where,
          requireCopy: true,
        },
      ).problems,
    ).toEqual([]);
  });
});

describe("checkDashboards with snippets", () => {
  function run(uid: string, sql: string) {
    const dir = mkdtempSync(join(tmpdir(), "fs-snippets-"));
    writeFileSync(
      join(dir, `${uid}.json`),
      JSON.stringify(dashboardJson({ uid, title: `T ${uid}`, panels: [statPanel("P", sql)] })),
    );
    return checkDashboards({ dir, connection: undefined, snippets });
  }

  it("on the Capacity dashboard every panel query must be a copy", async () => {
    const bad = await run("fleetscope-capacity", "SELECT 1 AS n");
    expect(bad.files[0]?.problems.map((p) => p.message).join("\n")).toContain("not a copy of any");
    const good = await run("fleetscope-capacity", "SELECT count() AS n FROM sessions");
    expect(good.files[0]?.problems.filter((p) => /copy|block/.test(p.message))).toEqual([]);
  });

  it("on another dashboard a marked query is compared, an unmarked one is not", async () => {
    const free = await run("other", "SELECT 1 AS n");
    expect(free.files[0]?.problems.filter((p) => /copy|block/.test(p.message))).toEqual([]);
    const marked = await run("other", "-- snippet: capacity-demo\nSELECT 1 AS n");
    expect(marked.files[0]?.problems.map((p) => p.message).join("\n")).toContain(
      "is not the README block",
    );
  });
});
