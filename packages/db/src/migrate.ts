import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ClickHouseClient, createClickHouseClient } from "./client";
import type { DbConfig } from "./config";
import type { Logger } from "./logger";

/** Where the plain SQL migrations live (repo root /infra/clickhouse). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../infra/clickhouse/", import.meta.url),
);

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LEDGER = "schema_migrations";

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** Read `NNNN_name.sql` files in order. A badly named .sql file is an error. */
export async function loadMigrationFiles(dir = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const numbers = new Set<string>();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = FILE_NAME.exec(name);
    if (!match) {
      throw new MigrationError(`Bad migration file name "${name}" (expected 0001_some_name.sql)`);
    }
    const number = match[1] as string;
    if (numbers.has(number)) {
      throw new MigrationError(`Two migrations share the number ${number}`);
    }
    numbers.add(number);
    const sql = await readFile(`${dir}/${name}`, "utf8");
    files.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return files;
}

/**
 * ClickHouse's HTTP interface runs one statement per request, so a file with several statements
 * is split on ";". Line comments (--) are removed first. Limitation: a ";" or "--" inside a
 * string literal is not supported in migrations.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export interface MigrateOptions {
  dir?: string;
  logger?: Logger;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply pending migrations in order. Safe to run many times, but NOT safe to run from several
 * processes at once.
 *
 * ClickHouse has no advisory locks or transactional DDL, so this runner cannot lock. Rules:
 * - Run migrations from exactly one place: a single CI/deploy step, or `pnpm db:migrate` by hand.
 *   Never on API startup, where several replicas could race.
 * - Every statement should be idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), or each
 *   file should hold a single statement, because a file that fails halfway re-runs from its first
 *   statement on the next attempt.
 * - As a cheap guard, the ledger is re-read right before each file is applied, which narrows the
 *   race window from the whole run to one file. It does not close it.
 *
 * What it does:
 * - Creates the database and the `schema_migrations` ledger if needed.
 * - Skips migrations already in the ledger, but throws if an applied file was edited or removed
 *   (history must not change; add a new migration instead).
 * - Stops at the first failing statement and throws; that file is not recorded in the ledger.
 */
export async function runMigrations(
  config: DbConfig,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const files = await loadMigrationFiles(options.dir);

  const bootstrap = createClickHouseClient(config, { database: null });
  try {
    await bootstrap.command({
      query: "CREATE DATABASE IF NOT EXISTS {database:Identifier}",
      query_params: { database: config.database },
    });
  } finally {
    await bootstrap.close();
  }

  const client = createClickHouseClient(config);
  try {
    return await applyPending(client, files, options.logger);
  } finally {
    await client.close();
  }
}

async function isRecorded(client: ClickHouseClient, name: string): Promise<boolean> {
  const result = await client.query({
    query: `SELECT count() AS n FROM ${LEDGER} WHERE name = {name:String}`,
    query_params: { name },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ n: string | number }>();
  return Number(row?.n ?? 0) > 0;
}

async function applyPending(
  client: ClickHouseClient,
  files: MigrationFile[],
  logger?: Logger,
): Promise<MigrateResult> {
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${LEDGER}
            (
              name       String,
              checksum   String,
              applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
            )
            ENGINE = MergeTree
            ORDER BY name`,
  });

  const result = await client.query({
    query: `SELECT name, checksum FROM ${LEDGER}`,
    format: "JSONEachRow",
  });
  const ledger = new Map(
    (await result.json<{ name: string; checksum: string }>()).map((row) => [
      row.name,
      row.checksum,
    ]),
  );

  const byName = new Map(files.map((file) => [file.name, file]));
  for (const [name, checksum] of ledger) {
    const file = byName.get(name);
    if (!file) {
      throw new MigrationError(`Migration ${name} was applied before but its file is missing`);
    }
    if (file.checksum !== checksum) {
      throw new MigrationError(
        `Migration ${name} was edited after it was applied. Add a new migration instead.`,
      );
    }
  }

  const outcome: MigrateResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    if (ledger.has(file.name) || (await isRecorded(client, file.name))) {
      outcome.alreadyApplied.push(file.name);
      continue;
    }
    try {
      for (const statement of splitStatements(file.sql)) {
        await client.command({ query: statement });
      }
    } catch (error) {
      throw new MigrationError(`Migration ${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    await client.insert({
      table: LEDGER,
      values: [{ name: file.name, checksum: file.checksum }],
      format: "JSONEachRow",
    });
    outcome.applied.push(file.name);
    logger?.info({ migration: file.name }, "migration applied");
  }
  return outcome;
}
