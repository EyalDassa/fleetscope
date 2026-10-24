import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "./client";
import { type DbConfig, loadDbConfig } from "./config";
import { insertEvents } from "./insert";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate";
import { dropDatabase } from "./testing";

/**
 * QA routing: migration 0009 (`sessions.routed_from`) on a database that already holds sessions.
 * Apply 0001-0008 only, write a running session and an ended one, apply 0009, then: the old rows read
 * NULL, a late session.ended for the old running session works, a new routed session keeps its value,
 * and running the migrations again is a no-op.
 */

let tmp: string;
let before0009: string;
const configs: DbConfig[] = [];
afterAll(async () => {
  for (const config of configs) await dropDatabase(config);
  await rm(tmp, { recursive: true, force: true });
});
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "fleetscope-mig9-"));
  before0009 = join(tmp, "upto-0008");
  await mkdir(before0009);
  for (const name of await readdir(DEFAULT_MIGRATIONS_DIR)) {
    if (/^000[1-8]_/.test(name))
      await cp(join(DEFAULT_MIGRATIONS_DIR, name), join(before0009, name));
  }
});

const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "qa-mig9",
  engine: "chromium",
  provider: "local-docker",
});
const started = (id: string, extra: object = {}) =>
  newEvent("session.started", ctx(id), {
    engine_version: "1",
    scenario: "s",
    region: "local",
    startup_ms: 1,
    connect_ms: 1,
    ...extra,
  });
const ended = (id: string) =>
  newEvent("session.ended", ctx(id), { status: "success", reason: null, duration_ms: 5 });

describe("migration 0009: sessions.routed_from", () => {
  it("upgrades a database with sessions in it, and a second run changes nothing", async () => {
    const config = {
      ...loadDbConfig(),
      database: `fleetscope_test_mig9_${Date.now().toString(36)}`,
    };
    configs.push(config);

    const first = await runMigrations(config, { dir: before0009 });
    expect(first.applied).toHaveLength(8);

    const client = createClickHouseClient(config);
    try {
      await insertEvents(client, [started("old-running"), started("old-done"), ended("old-done")]);

      const second = await runMigrations(config);
      expect(second.applied).toEqual(["0009_sessions_routed_from.sql"]);
      expect(second.alreadyApplied).toHaveLength(8);

      // old rows read NULL, nothing lost
      const old = await client.query({
        query:
          "SELECT session_id, routed_from, status FROM sessions FINAL WHERE session_id LIKE 'old-%' ORDER BY session_id",
        format: "JSONEachRow",
      });
      expect(await old.json()).toEqual([
        { session_id: "old-done", routed_from: null, status: "success" },
        { session_id: "old-running", routed_from: null, status: "running" },
      ]);

      // the old running session ends after the upgrade (copies routed_from from an old row)
      await insertEvents(client, [ended("old-running")]);
      // and a routed session works on the upgraded table
      await insertEvents(client, [started("new-routed", { routed_from: "lightpanda" })]);
      await insertEvents(client, [ended("new-routed")]);
      const now = await client.query({
        query: "SELECT session_id, routed_from, status FROM sessions FINAL ORDER BY session_id",
        format: "JSONEachRow",
      });
      expect(await now.json()).toEqual([
        { session_id: "new-routed", routed_from: "lightpanda", status: "success" },
        { session_id: "old-done", routed_from: null, status: "success" },
        { session_id: "old-running", routed_from: null, status: "success" },
      ]);

      const third = await runMigrations(config);
      expect(third.applied).toEqual([]);
      expect(third.alreadyApplied).toHaveLength(9);
      const column = await client.query({
        query:
          "SELECT type FROM system.columns WHERE database = currentDatabase() AND table = 'sessions' AND name = 'routed_from'",
        format: "JSONEachRow",
      });
      expect(await column.json()).toEqual([{ type: "LowCardinality(Nullable(String))" }]);
    } finally {
      await client.close();
    }
  });

  it("is harmless when the column already exists (ADD COLUMN IF NOT EXISTS)", async () => {
    const config = {
      ...loadDbConfig(),
      database: `fleetscope_test_mig9b_${Date.now().toString(36)}`,
    };
    configs.push(config);
    await runMigrations(config);
    const client = createClickHouseClient(config);
    try {
      // forget that 0009 was applied; the file must run again without error
      await client.command({
        query:
          "ALTER TABLE schema_migrations DELETE WHERE name LIKE '0009%' SETTINGS mutations_sync = 2",
      });
      const again = await runMigrations(config);
      expect(again.applied).toEqual(["0009_sessions_routed_from.sql"]);
    } finally {
      await client.close();
    }
  });
});
