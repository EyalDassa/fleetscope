import { describe, expect, it } from "vitest";
import { ConnectionConfigError, connectionFromEnv } from "./connection";
import { disallowedSettings, sqlRuleProblems } from "./design-rules";
import { LOCAL_GRAFANA_PASSWORD, LOCAL_GRAFANA_USER } from "./dev-defaults";
import { testPassword } from "./test-fixtures";

// QA-M2-03: the check must run as the read-only Grafana user unless --admin is given on purpose.
describe("connectionFromEnv", () => {
  const adminPassword = testPassword();
  const readOnlyPassword = testPassword();
  const admin = { CLICKHOUSE_USER: "fleetscope", CLICKHOUSE_PASSWORD: adminPassword };

  it("uses the configured read-only user", () => {
    const { connection, description } = connectionFromEnv(
      {
        ...admin,
        CLICKHOUSE_URL: "https://abc.clickhouse.cloud:8443",
        CLICKHOUSE_GRAFANA_USER: "grafana_ro",
        CLICKHOUSE_GRAFANA_PASSWORD: readOnlyPassword,
        CLICKHOUSE_DATABASE: "db",
      },
      false,
    );
    expect(connection).toEqual({
      url: "https://abc.clickhouse.cloud:8443",
      user: "grafana_ro",
      password: readOnlyPassword,
      database: "db",
    });
    expect(description).toContain("read-only Grafana user");
    expect(description).not.toContain("development default");
    expect(description).not.toContain(readOnlyPassword);
  });

  it("falls back to the development read-only user for a ClickHouse on this machine, never to the admin", () => {
    for (const url of [undefined, "http://localhost:8123", "http://127.0.0.2:8123"]) {
      const { connection, description } = connectionFromEnv(
        { ...admin, ...(url ? { CLICKHOUSE_URL: url } : {}) },
        false,
      );
      expect(connection.user, String(url)).toBe(LOCAL_GRAFANA_USER);
      expect(connection.password).toBe(LOCAL_GRAFANA_PASSWORD);
      expect(connection.user).not.toBe(admin.CLICKHOUSE_USER);
      expect(description).toContain("development default");
    }
    // dev-defaults.test.ts checks that these are the ones of .env.example
  });

  it("fills in only what is missing for a local ClickHouse", () => {
    const { connection } = connectionFromEnv({ CLICKHOUSE_GRAFANA_USER: "someone" }, false);
    expect(connection).toMatchObject({ user: "someone", password: LOCAL_GRAFANA_PASSWORD });
  });

  it("refuses to guess for a ClickHouse on another machine", () => {
    const remote = { ...admin, CLICKHOUSE_URL: "https://abc.clickhouse.cloud:8443" };
    expect(() => connectionFromEnv(remote, false)).toThrow(ConnectionConfigError);
    expect(() => connectionFromEnv(remote, false)).toThrow(/pass --admin/);
    expect(() =>
      connectionFromEnv({ ...remote, CLICKHOUSE_GRAFANA_USER: "grafana_ro" }, false),
    ).toThrow(/CLICKHOUSE_GRAFANA_PASSWORD/);
  });

  it("uses the admin user only with --admin, and says so", () => {
    const { connection, description } = connectionFromEnv(
      {
        ...admin,
        CLICKHOUSE_GRAFANA_USER: "grafana_ro",
        CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
      },
      true,
    );
    expect(connection).toMatchObject({ user: "fleetscope", password: adminPassword });
    expect(description).toContain("ADMIN");
    expect(description).toContain("--admin");
    expect(description).not.toContain(adminPassword);
  });
});

describe("SETTINGS clauses in dashboard SQL", () => {
  it("allows the two settings the read-only user may change, and nothing else", () => {
    expect(disallowedSettings("SELECT 1 SETTINGS max_execution_time = 30")).toEqual([]);
    expect(
      disallowedSettings("SELECT 1 SETTINGS additional_table_filters = {'t': 'x = 1'}"),
    ).toEqual([]);
    expect(disallowedSettings("SELECT 1 SETTINGS join_use_nulls = 1")).toEqual(["join_use_nulls"]);
    expect(
      disallowedSettings("SELECT 1 SETTINGS max_execution_time = 30, max_threads = 2, final = 1"),
    ).toEqual(["max_threads", "final"]);
    expect(
      disallowedSettings("SELECT * FROM (SELECT 1 SETTINGS enable_x = 1) SETTINGS y = 2"),
    ).toEqual(["enable_x", "y"]);
  });

  it("is not fooled by the word in a string, a comment or a column", () => {
    expect(disallowedSettings("SELECT 'SETTINGS a = 1'")).toEqual([]);
    expect(disallowedSettings("SELECT 1 -- SETTINGS a = 1")).toEqual([]);
    expect(disallowedSettings("SELECT settings FROM t WHERE settings = 1")).toEqual([]);
  });

  it("is reported as a problem on the query", () => {
    const [problem] = sqlRuleProblems("SELECT 1 SETTINGS join_use_nulls = 1", 'panel "P", query A');
    expect(problem?.where).toBe('panel "P", query A');
    expect(problem?.message).toMatch(/SETTINGS clause for join_use_nulls.*read-only Grafana user/);
  });
});
