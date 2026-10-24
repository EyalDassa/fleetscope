import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "./client";
import { type DbConfig, loadDbConfig } from "./config";
import { dedupTokensFor, insertEvents } from "./insert";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate";
import { dropDatabase } from "./testing";

/**
 * QA, M1: upgrading a database that M0 already created. Migration 0006 (the insert deduplication
 * window) is the first migration that ALTERs tables that hold data, so the upgrade path is tested
 * with a real M0 database: apply 0001-0005 only, write data, then apply the rest.
 */

let tmp: string;
let m0Dir: string;
const configs: DbConfig[] = [];

function freshConfig(name: string): DbConfig {
  const config = {
    ...loadDbConfig(),
    database: `fleetscope_test_upg_${name}_${Date.now().toString(36)}`,
  };
  configs.push(config);
  return config;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "fleetscope-mig-"));
  m0Dir = join(tmp, "m0");
  await mkdir(m0Dir);
  for (const name of await readdir(DEFAULT_MIGRATIONS_DIR)) {
    if (/^000[1-5]_/.test(name)) await cp(join(DEFAULT_MIGRATIONS_DIR, name), join(m0Dir, name));
  }
});
afterAll(async () => {
  for (const config of configs) await dropDatabase(config);
  await rm(tmp, { recursive: true, force: true });
});

/** Everything after the five M0 migrations. */
const AFTER_M0 = ["0006_insert_dedup_window.sql", "0007_fleet_minute.sql", "0008_pricing.sql"];

const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "qa-upgrade",
  engine: "chromium",
  provider: "local-docker",
});
const action = (id: string, seq: number) =>
  newEvent("action", ctx(id), {
    seq,
    action_type: "goto",
    target: "example.com",
    duration_ms: 5,
    ok: true,
    error_code: null,
  });
const started = (id: string) =>
  newEvent("session.started", ctx(id), {
    engine_version: "1",
    scenario: "s",
    region: "local",
    startup_ms: 1,
    connect_ms: 1,
  });

async function scalar(config: DbConfig, query: string): Promise<string> {
  const client = createClickHouseClient(config);
  try {
    const result = await client.query({ query, format: "JSONEachRow" });
    const [row] = await result.json<Record<string, unknown>>();
    return String(Object.values(row ?? {})[0]);
  } finally {
    await client.close();
  }
}
const showCreate = (config: DbConfig, table: string) =>
  scalar(
    config,
    `SELECT create_table_query FROM system.tables WHERE database = currentDatabase() AND name = '${table}'`,
  );

describe("upgrading an M0 database to 0006", () => {
  it("keeps the data written before, turns the dedupe window on, and then skips a repeated flush", async () => {
    const config = freshConfig("data");
    const first = await runMigrations(config, { dir: m0Dir });
    expect(first.applied).toHaveLength(5);

    // M0 behaviour: the window is off, inserts are never skipped
    const client = createClickHouseClient(config);
    const id = "qa-upgrade-session";
    const before = [started(id), action(id, 0), action(id, 1)];
    await insertEvents(client, before);
    expect(await showCreate(config, "actions")).not.toContain(
      "non_replicated_deduplication_window = 10000",
    );

    const second = await runMigrations(config); // the real migrations directory
    // 0006 is the migration under test; the rollup and pricing migrations (0007, 0008) follow it
    expect(second.applied).toEqual(AFTER_M0);
    expect(second.alreadyApplied).toHaveLength(5);
    for (const table of ["sessions", "actions", "resource_samples", "network_requests", "issues"]) {
      expect(await showCreate(config, table), table).toContain(
        "non_replicated_deduplication_window = 10000",
      );
    }
    // nothing written before is lost or changed
    expect(await scalar(config, `SELECT count() FROM actions WHERE session_id = '${id}'`)).toBe(
      "2",
    );
    expect(
      await scalar(config, `SELECT count() FROM sessions FINAL WHERE session_id = '${id}'`),
    ).toBe("1");

    // the window works on the upgraded table, and token-less inserts still behave as in M0
    const tokens = dedupTokensFor("upgrade-flush");
    const batch = [action(id, 2), action(id, 3)];
    await insertEvents(client, batch, { dedupTokens: tokens });
    await insertEvents(client, batch, { dedupTokens: tokens });
    expect(await scalar(config, `SELECT count() FROM actions WHERE session_id = '${id}'`)).toBe(
      "4",
    );
    const plain = [action(id, 4)];
    await insertEvents(client, plain);
    await insertEvents(client, plain); // no token: written twice, as in M0 (QA-M0-09 at db level)
    expect(await scalar(config, `SELECT count() FROM actions WHERE session_id = '${id}'`)).toBe(
      "6",
    );

    await client.close();
    const third = await runMigrations(config);
    expect(third.applied).toEqual([]);
  });

  it("a 0006 that fails halfway can be run again: it is not recorded, and re-running finishes the job", async () => {
    const config = freshConfig("halfway");
    await runMigrations(config, { dir: m0Dir });

    const real = await readFile(
      join(DEFAULT_MIGRATIONS_DIR, "0006_insert_dedup_window.sql"),
      "utf8",
    );
    const broken = join(tmp, "broken");
    await mkdir(broken);
    for (const name of await readdir(m0Dir)) await cp(join(m0Dir, name), join(broken, name));
    // the real file, but the third statement is invalid
    const statements = real
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const damaged = [
      ...statements.slice(0, 2),
      "ALTER TABLE no_such_table MODIFY SETTING x = 1",
      ...statements.slice(3),
    ];
    await writeFile(join(broken, "0006_insert_dedup_window.sql"), `${damaged.join(";\n")};\n`);

    await expect(runMigrations(config, { dir: broken })).rejects.toThrow();
    // two tables got the window, the file is not in the ledger
    expect(await showCreate(config, "sessions")).toContain(
      "non_replicated_deduplication_window = 10000",
    );
    expect(await showCreate(config, "issues")).not.toContain(
      "non_replicated_deduplication_window = 10000",
    );
    expect(
      await scalar(config, "SELECT count() FROM schema_migrations WHERE name LIKE '0006%'"),
    ).toBe("0");

    const retry = await runMigrations(config); // the real file: every statement is safe to repeat
    expect(retry.applied).toEqual(AFTER_M0);
    for (const table of ["sessions", "actions", "resource_samples", "network_requests", "issues"]) {
      expect(await showCreate(config, table), table).toContain(
        "non_replicated_deduplication_window = 10000",
      );
    }
  });
});
