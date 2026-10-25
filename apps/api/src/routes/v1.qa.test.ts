import type { SessionTimeline, TimelineSession } from "@fleetscope/db";
import { SessionId } from "@fleetscope/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";

/**
 * QA M2, round 2: the session routes with the ids that Grafana puts into the link
 * `${api_url}/v1/sessions/${session:percentencode}/perfetto` (R-M2: ids are SAFE_LABEL_PATTERN).
 */

const START = Date.UTC(2026, 9, 24, 10, 0, 0);
const sessionOf = (id: string): TimelineSession => ({
  session_id: id,
  agent_id: "a",
  source: "real",
  engine: "chromium",
  engine_version: "1.0",
  provider: "local-docker",
  scenario: "s",
  region: "local",
  startup_ms: 1,
  connect_ms: 1,
  routed_from: null,
  target: "demo",
  site: "demo-site",
  status: "success",
  started_at_ms: START,
  ended_at_ms: START + 1000,
  duration_ms: 1000,
  reason: null,
});
const timelineOf = (id: string): SessionTimeline => ({
  session: sessionOf(id),
  actions: [],
  samples: [],
  requests: [],
  issues: [],
  truncated: [],
});

const apps: ReturnType<typeof buildApp>[] = [];
function app(known: string[]) {
  const instance = buildApp({
    logLevel: false,
    ping: async () => true,
    getSessionTimeline: async (id) => (known.includes(id) ? timelineOf(id) : null),
    getSession: async (id) => (known.includes(id) ? sessionOf(id) : null),
  });
  apps.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("ids outside the safe label pattern", () => {
  /** Path segments exactly as they arrive on the wire. */
  const BAD = [
    "a%20b",
    "a'b",
    "a%22b",
    "a;b",
    "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "a%00b",
    "a%0Ab",
    "%E6%97%A5%E6%9C%AC",
    "a%5Cb",
    "a%25b",
    "a".repeat(129),
  ];

  it("get 400 on both routes, never reach the database, and are never echoed into the page", async () => {
    const getSessionTimeline = vi.fn(async () => null);
    const getSession = vi.fn(async () => null);
    const instance = buildApp({
      logLevel: false,
      ping: async () => true,
      getSessionTimeline,
      getSession,
    });
    apps.push(instance);
    for (const id of BAD) {
      for (const route of ["trace", "perfetto"]) {
        const res = await instance.inject({ method: "GET", url: `/v1/sessions/${id}/${route}` });
        expect(res.statusCode, `${route} ${id.slice(0, 20)}`).toBe(400);
        expect(res.body).not.toContain("<script>alert");
      }
    }
    expect(getSessionTimeline).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("ids at the edge of the pattern, as Grafana writes them into the link", () => {
  it("an id with / : @ + is found when it is percent-encoded, on both routes", async () => {
    const id = "fleet/run:1@host+a-b_c.d";
    const encoded = encodeURIComponent(id); // what ${session:percentencode} gives
    const instance = app([id]);
    const trace = await instance.inject({ method: "GET", url: `/v1/sessions/${encoded}/trace` });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().metadata.session_id).toBe(id);
    const page = await instance.inject({ method: "GET", url: `/v1/sessions/${encoded}/perfetto` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("fleet/run:1@host+a-b_c.d");
  });

  it("a valid id that is unknown gets 404, and a 128 character id works", async () => {
    const long = "a".repeat(128);
    const instance = app([long]);
    expect(
      (await instance.inject({ method: "GET", url: "/v1/sessions/nope/trace" })).statusCode,
    ).toBe(404);
    expect(
      (await instance.inject({ method: "GET", url: `/v1/sessions/${long}/perfetto` })).statusCode,
    ).toBe(200);
  });

  // QA-M2-16 (fixed in round 2): "." and ".." matched the label pattern, but no URL can name them: a
  // browser resolves /v1/sessions/../perfetto (and the %2E%2E spelling) to /v1/perfetto before it
  // sends the request. The schema refuses them as a session id, and the routes answer 400.
  it("is not a session id that no link can reach ('.' and '..')", async () => {
    const instance = app([]);
    for (const id of [".", "..", "%2E", "%2E%2E", "%2e%2e"]) {
      for (const route of ["trace", "perfetto"]) {
        const res = await instance.inject({ method: "GET", url: `/v1/sessions/${id}/${route}` });
        // the URL is normalised before routing (even %2E), so the server sees /v1/sessions/trace: 404.
        // The 400 for these ids is the schema at ingest (next assertions), and what keeps them out.
        expect([400, 404], `${id} ${route}`).toContain(res.statusCode);
      }
    }
    expect(SessionId.safeParse(".").success).toBe(false);
    expect(SessionId.safeParse("..").success).toBe(false);
    // dots inside a longer id are fine
    for (const id of ["...", ".a", "a.", "a..b"]) {
      expect(SessionId.safeParse(id).success, id).toBe(true);
    }
    for (const id of [".", ".."]) {
      const url = new URL(`http://localhost:4000/v1/sessions/${encodeURIComponent(id)}/perfetto`);
      const reachable = url.pathname === `/v1/sessions/${id}/perfetto`;
      // either the link works, or the schema refuses the id at ingest
      expect(reachable || !SessionId.safeParse(id).success, id).toBe(true);
    }
  });
});
