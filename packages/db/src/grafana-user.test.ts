import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ConfigError } from "./config";
import { ensureGrafanaUser, GrafanaUserError, loadGrafanaUserOptions } from "./grafana-user";

const env = {
  CLICKHOUSE_USER: "fleetscope",
  CLICKHOUSE_DATABASE: "fleetscope",
  CLICKHOUSE_GRAFANA_USER: "grafana",
  CLICKHOUSE_GRAFANA_PASSWORD: "a-long-enough-password",
};

describe("loadGrafanaUserOptions", () => {
  it("reads the user, the password and the database", () => {
    expect(loadGrafanaUserOptions(env)).toEqual({
      user: "grafana",
      password: "a-long-enough-password",
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
    expect(() => loadGrafanaUserOptions(withoutUser)).toThrow(/CLICKHOUSE_GRAFANA_USER/);
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
        CLICKHOUSE_GRAFANA_PASSWORD: "hunter2hunter2",
      });
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2hunter2");
    }
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
  const options = { user: "grafana", password: "super-secret-pass", database: "fleetscope" };

  it("creates, updates and grants, with the password only as a query parameter", async () => {
    const { client, calls } = fakeAdmin();
    await ensureGrafanaUser(client, options);

    expect(calls.map((c) => c.query.split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "CREATE USER IF",
      "ALTER USER {user:Identifier}",
      "GRANT SELECT ON",
    ]);
    for (const call of calls) expect(call.query).not.toContain("super-secret-pass");
    expect(calls[0]?.query_params).toMatchObject({
      user: "grafana",
      password: "super-secret-pass",
    });
    // read-only from the moment it exists, and only the settings the plugin needs are changeable
    for (const call of calls.slice(0, 2)) {
      expect(call.query).toContain("readonly = 1");
      expect(call.query).toContain("max_execution_time = 60 MAX 300 CHANGEABLE_IN_READONLY");
    }
    expect(calls[2]?.query).toBe("GRANT SELECT ON `fleetscope`.* TO `grafana`");
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
      query.startsWith("ALTER") ? new Error("Syntax error near 'super-secret-pass'") : undefined,
    );
    const failure = await ensureGrafanaUser(client, options).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GrafanaUserError);
    expect((failure as Error).message).toContain("***");
    expect((failure as Error).message).not.toContain("super-secret-pass");
    expect((failure as Error).cause).toBeUndefined();
  });
});
