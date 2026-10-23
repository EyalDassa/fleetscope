import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopbackAddress } from "./loopback";
import { makeApp, type TestApp } from "./testing";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.app.close();
});

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
// A LAN client, a Docker bridge address (what a browser container looks like), a public address,
// IPv6 link-local, and an IPv4-mapped address that is not loopback.
const NOT_LOOPBACK = [
  "192.168.1.50",
  "172.18.240.1",
  "10.0.0.5",
  "8.8.8.8",
  "fe80::1",
  "::ffff:192.168.1.50",
];
const ZERO = { latencyMs: 0, flakyRate: 0, botwallRate: 0, errorRate: 0 };

function call(
  method: "GET" | "POST" | "DELETE",
  remoteAddress: string,
  options: { url?: string; payload?: string; headers?: Record<string, string> } = {},
) {
  return t.app.inject({
    method,
    url: options.url ?? "/admin/chaos",
    remoteAddress,
    payload: options.payload,
    headers: {
      ...(options.payload === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
}

describe("isLoopbackAddress", () => {
  it("accepts exactly the three loopback forms", () => {
    for (const address of LOOPBACK) expect(isLoopbackAddress(address), address).toBe(true);
  });

  it("refuses everything else, including a missing address", () => {
    for (const address of [...NOT_LOOPBACK, "", "localhost", "0.0.0.0", "::"]) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("/admin/* only answers callers on loopback", () => {
  it.each(LOOPBACK)("serves GET, POST and DELETE to %s", async (address) => {
    expect((await call("GET", address)).json()).toEqual(ZERO);

    const set = await call("POST", address, { payload: JSON.stringify({ errorRate: 0.4 }) });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ ...ZERO, errorRate: 0.4 });

    const reset = await call("DELETE", address);
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual(ZERO);
  });

  it.each(NOT_LOOPBACK)("answers 403 with a clear message to %s", async (address) => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await call(method, address, {
        payload: method === "POST" ? JSON.stringify({ errorRate: 1 }) : undefined,
      });
      expect(res.statusCode, `${method} from ${address}`).toBe(403);
      expect(res.json()).toEqual({
        error: "forbidden",
        message: "The admin API only accepts requests from the machine the demo site runs on.",
      });
    }
  });

  it("changes nothing when a remote caller tries to set or reset", async () => {
    await call("POST", "127.0.0.1", { payload: JSON.stringify({ latencyMs: 250 }) });
    await call("POST", "192.168.1.50", { payload: JSON.stringify({ errorRate: 1 }) });
    await call("DELETE", "192.168.1.50");
    expect((await call("GET", "127.0.0.1")).json()).toEqual({ ...ZERO, latencyMs: 250 });
  });

  it("checks the address before the body: a remote caller gets 403, not 400", async () => {
    const badJson = await call("POST", "192.168.1.50", { payload: "{oops" });
    expect(badJson.statusCode).toBe(403);
    const badValue = await call("POST", "192.168.1.50", {
      payload: JSON.stringify({ errorRate: 9 }),
    });
    expect(badValue.statusCode).toBe(403);
    // A loopback caller with the same body still gets the validation error.
    const local = await call("POST", "127.0.0.1", { payload: JSON.stringify({ errorRate: 9 }) });
    expect(local.statusCode).toBe(400);
  });

  it("is not fooled by headers the caller controls", async () => {
    const headers = {
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
      forwarded: "for=127.0.0.1",
      host: "localhost:3100",
    };
    const res = await call("GET", "192.168.1.50", { headers });
    expect(res.statusCode).toBe(403);
  });

  it("is not fooled by another spelling of the path", async () => {
    // Fastify decodes the path before routing, so this reaches the same handler.
    const decoded = await call("GET", "127.0.0.1", { url: "/%61dmin/chaos" });
    expect(decoded.statusCode).toBe(200);
    const remote = await call("GET", "192.168.1.50", { url: "/%61dmin/chaos" });
    expect(remote.statusCode).toBe(403);
    const withQuery = await call("GET", "192.168.1.50", { url: "/admin/chaos?x=1" });
    expect(withQuery.statusCode).toBe(403);
  });
});

describe("remote callers still get everything else", () => {
  const container = "172.18.0.5";

  it("serves pages, images and health checks to a browser container", async () => {
    for (const url of ["/", "/login", "/healthz", "/img/1.svg", "/heavy?nodes=5&images=1"]) {
      const res = await t.app.inject({ method: "GET", url, remoteAddress: container });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("applies chaos that was set from the host to the container's page requests", async () => {
    await call("POST", "127.0.0.1", { payload: JSON.stringify({ errorRate: 1 }) });
    const page = await t.app.inject({ method: "GET", url: "/login", remoteAddress: container });
    expect(page.statusCode).toBe(500);
    // The container still cannot read or change the settings itself.
    expect((await call("GET", container)).statusCode).toBe(403);
    // Health checks stay unaffected.
    const health = await t.app.inject({ method: "GET", url: "/healthz", remoteAddress: container });
    expect(health.statusCode).toBe(200);
  });
});
