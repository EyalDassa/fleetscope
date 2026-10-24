import { randomBytes } from "node:crypto";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { type ClickHouseClient, createClickHouseClient } from "./client";
import { type DbConfig, loadDbConfig } from "./config";
import { runMigrations } from "./migrate";

/**
 * Helpers for integration tests (need a running ClickHouse, see `pnpm infra:up`).
 * Each test file gets its own throwaway database so tests never touch dev data.
 */
export interface TestDatabase {
  config: DbConfig;
  client: ClickHouseClient;
  /** Drops the database and closes the client. */
  cleanup: () => Promise<void>;
}

export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const base = loadDbConfig();
  const config: DbConfig = {
    ...base,
    database: `fleetscope_test_${randomBytes(6).toString("hex")}`,
  };
  if (options.migrate !== false) await runMigrations(config);
  else await createDatabaseOnly(config);
  const client = createClickHouseClient(config);
  return {
    config,
    client,
    cleanup: async () => {
      await client.close();
      await dropDatabase(config);
    },
  };
}

async function createDatabaseOnly(config: DbConfig): Promise<void> {
  const admin = createClickHouseClient(config, { database: null });
  try {
    await admin.command({
      query: "CREATE DATABASE IF NOT EXISTS {database:Identifier}",
      query_params: { database: config.database },
    });
  } finally {
    await admin.close();
  }
}

export async function dropDatabase(config: DbConfig): Promise<void> {
  const admin = createClickHouseClient(config, { database: null });
  try {
    await admin.command({
      query: "DROP DATABASE IF EXISTS {database:Identifier} SYNC",
      query_params: { database: config.database },
    });
  } finally {
    await admin.close();
  }
}

/**
 * A connection as the read-only Grafana user would make it: the plugin sets only
 * `max_execution_time` per query. NOT `createClickHouseClient`, which sends `async_insert = 0` with
 * every request, a setting that a `readonly = 1` user may not change. Logging is off because tests
 * make queries fail on purpose.
 */
export function createReaderClient(config: DbConfig, username: string, password: string) {
  return createClient({
    url: config.url,
    username,
    password,
    database: config.database,
    log: { level: ClickHouseLogLevel.OFF },
  });
}
