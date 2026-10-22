import { ConfigError } from "@fleetscope/db";
import { SCHEMA_VERSION } from "@fleetscope/schema";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";

const apps: ReturnType<typeof buildApp>[] = [];
function app(deps: Parameters<typeof buildApp>[0]) {
  const instance = buildApp({ logLevel: false, ...deps });
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("GET /healthz", () => {
  it("returns 200 when ClickHouse answers", async () => {
    const res = await app({ ping: async () => true }).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", clickhouse: "ok", schemaVersion: SCHEMA_VERSION });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns 503 when the ping says down", async () => {
    const res = await app({ ping: async () => false }).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", clickhouse: "down" });
  });

  it("returns 503 when the ping throws", async () => {
    const res = await app({
      ping: async () => {
        throw new Error("connection refused");
      },
    }).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 when the ping is too slow", async () => {
    const started = Date.now();
    const res = await app({
      ping: () => new Promise<boolean>(() => {}),
      healthTimeoutMs: 50,
    }).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("/v1", () => {
  it("is registered but has no routes yet", async () => {
    const res = await app({ ping: async () => true }).inject({
      method: "GET",
      url: "/v1/anything",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("loadApiEnv", () => {
  const valid = {
    CLICKHOUSE_URL: "http://localhost:8123",
    CLICKHOUSE_USER: "fleetscope",
    CLICKHOUSE_PASSWORD: "secret",
    CLICKHOUSE_DATABASE: "fleetscope",
  };

  it("applies defaults for port, host and log level", () => {
    expect(loadApiEnv(valid)).toMatchObject({
      API_PORT: 4000,
      API_HOST: "127.0.0.1",
      LOG_LEVEL: "info",
    });
  });

  it("reads API_PORT as a number", () => {
    expect(loadApiEnv({ ...valid, API_PORT: "4100" }).API_PORT).toBe(4100);
  });

  it("fails fast with a message naming each bad variable", () => {
    expect(() => loadApiEnv({ API_PORT: "abc", LOG_LEVEL: "loud" })).toThrow(ConfigError);
    try {
      loadApiEnv({ API_PORT: "abc", LOG_LEVEL: "loud" });
    } catch (error) {
      const message = (error as Error).message;
      for (const name of ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "API_PORT", "LOG_LEVEL"]) {
        expect(message).toContain(name);
      }
    }
  });
});
