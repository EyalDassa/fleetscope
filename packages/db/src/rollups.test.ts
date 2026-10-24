import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, splitStatements } from "./migrate";
import { ROLLUP_ACTIONS_SELECT, ROLLUP_SAMPLES_SELECT } from "./rollups";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** The SELECT of a materialized view in migration 0007, whitespace squashed. */
async function viewSelect(viewName: string): Promise<string> {
  const sql = await readFile(`${DEFAULT_MIGRATIONS_DIR}/0007_fleet_minute.sql`, "utf8");
  const statement = splitStatements(sql).find((s) => s.includes(`VIEW IF NOT EXISTS ${viewName}`));
  if (!statement) throw new Error(`view ${viewName} not found in 0007`);
  const squashed = squash(statement);
  return squashed.slice(squashed.indexOf(" AS SELECT ") + " AS ".length);
}

describe("backfill SELECTs", () => {
  it("are the same text as the materialized views in migration 0007", async () => {
    expect(squash(ROLLUP_ACTIONS_SELECT)).toBe(await viewSelect("fleet_minute_actions_mv"));
    expect(squash(ROLLUP_SAMPLES_SELECT)).toBe(await viewSelect("fleet_minute_samples_mv"));
  });
});
