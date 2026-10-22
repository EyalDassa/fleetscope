import { createClickHouseClient, loadDbConfig, ping } from "@fleetscope/db";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function appWithClickHouse(url?: string) {
  const config = loadDbConfig();
  const client = createClickHouseClient(url ? { ...config, url } : config);
  const app = buildApp({ logLevel: false, ping: () => ping(client, 1000) });
  closers.push(
    () => app.close(),
    () => client.close(),
  );
  return app;
}

describe("GET /healthz against real ClickHouse", () => {
  it("is 200 when ClickHouse is up", async () => {
    const res = await appWithClickHouse().inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", clickhouse: "ok" });
  });

  it("is 503 quickly when ClickHouse is unreachable", async () => {
    const started = Date.now();
    const res = await appWithClickHouse("http://127.0.0.1:1").inject({
      method: "GET",
      url: "/healthz",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", clickhouse: "down" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("is 503 when the credentials are wrong", async () => {
    const config = loadDbConfig();
    const client = createClickHouseClient({ ...config, password: "definitely-wrong" });
    const app = buildApp({ logLevel: false, ping: () => ping(client, 1000) });
    closers.push(
      () => app.close(),
      () => client.close(),
    );
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
  });
});
