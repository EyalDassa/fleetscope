import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, ClickHouseError } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { createReaderClient, createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
const user = `fleetscope_grafana_test_${randomBytes(4).toString("hex")}`;
const password = "first-test-password";
const readers: ClickHouseClient[] = [];

function readerClient(pass = password): ClickHouseClient {
  const client = createReaderClient(db.config, user, pass);
  readers.push(client);
  return client;
}

/** The ClickHouse error code of a refused statement, or "ok" when it ran. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return error instanceof ClickHouseError ? `${error.type}` : String(error);
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
});

afterAll(async () => {
  await Promise.all(readers.map((r) => r.close()));
  await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("the read-only Grafana user", () => {
  it("can read every table of the database, the rollup and the pricing view", async () => {
    const reader = readerClient();
    for (const table of ["sessions", "actions", "fleet_minute", "pricing", "pricing_current"]) {
      const result = await reader.query({
        query: "SELECT count() AS n FROM {table:Identifier}",
        query_params: { table },
        format: "JSONEachRow",
      });
      expect(await result.json(), table).toHaveLength(1);
    }
    const prices = await reader.query({
      query: "SELECT count() AS n FROM pricing_current",
      format: "JSONEachRow",
    });
    expect(Number(((await prices.json()) as Array<{ n: number | string }>)[0]?.n)).toBe(3);
  });

  it("is refused INSERT, ALTER, DROP, TRUNCATE, DELETE and CREATE", async () => {
    const reader = readerClient();
    const attempts: Record<string, () => Promise<unknown>> = {
      insert: () =>
        reader.command({
          query:
            "INSERT INTO issues (event_id, ts, session_id, kind, message) VALUES (generateUUIDv4(), now(), 'x', 'crash', 'x')",
        }),
      alter: () => reader.command({ query: "ALTER TABLE actions ADD COLUMN hacked UInt8" }),
      drop: () => reader.command({ query: "DROP TABLE sessions" }),
      truncate: () => reader.command({ query: "TRUNCATE TABLE fleet_minute" }),
      delete: () => reader.command({ query: "DELETE FROM sessions WHERE 1" }),
      create: () => reader.command({ query: "CREATE TABLE hacked (x UInt8) ENGINE = Memory" }),
      dropView: () => reader.command({ query: "DROP VIEW pricing_current" }),
    };
    const results: Record<string, string> = {};
    for (const [name, run] of Object.entries(attempts)) results[name] = await outcome(run);
    // The grants (ACCESS_DENIED) already stop a user that only has SELECT; the next test proves
    // that readonly = 1 stops one that was given too much.
    for (const [name, result] of Object.entries(results)) {
      expect(["READONLY", "ACCESS_DENIED"], name).toContain(result);
    }

    // and the data is all still there, seen by the admin
    const tables = await db.client.query({
      query:
        "SELECT count() AS n FROM system.tables WHERE database = currentDatabase() AND name IN ('sessions', 'actions', 'fleet_minute', 'pricing_current')",
      format: "JSONEachRow",
    });
    expect(Number(((await tables.json()) as Array<{ n: number | string }>)[0]?.n)).toBe(4);
  });

  it("stays read-only even if someone grants it every privilege (readonly = 1 is the second layer)", async () => {
    const wide = `${user}_wide`;
    await ensureGrafanaUser(db.client, { user: wide, password, database: db.config.database });
    try {
      await db.client.command({
        query: `GRANT INSERT, ALTER, DROP, TRUNCATE, CREATE TABLE, CREATE VIEW ON \`${db.config.database}\`.* TO \`${wide}\``,
      });
      const reader = createReaderClient(db.config, wide, password);
      readers.push(reader);
      const attempts = [
        "INSERT INTO issues (event_id, ts, session_id, kind, message) VALUES (generateUUIDv4(), now(), 'x', 'crash', 'x')",
        "ALTER TABLE actions ADD COLUMN hacked UInt8",
        "DROP TABLE sessions",
        "TRUNCATE TABLE fleet_minute",
        "CREATE TABLE hacked (x UInt8) ENGINE = Memory",
      ];
      for (const query of attempts) {
        expect(await outcome(() => reader.command({ query })), query).toBe("READONLY");
      }
    } finally {
      await db.client.command({ query: `DROP USER IF EXISTS \`${wide}\`` });
    }
  });

  it("has the settings the dashboard SQL depends on pinned, and cannot change them", async () => {
    const reader = readerClient();
    const result = await reader.query({
      query:
        "SELECT getSetting('join_use_nulls') AS join_use_nulls, getSetting('aggregate_functions_null_for_empty') AS null_for_empty, getSetting('readonly') AS readonly",
      format: "JSONEachRow",
    });
    const [row] = await result.json<Record<string, number | string>>();
    expect(Object.values(row ?? {}).map(Number)).toEqual([0, 0, 1]);

    // a panel cannot flip them either
    for (const setting of ["join_use_nulls = 1", "aggregate_functions_null_for_empty = 1"]) {
      expect(
        await outcome(() =>
          reader
            .query({ query: `SELECT 1 SETTINGS ${setting}`, format: "JSONEachRow" })
            .then((r) => r.json()),
        ),
        setting,
      ).toBe("READONLY");
    }
  });

  it("pins them again when the user's settings were changed by hand (a run of the script repairs it)", async () => {
    const drifted = `${user}_drift`;
    await ensureGrafanaUser(db.client, { user: drifted, password, database: db.config.database });
    try {
      await db.client.command({
        query: `ALTER USER \`${drifted}\` SETTINGS readonly = 1, join_use_nulls = 1, aggregate_functions_null_for_empty = 1`,
      });
      const read = async () => {
        const reader = createReaderClient(db.config, drifted, password);
        readers.push(reader);
        const result = await reader.query({
          query:
            "SELECT getSetting('join_use_nulls') AS a, getSetting('aggregate_functions_null_for_empty') AS b",
          format: "JSONEachRow",
        });
        return Object.values((await result.json<Record<string, number>>())[0] ?? {}).map(Number);
      };
      expect(await read()).toEqual([1, 1]);
      await ensureGrafanaUser(db.client, { user: drifted, password, database: db.config.database });
      expect(await read()).toEqual([0, 0]);
    } finally {
      await db.client.command({ query: `DROP USER IF EXISTS \`${drifted}\`` });
    }
  });

  it("may change max_execution_time (within the limit) and no other setting", async () => {
    const reader = readerClient();
    const run = (settings: string) =>
      outcome(() =>
        reader
          .query({ query: `SELECT 1 SETTINGS ${settings}`, format: "JSONEachRow" })
          .then((r) => r.json()),
      );
    expect(await run("max_execution_time = 30")).toBe("ok");
    expect(await run("max_execution_time = 301")).toBe("SETTING_CONSTRAINT_VIOLATION");
    expect(await run("max_memory_usage = 1000000000000")).toBe("READONLY");
    expect(await run("join_use_nulls = 1")).toBe("READONLY");
    expect(await run("readonly = 0")).toBe("READONLY");
  });

  it("cannot see users or other databases", async () => {
    const reader = readerClient();
    expect(
      await outcome(() =>
        reader
          .query({ query: "SELECT * FROM system.users", format: "JSONEachRow" })
          .then((r) => r.json()),
      ),
    ).toBe("ACCESS_DENIED");
    expect(
      await outcome(() =>
        reader
          .query({
            query: "SELECT count() FROM fleetscope_never_there.sessions",
            format: "JSONEachRow",
          })
          .then((r) => r.json()),
      ),
    ).not.toBe("ok");
  });

  it("is safe to run again, and running it again with a new password rotates it", async () => {
    await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
    expect(
      await outcome(() => readerClient().query({ query: "SELECT 1", format: "JSONEachRow" })),
    ).toBe("ok");

    await ensureGrafanaUser(db.client, {
      user,
      password: "second-test-password",
      database: db.config.database,
    });
    expect(
      await outcome(() =>
        readerClient(password).query({ query: "SELECT 1", format: "JSONEachRow" }),
      ),
    ).toBe("AUTHENTICATION_FAILED");
    const rotated = readerClient("second-test-password");
    expect(await outcome(() => rotated.query({ query: "SELECT 1", format: "JSONEachRow" }))).toBe(
      "ok",
    );
    // still cannot write after the update
    expect(await outcome(() => rotated.command({ query: "DROP TABLE sessions" }))).not.toBe("ok");
  });

  it("keeps a clear error when the admin may not manage users", async () => {
    const unprivileged = readerClient("second-test-password");
    await expect(
      ensureGrafanaUser(unprivileged, {
        user: `${user}_other`,
        password: "whatever-password",
        database: db.config.database,
      }),
    ).rejects.toThrow(/could not set up the Grafana user/);
  });
});
