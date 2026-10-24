import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { createReaderClient, createTestDatabase, type TestDatabase } from "./testing";

/**
 * QA M2: the read-only Grafana user, from the outside. The backend's own test checks the grants and
 * `readonly = 1`; this one tries what a person who can edit a panel (or a visitor who finds an
 * injection) would try, one statement at a time, with the same client settings the plugin uses.
 */

let db: TestDatabase;
let other: TestDatabase;
let admin: ClickHouseClient;
let reader: ReturnType<typeof createReaderClient>;
const user = `fleetscope_ro_qa_${randomBytes(4).toString("hex")}`;
const password = "qa-readonly-password";

beforeAll(async () => {
  db = await createTestDatabase();
  other = await createTestDatabase();
  admin = db.client;
  await ensureGrafanaUser(admin, { user, password, database: db.config.database });
  reader = createReaderClient(db.config, user, password);
});

afterAll(async () => {
  await reader.close();
  await admin.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await other.cleanup();
  await db.cleanup();
});

const attempt = (query: string, settings: Record<string, string | number> = {}) =>
  reader
    .query({ query, format: "JSONEachRow", clickhouse_settings: settings })
    .then((r) => r.text());
const command = (query: string) => reader.command({ query });

describe("the read-only Grafana user", () => {
  it("can read every table and view the dashboards use, including the pricing view", async () => {
    for (const table of [
      "sessions",
      "actions",
      "resource_samples",
      "network_requests",
      "issues",
      "fleet_minute",
      "pricing",
      "pricing_current",
    ]) {
      await expect(attempt(`SELECT count() FROM ${table}`), table).resolves.toBeTypeOf("string");
    }
    const prices = await attempt(
      "SELECT engine, usd_per_browser_hour FROM pricing_current ORDER BY engine",
    );
    expect(prices).toContain("chromium");
    // the plugin sets max_execution_time on every query
    await expect(attempt("SELECT 1", { max_execution_time: 10 })).resolves.toContain("1");
  });

  it("refuses INSERT into every table, even the rollup and the price list", async () => {
    for (const table of [
      "sessions",
      "actions",
      "resource_samples",
      "network_requests",
      "issues",
      "fleet_minute",
      "pricing",
    ]) {
      await expect(
        command(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 0`),
        table,
      ).rejects.toThrow(/readonly|Not enough privileges|ACCESS_DENIED/i);
    }
    await expect(
      command(
        "INSERT INTO pricing (engine, provider, usd_per_browser_hour, source_url, note, effective_from) VALUES ('chromium', 'local-docker', 0, '', '', '2030-01-01')",
      ),
    ).rejects.toThrow(/readonly|Not enough privileges/i);
  });

  it("refuses DDL, mutations, user management and TRUNCATE", async () => {
    const statements = [
      "DROP TABLE sessions",
      "TRUNCATE TABLE fleet_minute",
      "ALTER TABLE sessions DELETE WHERE 1",
      "ALTER TABLE sessions UPDATE status = 'success' WHERE 1",
      "DELETE FROM sessions WHERE 1",
      "CREATE TABLE qa_scratch (x UInt8) ENGINE = Memory",
      "CREATE VIEW qa_view AS SELECT 1",
      "DROP VIEW pricing_current",
      "OPTIMIZE TABLE sessions FINAL",
      "RENAME TABLE pricing TO pricing_old",
      `CREATE USER qa_intruder IDENTIFIED BY 'x'`,
      `ALTER USER ${user} SETTINGS readonly = 0`,
      `GRANT ALL ON *.* TO ${user}`,
      "SYSTEM STOP MERGES sessions",
      "KILL QUERY WHERE 1",
    ];
    for (const sql of statements) {
      await expect(command(sql), sql).rejects.toThrow();
    }
    // nothing changed
    expect(
      await admin
        .query({ query: "SELECT count() AS n FROM pricing", format: "JSONEachRow" })
        .then((r) => r.json()),
    ).toEqual([{ n: 3 }]);
  });

  it("refuses to change any setting except the two it needs, and keeps max_execution_time within 300 s", async () => {
    await expect(attempt("SELECT 1 SETTINGS join_use_nulls = 1")).rejects.toThrow(/readonly/i);
    await expect(attempt("SELECT 1 SETTINGS readonly = 0")).rejects.toThrow();
    await expect(attempt("SELECT 1", { max_memory_usage: "100000000000" })).rejects.toThrow(
      /readonly/i,
    );
    await expect(attempt("SELECT 1", { readonly: 0 })).rejects.toThrow();
    await expect(attempt("SELECT 1", { max_execution_time: 301 })).rejects.toThrow(
      /constraint|max/i,
    );
    await expect(attempt("SELECT 1", { max_execution_time: 300 })).resolves.toContain("1");
    await expect(command("SET max_memory_usage = 1")).rejects.toThrow();
  });

  it("cannot read another database, and sees nothing of the other users", async () => {
    await expect(
      attempt(`SELECT count() FROM \`${other.config.database}\`.sessions`),
    ).rejects.toThrow(/Not enough privileges|ACCESS_DENIED/i);
    await expect(attempt("SELECT count() FROM system.users")).rejects.toThrow(
      /Not enough privileges|ACCESS_DENIED/i,
    );
    await expect(attempt("SELECT count() FROM system.query_log")).rejects.toThrow(
      /Not enough privileges|ACCESS_DENIED/i,
    );
    await expect(attempt("SELECT * FROM schema_migrations")).resolves.toBeTypeOf("string"); // same database: allowed, only file names and checksums
  });

  it("has join_use_nulls and aggregate_functions_null_for_empty pinned to 0, and no panel can change them (R-M2-06)", async () => {
    const pinned = await attempt(
      "SELECT getSetting('join_use_nulls') AS j, getSetting('aggregate_functions_null_for_empty') AS a, getSetting('readonly') AS r",
    );
    expect(JSON.parse(pinned)).toEqual({ j: false, a: false, r: 1 });
    // the two things the dashboards rely on: an unmatched LEFT JOIN row is 0 / '' and sum() of nothing is 0
    const joined = await attempt(
      "SELECT b.n AS n, b.s AS s FROM (SELECT 1 AS k) AS a LEFT JOIN (SELECT 2 AS k, toUInt8(7) AS n, 'x' AS s) AS b ON a.k = b.k",
    );
    expect(JSON.parse(joined)).toEqual({ n: 0, s: "" });
    expect(JSON.parse(await attempt("SELECT sum(number) AS s FROM numbers(0)"))).toEqual({ s: 0 });
    for (const setting of ["join_use_nulls", "aggregate_functions_null_for_empty"]) {
      await expect(attempt(`SELECT 1 SETTINGS ${setting} = 1`), setting).rejects.toThrow(
        /readonly/i,
      );
      await expect(attempt("SELECT 1", { [setting]: 1 }), setting).rejects.toThrow(/readonly/i);
    }
  });

  it("cannot reach out of the server or read its files (url, file, remote, s3)", async () => {
    for (const sql of [
      "SELECT * FROM url('http://127.0.0.1:8123/ping', 'LineAsString')",
      "SELECT * FROM file('/etc/passwd', 'LineAsString')",
      "SELECT * FROM remote('127.0.0.1', system.one)",
      "SELECT * FROM s3('http://127.0.0.1/x', 'CSV')",
      "SELECT getMacro('x')",
    ]) {
      await expect(attempt(sql), sql).rejects.toThrow();
    }
  });
});
