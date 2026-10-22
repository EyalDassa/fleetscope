import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "./client";
import { insertEvents } from "./insert";
import { loadMigrationFiles, MigrationError, runMigrations } from "./migrate";
import { ping } from "./ping";
import { seed } from "./seed";
import { buildSeedEvents } from "./seed-events";
import { createTestDatabase, dropDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;

beforeAll(async () => {
  // Migrating a fresh database is what we test, so create it without migrating first.
  db = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await db.cleanup();
});

async function rows<T>(query: string): Promise<T[]> {
  const result = await db.client.query({ query, format: "JSONEachRow" });
  return result.json<T>();
}

describe("migrations", () => {
  it("applies everything on a fresh database and is a no-op the second time", async () => {
    const files = await loadMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);

    const first = await runMigrations(db.config);
    expect(first.applied).toEqual(files.map((f) => f.name));

    const second = await runMigrations(db.config);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(files.map((f) => f.name));

    const ledger = await rows<{ name: string }>("SELECT name FROM schema_migrations");
    expect(ledger).toHaveLength(files.length);
  });

  it("creates every table with the expected engine and keys", async () => {
    const tables = await rows<{
      name: string;
      engine: string;
      partition_key: string;
      sorting_key: string;
      engine_full: string;
    }>(
      `SELECT name, engine, partition_key, sorting_key, engine_full
       FROM system.tables WHERE database = currentDatabase() ORDER BY name`,
    );
    const byName = Object.fromEntries(tables.map((t) => [t.name, t]));

    expect(byName.sessions).toMatchObject({
      engine: "ReplacingMergeTree",
      sorting_key: "session_id",
    });
    expect(byName.sessions?.engine_full).toContain("version");

    for (const name of ["actions", "resource_samples", "network_requests", "issues"]) {
      expect(byName[name], name).toMatchObject({
        engine: "MergeTree",
        partition_key: "toDate(ts)",
        sorting_key: "engine, session_id, ts",
      });
      expect(byName[name]?.engine_full, name).toContain("TTL toDate(ts) + toIntervalDay(30)");
    }
  });

  it("fails loudly on a bad migration and does not record it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleetscope-migrations-"));
    try {
      await writeFile(
        join(dir, "0001_ok.sql"),
        "CREATE TABLE IF NOT EXISTS ok_table (x UInt8) ENGINE = Memory;",
      );
      await writeFile(
        join(dir, "0002_bad.sql"),
        "CREATE TABLE broken (x NotAType) ENGINE = Memory;",
      );
      const config = { ...db.config, database: `${db.config.database}_bad` };
      await expect(runMigrations(config, { dir })).rejects.toThrow(/0002_bad\.sql failed/);

      const client = createClickHouseClient(config);
      const result = await client.query({
        query: "SELECT name FROM schema_migrations",
        format: "JSONEachRow",
      });
      expect((await result.json<{ name: string }>()).map((r) => r.name)).toEqual(["0001_ok.sql"]);
      await client.close();
      await dropDatabase(config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run when an applied migration file was edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleetscope-migrations-"));
    const config = { ...db.config, database: `${db.config.database}_edit` };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "0001_t.sql"),
        "CREATE TABLE IF NOT EXISTS t (x UInt8) ENGINE = Memory;",
      );
      await runMigrations(config, { dir });
      await writeFile(
        join(dir, "0001_t.sql"),
        "CREATE TABLE IF NOT EXISTS t (x UInt16) ENGINE = Memory;",
      );
      await expect(runMigrations(config, { dir })).rejects.toThrow(MigrationError);
    } finally {
      await dropDatabase(config);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ping", () => {
  it("is true for a healthy server and false for an unreachable one", async () => {
    expect(await ping(db.client)).toBe(true);
    const dead = createClickHouseClient({ ...db.config, url: "http://127.0.0.1:1" });
    expect(await ping(dead, 500)).toBe(false);
    await dead.close();
  });
});

describe("seed and insertEvents", () => {
  it("seeds sim data in one batch per table and is repeatable", async () => {
    const counts = await seed(db.client);
    expect(counts).toMatchObject({ sessions: 3, orphanedEnds: 0 });
    expect(counts.actions).toBe(9);

    await seed(db.client);

    const sessions = await rows<{
      session_id: string;
      status: string;
      source: string;
      version: number;
    }>("SELECT session_id, status, source, version FROM sessions FINAL ORDER BY session_id");
    expect(sessions.map((s) => [s.session_id, s.status, s.source, s.version])).toEqual([
      ["seed-chromium-1", "success", "sim", 2],
      ["seed-headless-1", "blocked", "sim", 2],
      ["seed-lightpanda-1", "failed", "sim", 2],
    ]);

    const [actions] = await rows<{ n: string }>("SELECT count() AS n FROM actions");
    expect(Number(actions?.n)).toBe(9);
  });

  it("stores unsupported metrics as NULL", async () => {
    const samples = await rows<{ engine: string; js_heap_mb: number | null }>(
      "SELECT engine, js_heap_mb FROM resource_samples ORDER BY engine",
    );
    const lightpanda = samples.filter((s) => s.engine === "lightpanda");
    expect(lightpanda.length).toBeGreaterThan(0);
    expect(lightpanda.every((s) => s.js_heap_mb === null)).toBe(true);
    expect(samples.some((s) => s.js_heap_mb !== null)).toBe(true);
  });

  it("keeps millisecond timestamps", async () => {
    const issue = buildSeedEvents().find((e) => e.type === "issue");
    if (!issue) throw new Error("seed has no issue");
    // Recent on purpose: rows older than the 30 day TTL are dropped on insert.
    const ts = Math.floor(Date.now() / 1000) * 1000 + 123;
    await insertEvents(db.client, [{ ...issue, session_id: "ts-check", ts }]);
    const [row] = await rows<{ ms: string }>(
      "SELECT toUnixTimestamp64Milli(ts) AS ms FROM issues WHERE session_id = 'ts-check'",
    );
    expect(Number(row?.ms)).toBe(ts);
  });

  it("merges a late session.ended with the stored session.started", async () => {
    const events = buildSeedEvents(Date.now());
    const started = events.filter(
      (e) => e.session_id === "seed-chromium-1" && e.type === "session.started",
    );
    const ended = events.filter(
      (e) => e.session_id === "seed-chromium-1" && e.type === "session.ended",
    );
    await db.client.command({ query: "DELETE FROM sessions WHERE session_id = 'seed-chromium-1'" });

    await insertEvents(db.client, started);
    const [running] = await rows<{ status: string }>(
      "SELECT status FROM sessions FINAL WHERE session_id = 'seed-chromium-1'",
    );
    expect(running?.status).toBe("running");

    const counts = await insertEvents(db.client, ended);
    expect(counts.sessions).toBe(1);
    const [done] = await rows<{ status: string; scenario: string }>(
      "SELECT status, scenario FROM sessions FINAL WHERE session_id = 'seed-chromium-1'",
    );
    expect(done).toEqual({ status: "success", scenario: "checkout" });
  });

  it("counts an ended event with no known start as orphaned instead of inventing a session", async () => {
    const ended = buildSeedEvents(Date.now()).filter(
      (e) => e.type === "session.ended" && e.session_id === "seed-lightpanda-1",
    );
    await db.client.command({
      query: "DELETE FROM sessions WHERE session_id = 'seed-lightpanda-1'",
    });
    const counts = await insertEvents(db.client, ended);
    expect(counts).toMatchObject({ sessions: 0, orphanedEnds: 1 });
  });
});
