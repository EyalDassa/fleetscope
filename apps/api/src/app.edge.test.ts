import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createClickHouseClient, loadDbConfig, ping } from "@fleetscope/db";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";

/**
 * QA edge cases for the API (M0). No Docker needed: ClickHouse is replaced by fake sockets.
 * The ClickHouse client in these tests is the real one from @fleetscope/db, so we exercise the
 * real ping() timeout, not just the route.
 */

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track<T extends { close: () => Promise<unknown> }>(thing: T): T {
  cleanups.push(() => thing.close());
  return thing;
}

const baseEnv = {
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "fleetscope",
  CLICKHOUSE_PASSWORD: "secret",
  CLICKHOUSE_DATABASE: "fleetscope",
};

/** A TCP server that accepts connections and never answers: a hung ClickHouse. */
async function blackhole(): Promise<{ url: string; server: TcpServer }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** An HTTP server that answers every request after `delayMs` (slow ClickHouse). */
async function slowClickHouse(delayMs: number): Promise<string> {
  const server: Server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("1\n");
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function appWithRealPing(url: string, timeoutMs = 1000) {
  const config = { ...loadDbConfig(baseEnv), url };
  const client = createClickHouseClient(config);
  cleanups.push(() => client.close());
  const app = buildApp({ logLevel: false, ping: () => ping(client, timeoutMs) });
  track(app);
  return app;
}

describe("GET /healthz with a hung or slow ClickHouse", () => {
  it("answers 503 within ~1 s when ClickHouse accepts the connection but never replies", async () => {
    const { url } = await blackhole();
    const started = Date.now();
    const res = await appWithRealPing(url).inject({ method: "GET", url: "/healthz" });
    const took = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", clickhouse: "down" });
    expect(took).toBeLessThan(2000);
  });

  it("answers 503 when ClickHouse replies, but slower than the health timeout", async () => {
    const url = await slowClickHouse(3000);
    const started = Date.now();
    const res = await appWithRealPing(url, 300).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("answers 200 when ClickHouse is slow but inside the timeout", async () => {
    const url = await slowClickHouse(150);
    const res = await appWithRealPing(url, 1000).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("does not pile up: 50 parallel probes against a hung ClickHouse all finish in ~1 s", async () => {
    const { url } = await blackhole();
    const app = appWithRealPing(url);
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => app.inject({ method: "GET", url: "/healthz" })),
    );
    expect(responses.every((r) => r.statusCode === 503)).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("enforces its own timeout even if the injected ping ignores its timeout (default 1 s)", async () => {
    const app = track(buildApp({ logLevel: false, ping: () => new Promise<boolean>(() => {}) }));
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    const took = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(2000);
  });

  it("recovers by itself: 503 first, 200 on the next probe once ClickHouse answers", async () => {
    let healthy = false;
    const app = track(buildApp({ logLevel: false, ping: async () => healthy }));
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(503);
    healthy = true;
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("a ping that resolves true only after the timeout does not turn the answer into 200", async () => {
    const app = track(
      buildApp({
        logLevel: false,
        healthTimeoutMs: 30,
        ping: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 250)); // late resolve must not blow up
  });

  it("never leaks the underlying error in the 503 body", async () => {
    const app = track(
      buildApp({
        logLevel: false,
        ping: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:8123 password=hunter2");
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("ECONNREFUSED");
  });

  it("treats a non-Error rejection as down", async () => {
    const app = track(
      buildApp({ logLevel: false, ping: () => Promise.reject("string rejection") }),
    );
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(503);
  });
});

describe("routing", () => {
  const up = () => track(buildApp({ logLevel: false, ping: async () => true }));
  const down = () => track(buildApp({ logLevel: false, ping: async () => false }));

  it("HEAD /healthz has the same status as GET and no body (up and down)", async () => {
    const ok = await up().inject({ method: "HEAD", url: "/healthz" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("");
    const bad = await down().inject({ method: "HEAD", url: "/healthz" });
    expect(bad.statusCode).toBe(503);
    expect(bad.body).toBe("");
    expect(bad.headers["cache-control"]).toBe("no-store");
  });

  it("sends no-store on both outcomes so a CDN never caches a health answer", async () => {
    expect((await up().inject({ method: "GET", url: "/healthz" })).headers["cache-control"]).toBe(
      "no-store",
    );
    expect((await down().inject({ method: "GET", url: "/healthz" })).headers["cache-control"]).toBe(
      "no-store",
    );
  });

  it("returns JSON 404 for unknown routes, wrong methods and the bare /v1 prefix", async () => {
    const app = up();
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/nope"],
      ["POST", "/healthz"],
      ["DELETE", "/healthz"],
      ["GET", "/v1"],
      ["GET", "/v1/"],
      ["POST", "/v1/events"], // ingest is M1: must be a clean 404 until then
      ["GET", "/v2/anything"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.headers["content-type"], `${method} ${url}`).toContain("application/json");
    }
  });

  it("is case-sensitive and strict about the trailing slash (recorded behaviour)", async () => {
    const app = up();
    expect((await app.inject({ method: "GET", url: "/HEALTHZ" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz?x=1" })).statusCode).toBe(200);
  });

  it("does not crash on odd inputs", async () => {
    const app = up();
    const odd = await app.inject({ method: "GET", url: "/healthz?%E0%A4%A" });
    expect([200, 400]).toContain(odd.statusCode);
    const huge = await app.inject({ method: "GET", url: `/${"a".repeat(10_000)}` });
    expect(huge.statusCode).toBe(404);
    const body = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect([200, 400]).toContain(body.statusCode);
  });

  it("serves real HTTP, not just inject: status, headers and body arrive on the wire", async () => {
    const app = up();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok", clickhouse: "ok", schemaVersion: 1 });
    const head = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });
});

describe("loadApiEnv: edge cases", () => {
  it.each([
    ["API_PORT 0", { API_PORT: "0" }],
    ["API_PORT 65536", { API_PORT: "65536" }],
    ["API_PORT negative", { API_PORT: "-1" }],
    ["API_PORT a float", { API_PORT: "40.5" }],
    ["API_PORT text", { API_PORT: "four thousand" }],
    ["API_PORT empty", { API_PORT: "" }],
    ["API_HOST empty", { API_HOST: "" }],
    ["LOG_LEVEL empty", { LOG_LEVEL: "" }],
    ["LOG_LEVEL wrong case", { LOG_LEVEL: "INFO" }],
    ["CLICKHOUSE_URL with a space", { CLICKHOUSE_URL: "http://local host:8123" }],
    ["CLICKHOUSE_URL empty", { CLICKHOUSE_URL: "" }],
    ["CLICKHOUSE_USER empty", { CLICKHOUSE_USER: "" }],
    ["CLICKHOUSE_DATABASE with a dash", { CLICKHOUSE_DATABASE: "fleet-scope" }],
    ["CLICKHOUSE_DATABASE starting with a digit", { CLICKHOUSE_DATABASE: "1fleet" }],
    ["CLICKHOUSE_DATABASE with a quote", { CLICKHOUSE_DATABASE: "a`; DROP DATABASE x; --" }],
    ["CLICKHOUSE_DATABASE empty", { CLICKHOUSE_DATABASE: "" }],
  ])("rejects %s", (_name, patch) => {
    expect(() => loadApiEnv({ ...baseEnv, ...patch })).toThrow(/Invalid environment/);
  });

  it("accepts the boundaries and an empty password (passwordless dev ClickHouse)", () => {
    expect(loadApiEnv({ ...baseEnv, API_PORT: "1" }).API_PORT).toBe(1);
    expect(loadApiEnv({ ...baseEnv, API_PORT: "65535" }).API_PORT).toBe(65535);
    expect(loadApiEnv({ ...baseEnv, CLICKHOUSE_PASSWORD: "" }).CLICKHOUSE_PASSWORD).toBe("");
    expect(loadApiEnv({ ...baseEnv, API_HOST: "0.0.0.0" }).API_HOST).toBe("0.0.0.0");
    expect(loadApiEnv({ ...baseEnv, LOG_LEVEL: "silent" }).LOG_LEVEL).toBe("silent");
  });

  it("does not echo the password in the error message", () => {
    try {
      loadApiEnv({ ...baseEnv, CLICKHOUSE_PASSWORD: "hunter2-secret", API_PORT: "nope" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2-secret");
    }
  });

  it("names the variable when only one is missing", () => {
    const { CLICKHOUSE_URL: _url, ...rest } = baseEnv;
    expect(() => loadApiEnv(rest)).toThrow(/CLICKHOUSE_URL/);
  });

  // QA-M0-10 (nit): z.url() accepts any scheme, so a typo such as CLICKHOUSE_URL=localhost:8123
  // is read as scheme "localhost" and a non-http URL only fails later, at the first query.
  it("accepts a non-http CLICKHOUSE_URL (recorded: the failure comes late, at the first query)", () => {
    expect(() => loadApiEnv({ ...baseEnv, CLICKHOUSE_URL: "localhost:8123" })).not.toThrow();
    expect(() => loadApiEnv({ ...baseEnv, CLICKHOUSE_URL: "ftp://example.com" })).not.toThrow();
  });
});
