import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrationFiles, MigrationError, splitStatements } from "./migrate";

/** QA edge cases for the migration file loader and the statement splitter (no ClickHouse). */

const dirs: string[] = [];
async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fleetscope-qa-migrations-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadMigrationFiles", () => {
  it("returns the real migrations in numeric order with a sha256 checksum", async () => {
    const files = await loadMigrationFiles();
    expect(files.map((f) => f.name)).toEqual([
      "0001_sessions.sql",
      "0002_actions.sql",
      "0003_resource_samples.sql",
      "0004_network_requests.sql",
      "0005_issues.sql",
      "0006_insert_dedup_window.sql",
    ]);
    for (const file of files) expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(files.map((f) => f.checksum)).size).toBe(files.length);
  });

  it("returns an empty list for an empty directory", async () => {
    expect(await loadMigrationFiles(await tempDir({}))).toEqual([]);
  });

  it("ignores files that are not .sql", async () => {
    const dir = await tempDir({ "0001_a.sql": "SELECT 1;", "README.md": "hi", "notes.txt": "x" });
    expect((await loadMigrationFiles(dir)).map((f) => f.name)).toEqual(["0001_a.sql"]);
  });

  it("rejects badly named .sql files", async () => {
    for (const name of [
      "1_a.sql",
      "0001-a.sql",
      "0001_A.sql",
      "0001_.sql",
      "init.sql",
      "00001_a.sql",
    ]) {
      const dir = await tempDir({ [name]: "SELECT 1;" });
      await expect(loadMigrationFiles(dir), name).rejects.toThrow(MigrationError);
    }
  });

  it("rejects two migrations that share a number", async () => {
    const dir = await tempDir({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 2;" });
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/share the number 0001/);
  });

  it("changes the checksum when a single character changes", async () => {
    const one = await loadMigrationFiles(await tempDir({ "0001_a.sql": "SELECT 1;" }));
    const two = await loadMigrationFiles(await tempDir({ "0001_a.sql": "SELECT 1; " }));
    expect(one[0]?.checksum).not.toBe(two[0]?.checksum);
  });
});

describe("splitStatements", () => {
  it("returns nothing for empty or comment-only files", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("-- just a comment\n-- another;\n")).toEqual([]);
    expect(splitStatements(";;;")).toEqual([]);
  });

  it("handles Windows line endings when there are no comments", () => {
    const sql =
      "CREATE TABLE a (x UInt8) ENGINE = Memory;\r\nCREATE TABLE b (y UInt8) ENGINE = Memory;\r\n";
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE a (x UInt8) ENGINE = Memory",
      "CREATE TABLE b (y UInt8) ENGINE = Memory",
    ]);
  });

  // QA-M0-08 (fixed in round 1): a comment ending in \r used to survive and be cut at its ";".
  it("QA-M0-08: strips comments in files with Windows line endings", () => {
    const sql = "-- note; with semicolon\r\nCREATE TABLE a (x UInt8) ENGINE = Memory;\r\n";
    expect(splitStatements(sql)).toEqual(["CREATE TABLE a (x UInt8) ENGINE = Memory"]);
  });

  it("keeps a statement without a trailing semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  // The README rule: a file that fails halfway re-runs from its first statement, so a file has one
  // statement or only statements that are safe to run twice. 0006 sets the same setting on five
  // tables (MODIFY SETTING just sets the value again).
  it("gives every real migration one statement, or only statements that are safe to repeat", async () => {
    const repeatable = /^(CREATE TABLE IF NOT EXISTS|ALTER TABLE \w+\s+MODIFY SETTING)\b/i;
    for (const file of await loadMigrationFiles()) {
      const statements = splitStatements(file.sql);
      if (statements.length === 1) continue;
      for (const statement of statements) expect(statement, file.name).toMatch(repeatable);
    }
  });

  // Documented limitation (see the doc comment on splitStatements). If this starts failing the
  // limitation was lifted and the test can go.
  it("cuts a string literal that contains a semicolon or a double dash (known limitation)", () => {
    expect(splitStatements("SELECT 'a;b'")).toEqual(["SELECT 'a", "b'"]);
    expect(splitStatements("SELECT 'a--b' AS x")).toEqual(["SELECT 'a"]);
  });
});
