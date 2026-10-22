import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClickHouseClient } from "./client";
import { insertEvents } from "./insert";
import { loadMigrationFiles, MigrationError, runMigrations } from "./migrate";
import { ping } from "./ping";
import { seed } from "./seed";
import { buildSeedEvents } from "./seed-events";
import { createTestDatabase, dropDatabase, type TestDatabase } from "./testing";

// Every test works on its own: `db` is migrated once and tests that need data insert it
// themselves, under their own session ids, so order does not matter and `-t` works.
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
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
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const files = await loadMigrationFiles();
      expect(files.length).toBeGreaterThanOrEqual(5);

      const first = await runMigrations(fresh.config);
      expect(first.applied).toEqual(files.map((f) => f.name));

      const second = await runMigrations(fresh.config);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual(files.map((f) => f.name));

      const result = await fresh.client.query({
        query: "SELECT name FROM schema_migrations",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(files.length);
    } finally {
      await fresh.cleanup();
    }
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
      partition_key: "toDate(started_at)",
      sorting_key: "session_id",
    });
    expect(byName.sessions?.engine_full).toContain("version");
    expect(byName.sessions?.engine_full).toContain("TTL toDate(started_at) + toIntervalDay(30)");
    expect(byName.sessions?.engine_full).toContain("ttl_only_drop_parts = 1");

    for (const name of ["actions", "resource_samples", "network_requests", "issues"]) {
      expect(byName[name], name).toMatchObject({
        engine: "MergeTree",
        partition_key: "toDate(ts)",
        sorting_key: "engine, session_id, ts",
      });
      expect(byName[name]?.engine_full, name).toContain("TTL toDate(ts) + toIntervalDay(30)");
      expect(byName[name]?.engine_full, name).toContain("ttl_only_drop_parts = 1");
    }
  });

  it("fails loudly on a bad migration and does not record it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleetscope-migrations-"));
    const config = { ...db.config, database: `${db.config.database}_bad` };
    try {
      await writeFile(
        join(dir, "0001_ok.sql"),
        "CREATE TABLE IF NOT EXISTS ok_table (x UInt8) ENGINE = Memory;",
      );
      await writeFile(
        join(dir, "0002_bad.sql"),
        "CREATE TABLE broken (x NotAType) ENGINE = Memory;",
      );
      await expect(runMigrations(config, { dir })).rejects.toThrow(/0002_bad\.sql failed/);

      const client = createClickHouseClient(config);
      const result = await client.query({
        query: "SELECT name FROM schema_migrations",
        format: "JSONEachRow",
      });
      expect((await result.json<{ name: string }>()).map((r) => r.name)).toEqual(["0001_ok.sql"]);
      await client.close();
    } finally {
      await dropDatabase(config);
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

/** The seed events of one session, renamed so a test owns its rows. */
function sessionEvents(sessionId: string, as: string): FleetEvent[] {
  return buildSeedEvents()
    .filter((e) => e.session_id === sessionId)
    .map((e) => ({ ...e, session_id: as }));
}

describe("seed", () => {
  beforeEach(async () => {
    await seed(db.client);
  });

  it("inserts sim data in one batch per table and is repeatable", async () => {
    const counts = await seed(db.client);
    expect(counts).toMatchObject({ sessions: 3, orphanedEnds: 0 });
    expect(counts.actions).toBe(9);

    const sessions = await rows<{
      session_id: string;
      status: string;
      source: string;
      version: number;
    }>(
      `SELECT session_id, status, source, version FROM sessions FINAL
       WHERE startsWith(session_id, 'seed-') ORDER BY session_id`,
    );
    expect(sessions.map((s) => [s.session_id, s.status, s.source, s.version])).toEqual([
      ["seed-chromium-1", "success", "sim", 2],
      ["seed-headless-1", "blocked", "sim", 2],
      ["seed-lightpanda-1", "failed", "sim", 2],
    ]);

    const [actions] = await rows<{ n: string }>(
      "SELECT count() AS n FROM actions WHERE startsWith(session_id, 'seed-')",
    );
    expect(Number(actions?.n)).toBe(9);
  });

  it("stores what a sample cannot measure as NULL", async () => {
    const samples = await rows<{
      engine: string;
      origin: string;
      cpu_pct: number | null;
      js_heap_mb: number | null;
    }>(
      `SELECT engine, origin, cpu_pct, js_heap_mb FROM resource_samples
       WHERE startsWith(session_id, 'seed-') ORDER BY engine, origin`,
    );
    const lightpanda = samples.filter((s) => s.engine === "lightpanda");
    expect(lightpanda.length).toBeGreaterThan(0);
    expect(lightpanda.every((s) => s.js_heap_mb === null)).toBe(true);
    expect(samples.some((s) => s.js_heap_mb !== null)).toBe(true);
    // cdp samples have no container metrics; container samples always have them.
    expect(samples.filter((s) => s.origin === "cdp").every((s) => s.cpu_pct === null)).toBe(true);
    expect(samples.filter((s) => s.origin === "container").every((s) => s.cpu_pct !== null)).toBe(
      true,
    );
  });
});

describe("insertEvents", () => {
  it("keeps millisecond timestamps", async () => {
    const issue = buildSeedEvents().find((e) => e.type === "issue");
    if (!issue) throw new Error("seed has no issue");
    // Recent on purpose: rows older than the 30 day TTL are dropped by a background merge.
    const ts = Math.floor(Date.now() / 1000) * 1000 + 123;
    await insertEvents(db.client, [{ ...issue, session_id: "ts-check", ts }]);
    const [row] = await rows<{ ms: string }>(
      "SELECT toUnixTimestamp64Milli(ts) AS ms FROM issues WHERE session_id = 'ts-check'",
    );
    expect(Number(row?.ms)).toBe(ts);
  });

  it("merges a late session.ended with the stored session.started", async () => {
    const events = sessionEvents("seed-chromium-1", "late-merge");
    const started = events.filter((e) => e.type === "session.started");
    const ended = events.filter((e) => e.type === "session.ended");

    await insertEvents(db.client, started);
    const [running] = await rows<{ status: string }>(
      "SELECT status FROM sessions FINAL WHERE session_id = 'late-merge'",
    );
    expect(running?.status).toBe("running");

    const counts = await insertEvents(db.client, ended);
    expect(counts.sessions).toBe(1);
    const [done] = await rows<{ status: string; scenario: string }>(
      "SELECT status, scenario FROM sessions FINAL WHERE session_id = 'late-merge'",
    );
    expect(done).toEqual({ status: "success", scenario: "checkout" });
  });

  it("counts an ended event with no known start as orphaned instead of inventing a session", async () => {
    const ended = sessionEvents("seed-lightpanda-1", "orphan-1").filter(
      (e) => e.type === "session.ended",
    );
    const counts = await insertEvents(db.client, ended);
    expect(counts).toMatchObject({ sessions: 0, orphanedEnds: 1 });
    const [row] = await rows<{ n: string }>(
      "SELECT count() AS n FROM sessions WHERE session_id = 'orphan-1'",
    );
    expect(Number(row?.n)).toBe(0);
  });

  it("closes sessions started in an earlier flush even with very long session ids", async () => {
    const sessionIds = Array.from({ length: 600 }, (_, n) => `long-${n}-${"x".repeat(120)}`);
    const base = sessionEvents("seed-chromium-1", "template");
    const started = base.find((e) => e.type === "session.started");
    const ended = base.find((e) => e.type === "session.ended");
    if (!started || !ended) throw new Error("template session incomplete");

    await insertEvents(
      db.client,
      sessionIds.map((id) => ({ ...started, event_id: crypto.randomUUID(), session_id: id })),
    );
    const counts = await insertEvents(
      db.client,
      sessionIds.map((id) => ({ ...ended, event_id: crypto.randomUUID(), session_id: id })),
    );
    expect(counts).toMatchObject({ sessions: 600, orphanedEnds: 0 });

    const [row] = await rows<{ n: string }>(
      "SELECT count() AS n FROM sessions FINAL WHERE startsWith(session_id, 'long-') AND status = 'success'",
    );
    expect(Number(row?.n)).toBe(600);
  });
});
