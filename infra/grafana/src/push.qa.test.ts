import { describe, expect, it } from "vitest";
import { buildDataSource, GrafanaApiError, GrafanaClient, parseGrafanaUrl } from "./push";

/**
 * QA M2: the safety rules of `grafana:push`, tried with the addresses people actually type. The
 * flow itself (idempotence, dry run, wrong token) was run against a fresh Grafana 13.2.4 container;
 * see qa/m2-report.md. These tests need neither Docker nor a network.
 */

const env = (url: string): NodeJS.ProcessEnv => ({
  CLICKHOUSE_URL: url,
  CLICKHOUSE_GRAFANA_USER: "grafana_ro",
  CLICKHOUSE_GRAFANA_PASSWORD: "a-real-password",
  CLICKHOUSE_USER: "fleetscope",
  CLICKHOUSE_PASSWORD: "admin-secret",
  CLICKHOUSE_DATABASE: "fleetscope",
});

describe("GRAFANA_URL", () => {
  it("refuses a token over plain http to anything that is not this machine", () => {
    for (const url of [
      "http://stack.grafana.net",
      "http://192.168.1.20:3000",
      "http://localhost.evil.com",
    ]) {
      expect(() => parseGrafanaUrl(url), url).toThrow(/https/);
    }
  });

  it("accepts https anywhere and http on this machine, and drops a trailing slash", () => {
    expect(parseGrafanaUrl("https://stack.grafana.net/")).toEqual({
      url: "https://stack.grafana.net",
      local: false,
    });
    expect(parseGrafanaUrl("http://localhost:3001")).toEqual({
      url: "http://localhost:3001",
      local: true,
    });
    expect(parseGrafanaUrl("http://127.0.0.1:3001").local).toBe(true);
  });

  it("refuses something that is not a URL", () => {
    expect(() => parseGrafanaUrl("stack.grafana.net")).toThrow(/not a URL/);
  });
});

describe("the ClickHouse address for a remote Grafana", () => {
  it("refuses localhost, 127.0.0.1 and ::1: Grafana's server cannot reach your machine", () => {
    for (const url of [
      "http://localhost:8123",
      "http://127.0.0.1:8123",
      "http://[::1]:8123",
      "http://host.docker.internal:8123",
    ]) {
      expect(() => buildDataSource(env(url), false), url).toThrow(/your own machine/);
    }
  });

  it("allows them for a Grafana on this machine", () => {
    expect(buildDataSource(env("http://host.docker.internal:8123"), true).jsonData.host).toBe(
      "host.docker.internal",
    );
  });

  // QA-M2-07: the check is a list of five exact names, so other spellings of "this machine" pass.
  it.fails("also refuses the other loopback spellings: 127.0.0.2, 0.0.0.0 and a trailing dot", () => {
    for (const url of ["http://127.0.0.2:8123", "http://0.0.0.0:8123", "http://localhost.:8123"]) {
      expect(() => buildDataSource(env(url), false), url).toThrow(/your own machine/);
    }
  });

  it("uses the read-only user, never the admin user, and keeps the password out of jsonData", () => {
    const source = buildDataSource(env("https://abc.clickhouse.cloud:8443"), false);
    expect(source.jsonData).toMatchObject({
      host: "abc.clickhouse.cloud",
      port: 8443,
      secure: true,
      username: "grafana_ro",
    });
    expect(JSON.stringify(source.jsonData)).not.toContain("a-real-password");
    expect(JSON.stringify(source)).not.toContain("admin-secret");
    expect(source.secureJsonData).toEqual({ password: "a-real-password" });
  });

  it("refuses to run without the read-only user, even when the admin user is set", () => {
    const withoutUser = {
      ...env("https://abc.clickhouse.cloud:8443"),
      CLICKHOUSE_GRAFANA_USER: undefined,
    };
    expect(() => buildDataSource(withoutUser, false)).toThrow(/read-only user/);
  });
});

describe("errors never carry the token", () => {
  it("a 401 and a network failure name the request, not the Authorization header", async () => {
    const token = "glsa_secret_token_value_1234567890";
    const refused = new GrafanaClient(
      "https://stack.grafana.net",
      token,
      async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
    );
    const error = await refused.get("/api/folders/fleetscope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as Error).message).not.toContain(token);

    const down = new GrafanaClient("https://stack.grafana.net", token, async () => {
      throw new Error("getaddrinfo ENOTFOUND stack.grafana.net");
    });
    const unreachable = await down.get("/api/health").catch((e: unknown) => e);
    expect((unreachable as Error).message).toMatch(/cannot reach Grafana/);
    expect((unreachable as Error).message).not.toContain(token);
  });
});
