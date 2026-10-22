import type { AddressInfo } from "node:net";
import { createClickHouseClient, loadDbConfig, ping } from "@fleetscope/db";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/** QA integration cases for the API against the real ClickHouse from `pnpm infra:up`. */

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function start(overrides: Partial<ReturnType<typeof loadDbConfig>> = {}) {
  const client = createClickHouseClient({ ...loadDbConfig(), ...overrides });
  const app = buildApp({ logLevel: false, ping: () => ping(client, 1000) });
  closers.push(
    () => app.close(),
    () => client.close(),
  );
  return app;
}

describe("/healthz over real HTTP with real ClickHouse", () => {
  it("returns 200 on GET and HEAD with no-store, and a fast answer", async () => {
    const app = start();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    const t0 = performance.now();
    const get = await fetch(`http://127.0.0.1:${port}/healthz`);
    const took = performance.now() - t0;
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.json()).toEqual({ status: "ok", clickhouse: "ok", schemaVersion: 1 });
    expect(took).toBeLessThan(1000);

    const head = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("stays healthy across 100 sequential probes (no leaked sockets or growing latency)", async () => {
    const app = start();
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("is healthy even if the configured database does not exist yet (ping is SELECT 1)", async () => {
    // Recorded behaviour (QA-M0-11, nit): /healthz proves the server and credentials work, not
    // that the database exists or that migrations ran, yet it reports schemaVersion 1.
    const app = start({ database: "fleetscope_does_not_exist" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("is 503 for an unknown user and for a refused port, both quickly and without details", async () => {
    for (const override of [{ username: "nobody" }, { url: "http://127.0.0.1:1" }]) {
      const t0 = Date.now();
      const res = await start(override).inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "degraded", clickhouse: "down" });
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });
});
