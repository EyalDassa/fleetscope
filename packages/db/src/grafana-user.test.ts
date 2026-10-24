import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ConfigError } from "./config";
import {
  ensureGrafanaUser,
  GrafanaUserError,
  isLocalClickHouseUrl,
  LOCAL_GRAFANA_PASSWORD,
  LOCAL_GRAFANA_USER,
  loadGrafanaUserOptions,
} from "./grafana-user";
import { testPassword } from "./testing";

const GRAFANA_PASSWORD = testPassword();
const OWN_PASSWORD = testPassword();
const SECRET_PASSWORD = testPassword();
const env = {
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "fleetscope",
  CLICKHOUSE_DATABASE: "fleetscope",
  CLICKHOUSE_GRAFANA_USER: "grafana",
  CLICKHOUSE_GRAFANA_PASSWORD: GRAFANA_PASSWORD,
};

describe("loadGrafanaUserOptions", () => {
  it("reads the user, the password and the database", () => {
    expect(loadGrafanaUserOptions(env)).toEqual({
      user: "grafana",
      password: GRAFANA_PASSWORD,
      database: "fleetscope",
    });
  });

  it("refuses the admin user, which would make the admin read-only", () => {
    expect(() => loadGrafanaUserOptions({ ...env, CLICKHOUSE_GRAFANA_USER: "fleetscope" })).toThrow(
      /must not be the admin user/,
    );
    expect(() => loadGrafanaUserOptions({ ...env, CLICKHOUSE_GRAFANA_USER: "default" })).toThrow(
      ConfigError,
    );
  });

  it("refuses a missing user, a short password and an unsafe name", () => {
    const { CLICKHOUSE_GRAFANA_USER: _user, ...withoutUser } = env;
    expect(() =>
      loadGrafanaUserOptions({ ...withoutUser, CLICKHOUSE_URL: "https://x.clickhouse.cloud:8443" }),
    ).toThrow(/CLICKHOUSE_GRAFANA_USER/);
    expect(() => loadGrafanaUserOptions({ ...env, CLICKHOUSE_GRAFANA_PASSWORD: "short" })).toThrow(
      /at least 8/,
    );
    expect(() =>
      loadGrafanaUserOptions({ ...env, CLICKHOUSE_GRAFANA_USER: "graf ana; DROP USER x" }),
    ).toThrow(/plain identifier/);
  });

  it("does not put the password into the error message", () => {
    try {
      loadGrafanaUserOptions({
        ...env,
        CLICKHOUSE_GRAFANA_USER: "bad name",
        CLICKHOUSE_GRAFANA_PASSWORD: SECRET_PASSWORD,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET_PASSWORD);
    }
  });
});

describe("the development defaults", () => {
  const { CLICKHOUSE_GRAFANA_USER: _u, CLICKHOUSE_GRAFANA_PASSWORD: _p, ...bare } = env;

  it("match docker-compose and .env.example", () => {
    expect([LOCAL_GRAFANA_USER, LOCAL_GRAFANA_PASSWORD]).toEqual([
      "grafana_ro",
      "grafana_ro_dev_password",
    ]);
  });

  it.each([
    "http://localhost:8123",
    "http://127.0.0.1:8123",
    "http://127.1.2.3:8123",
    "http://[::1]:8123",
    "https://clickhouse.localhost:8443",
  ])("are used when ClickHouse is local (%s)", (url) => {
    expect(loadGrafanaUserOptions({ ...bare, CLICKHOUSE_URL: url })).toEqual({
      user: "grafana_ro",
      password: "grafana_ro_dev_password",
      database: "fleetscope",
    });
  });

  it("fill in only what is missing, and treat an empty value as missing", () => {
    expect(
      loadGrafanaUserOptions({
        ...bare,
        CLICKHOUSE_GRAFANA_USER: "reader",
        CLICKHOUSE_GRAFANA_PASSWORD: "",
      }),
    ).toMatchObject({ user: "reader", password: "grafana_ro_dev_password" });
    expect(
      loadGrafanaUserOptions({ ...bare, CLICKHOUSE_GRAFANA_PASSWORD: OWN_PASSWORD }),
    ).toMatchObject({
      user: "grafana_ro",
      password: OWN_PASSWORD,
    });
  });

  it.each([
    "https://abc123.eu-west-1.aws.clickhouse.cloud:8443",
    "http://clickhouse:8123",
    "http://10.0.0.5:8123",
    "http://localhost.evil.example:8123",
    "http://127.0.0.1.evil.example:8123",
    "not a url",
    "",
  ])("are NOT used for a remote ClickHouse (%s)", (url) => {
    expect(() => loadGrafanaUserOptions({ ...bare, CLICKHOUSE_URL: url })).toThrow(
      /must be set explicitly/,
    );
    expect(() =>
      loadGrafanaUserOptions({
        ...bare,
        CLICKHOUSE_URL: url,
        CLICKHOUSE_GRAFANA_USER: "grafana_ro",
      }),
    ).toThrow(/must be set explicitly/);
    expect(() =>
      loadGrafanaUserOptions({
        ...bare,
        CLICKHOUSE_URL: url,
        CLICKHOUSE_GRAFANA_PASSWORD: GRAFANA_PASSWORD,
      }),
    ).toThrow(/must be set explicitly/);
  });

  it("are not used when CLICKHOUSE_URL is not set at all", () => {
    const { CLICKHOUSE_URL: _url, ...noUrl } = bare;
    expect(() => loadGrafanaUserOptions(noUrl)).toThrow(/must be set explicitly/);
  });

  it("refuse the development password for a remote ClickHouse, even when it is set on purpose", () => {
    expect(() =>
      loadGrafanaUserOptions({
        ...bare,
        CLICKHOUSE_URL: "https://abc123.clickhouse.cloud:8443",
        CLICKHOUSE_GRAFANA_USER: "grafana_ro",
        CLICKHOUSE_GRAFANA_PASSWORD: "grafana_ro_dev_password",
      }),
    ).toThrow(/development password/);
  });

  it("accept explicit values for a remote ClickHouse", () => {
    expect(
      loadGrafanaUserOptions({
        ...bare,
        CLICKHOUSE_URL: "https://abc123.clickhouse.cloud:8443",
        CLICKHOUSE_GRAFANA_USER: "grafana_ro",
        CLICKHOUSE_GRAFANA_PASSWORD: GRAFANA_PASSWORD,
      }),
    ).toEqual({ user: "grafana_ro", password: GRAFANA_PASSWORD, database: "fleetscope" });
  });

  it("isLocalClickHouseUrl is false for nothing at all", () => {
    expect(isLocalClickHouseUrl(undefined)).toBe(false);
  });

  it("still refuse the admin user's own name, defaults or not", () => {
    expect(() => loadGrafanaUserOptions({ ...bare, CLICKHOUSE_USER: "grafana_ro" })).toThrow(
      /must not be the admin user/,
    );
  });
});

describe("ensureGrafanaUser", () => {
  function fakeAdmin(fail?: (query: string) => Error | undefined) {
    const calls: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const client = {
      command: async (call: { query: string; query_params?: Record<string, unknown> }) => {
        calls.push(call);
        const error = fail?.(call.query);
        if (error) throw error;
      },
    } as unknown as ClickHouseClient;
    return { client, calls };
  }
  const options = { user: "grafana", password: SECRET_PASSWORD, database: "fleetscope" };

  it("creates, updates and grants, with the password only as a query parameter", async () => {
    const { client, calls } = fakeAdmin();
    await ensureGrafanaUser(client, options);

    expect(calls.map((c) => c.query.split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "CREATE USER IF",
      "ALTER USER {user:Identifier}",
      "GRANT SELECT ON",
      "GRANT SELECT ON",
      "GRANT SELECT ON",
    ]);
    for (const call of calls) expect(call.query).not.toContain(SECRET_PASSWORD);
    expect(calls[0]?.query_params).toMatchObject({
      user: "grafana",
      password: SECRET_PASSWORD,
    });
    // read-only from the moment it exists, and only the settings the plugin needs are changeable
    for (const call of calls.slice(0, 2)) {
      expect(call.query).toContain("readonly = 1");
      // pinned, so a server default cannot change what the dashboard SQL means
      expect(call.query).toContain("join_use_nulls = 0");
      expect(call.query).toContain("aggregate_functions_null_for_empty = 0");
      expect(call.query).toContain("max_execution_time = 60 MAX 300 CHANGEABLE_IN_READONLY");
    }
    // the database, then exactly the two system tables of the Capacity dashboard, nothing more
    expect(calls.slice(2).map((c) => c.query)).toEqual([
      "GRANT SELECT ON `fleetscope`.* TO `grafana`",
      "GRANT SELECT ON system.`asynchronous_metric_log` TO `grafana`",
      "GRANT SELECT ON system.`part_log` TO `grafana`",
    ]);
    for (const call of calls) expect(call.query).not.toMatch(/REMOTE|ON \*\.\*|WITH GRANT/i);
  });

  it("refuses a name that is not a plain identifier before sending anything", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      ensureGrafanaUser(client, { ...options, database: "x`; DROP DATABASE y; --" }),
    ).rejects.toThrow(/plain identifier/);
    await expect(ensureGrafanaUser(client, { ...options, user: "a b" })).rejects.toThrow(
      /plain identifier/,
    );
    expect(calls).toEqual([]);
  });

  it("reports a failure without the password, even if the server echoes it", async () => {
    const { client } = fakeAdmin((query) =>
      query.startsWith("ALTER") ? new Error(`Syntax error near '${SECRET_PASSWORD}'`) : undefined,
    );
    const failure = await ensureGrafanaUser(client, options).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GrafanaUserError);
    expect((failure as Error).message).toContain("***");
    expect((failure as Error).message).not.toContain(SECRET_PASSWORD);
    expect((failure as Error).cause).toBeUndefined();
  });
});
