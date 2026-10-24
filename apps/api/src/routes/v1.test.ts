import http from "node:http";
import type { SessionTimeline, TimelineSession } from "@fleetscope/db";
import { ChromeTrace } from "@fleetscope/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";

const START = Date.UTC(2026, 9, 24, 10, 0, 0);

const session: TimelineSession = {
  session_id: "sess-1",
  agent_id: "agent-1",
  source: "real",
  engine: "lightpanda",
  engine_version: null,
  provider: "local-docker",
  scenario: "checkout-form",
  region: "local",
  startup_ms: 300,
  connect_ms: 40,
  routed_from: null,
  status: "failed",
  started_at_ms: START,
  ended_at_ms: START + 2000,
  duration_ms: 2000,
  reason: "selector not found",
};

const timeline: SessionTimeline = {
  session,
  actions: [
    {
      seq: 0,
      ts_ms: START + 10,
      action_type: "goto",
      target: "demo.test",
      duration_ms: 100,
      ok: true,
      error_code: null,
    },
    {
      seq: 1,
      ts_ms: START + 200,
      action_type: "click",
      target: "#pay",
      duration_ms: 1500,
      ok: false,
      error_code: "selector_not_found",
    },
  ],
  samples: [{ ts_ms: START + 500, origin: "container", cpu_pct: 20, mem_mb: 64, js_heap_mb: null }],
  requests: [],
  issues: [],
  truncated: [],
};

const apps: ReturnType<typeof buildApp>[] = [];
function app(deps: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const instance = buildApp({
    logLevel: false,
    ping: async () => true,
    getSessionTimeline: async (id) => (id === "sess-1" ? timeline : null),
    getSession: async (id) => (id === "sess-1" ? session : null),
    ...deps,
  });
  apps.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("GET /v1/sessions/:id/trace", () => {
  it("returns the Chrome trace for a known session", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/sessions/sess-1/trace" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    const trace = ChromeTrace.parse(res.json());
    expect(trace.displayTimeUnit).toBe("ms");
    expect(trace.metadata).toMatchObject({ session_id: "sess-1", display_status: "failed" });
    const slices = trace.traceEvents.filter((e) => e.ph === "X").map((e) => e.name);
    expect(slices).toEqual(["goto demo.test", "✕ click #pay"]);
  });

  it("returns 404 with a JSON error for an unknown session", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/sessions/nope/trace" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session not found" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("passes the id from the URL, decoded, to the query", async () => {
    const getSessionTimeline = vi.fn(async () => null);
    await app({ getSessionTimeline }).inject({
      method: "GET",
      url: "/v1/sessions/agent%40host%3A1/trace", // percent-encoded @ and :, both allowed in an id
    });
    expect(getSessionTimeline).toHaveBeenCalledWith("agent@host:1");
  });

  it("accepts an id of 128 characters (the longest the schema allows) and refuses one of 129", async () => {
    const getSessionTimeline = vi.fn(async () => null);
    const instance = app({ getSessionTimeline });
    const ok = await instance.inject({
      method: "GET",
      url: `/v1/sessions/${"a".repeat(128)}/trace`,
    });
    expect(ok.statusCode).toBe(404); // reached the query, which found nothing
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
    const tooLong = await instance.inject({
      method: "GET",
      url: `/v1/sessions/${"a".repeat(129)}/trace`,
    });
    expect(tooLong.statusCode).toBe(400);
    expect(getSessionTimeline).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for an id with a lone surrogate, without querying", async () => {
    const getSessionTimeline = vi.fn(async () => null);
    const res = await app({ getSessionTimeline }).inject({
      method: "GET",
      url: "/v1/sessions/%ED%A0%80/trace", // percent-encoded UTF-8 of U+D800 (invalid UTF-8)
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(getSessionTimeline).not.toHaveBeenCalled();
  });

  it.each([
    ["the trace", "trace"],
    ["the Perfetto page", "perfetto"],
  ])(
    "answers 400, without querying, when the ids . and .. reach %s (no browser sends them, a raw client can)",
    async (_name, route) => {
      const getSessionTimeline = vi.fn(async () => null);
      const getSession = vi.fn(async () => null);
      const instance = app({ getSessionTimeline, getSession });
      // app.inject() parses the URL and resolves ./ and ../ (and %2E) before routing, as a browser does,
      // so these go over a real socket with the path exactly as written.
      await instance.listen({ port: 0, host: "127.0.0.1" });
      const port = (instance.server.address() as { port: number }).port;
      const status = (path: string) =>
        new Promise<number>((resolve, reject) => {
          http
            .get({ host: "127.0.0.1", port, path }, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            })
            .on("error", reject);
        });
      for (const path of [
        `/v1/sessions/../${route}`,
        `/v1/sessions/./${route}`,
        `/v1/sessions/%2E%2E/${route}`,
        `/v1/sessions/%2E/${route}`,
      ]) {
        expect(await status(path), path).toBe(400);
      }
      expect(getSessionTimeline).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
    },
  );

  it("returns 500 without details when the query fails", async () => {
    const res = await app({
      getSessionTimeline: async () => {
        throw new Error("Code: 241. DB::Exception: Memory limit (for query) exceeded");
      },
    }).inject({ method: "GET", url: "/v1/sessions/sess-1/trace" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
  });

  it("is not registered when the app has no timeline query", async () => {
    const res = await app({ getSessionTimeline: undefined }).inject({
      method: "GET",
      url: "/v1/sessions/sess-1/trace",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/sessions/:id/perfetto", () => {
  const get = (url: string, instance = app()) => instance.inject({ method: "GET", url });

  it("returns an HTML page with the session, the button, the download link and the handshake", async () => {
    const res = await get("/v1/sessions/sess-1/perfetto");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    const page = res.body;
    expect(page).toContain("sess-1");
    expect(page).toContain("failed (selector not found)");
    expect(page).toContain("lightpanda");
    expect(page).toContain(">Open in Perfetto</button>");
    expect(page).toContain('href="./trace" download="fleetscope-sess-1.json"');
    // the deep-linking handshake from the Perfetto docs
    expect(page).toContain("window.open(PERFETTO)");
    expect(page).toContain('"https://ui.perfetto.dev"');
    expect(page).toContain("'PING'");
    expect(page).toContain("'PONG'");
    expect(page).toContain("fetch('./trace'");
    expect(page).toContain("perfetto: { buffer: buffer, title:");
  });

  it("loads nothing from outside: no external scripts, styles, images or frames", async () => {
    const page = (await get("/v1/sessions/sess-1/perfetto")).body;
    expect(page).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/<img\b/i);
    expect(page).not.toMatch(/<iframe\b/i);
    // the only URL in the page is the Perfetto origin the script opens
    const urls = page.match(/https?:\/\/[^\s'"<>)]+/g) ?? [];
    expect([...new Set(urls)]).toEqual(["https://ui.perfetto.dev"]);
  });

  it("locks the page down with a Content-Security-Policy that allows only its own script by hash", async () => {
    const res = await get("/v1/sessions/sess-1/perfetto");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // not "same-origin": that would stop the page from talking to the window it opens
    expect(res.headers["cross-origin-opener-policy"]).toBeUndefined();
    // the hash in the header matches the script in the body
    const script = /<script>([\s\S]*?)<\/script>/.exec(res.body)?.[1] ?? "";
    const { createHash } = await import("node:crypto");
    expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);
  });

  it("escapes everything that comes from the session", async () => {
    // the id is a safe label (see SessionId), so the hostile text has to come from the other fields
    const hostile: TimelineSession = {
      ...session,
      engine: `x"><script>alert(1)</script>`,
      engine_version: `<b>1</b>`,
      scenario: `<img src=x onerror=alert(1)>`,
      reason: `'; alert(2); '`,
    };
    const res = await get("/v1/sessions/sess-1/perfetto", app({ getSession: async () => hostile }));
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain("<script>alert(1)");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("<b>1</b>");
    expect(body).toContain("x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // the only <script> element is ours
    expect(body.match(/<script\b/g)).toHaveLength(1);
  });

  it("returns a 404 page for an unknown session", async () => {
    const res = await get("/v1/sessions/nope@host/perfetto");
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("Session not found");
    expect(res.body).toContain("nope@host");
    expect(res.body).not.toContain("Open in Perfetto");
  });

  it("answers a hostile id with a 400 page that does not repeat it, without querying", async () => {
    const getSession = vi.fn(async () => null);
    const res = await get(
      `/v1/sessions/${encodeURIComponent("<b>nope</b>' OR 1=1 --")}/perfetto`,
      app({ getSession }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Bad session id");
    expect(res.body).not.toContain("nope");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("returns a 400 page for an invalid id", async () => {
    const res = await get(`/v1/sessions/${"a".repeat(129)}/perfetto`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Bad session id");
  });

  it("returns a 500 page without details when the query fails", async () => {
    const res = await get(
      "/v1/sessions/sess-1/perfetto",
      app({
        getSession: async () => {
          throw new Error("Code: 60. secret table name");
        },
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("Something went wrong");
    expect(res.body).not.toContain("secret table name");
  });

  it("shows a simulated session as SIM", async () => {
    const res = await get(
      "/v1/sessions/sess-1/perfetto",
      app({ getSession: async () => ({ ...session, source: "sim" }) }),
    );
    expect(res.body).toContain("SIM (simulated)");
  });
});
