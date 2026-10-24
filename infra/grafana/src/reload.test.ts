import { describe, expect, it } from "vitest";
import type { Fetch } from "./clickhouse-http";
import type { DashboardFile } from "./dashboards";
import type { JsonObject } from "./json";
import { GrafanaClient, PushError } from "./push";
import { reloadDashboards } from "./reload";
import { dashboardJson } from "./test-fixtures";

const PASSWORD = "admin-pw-for-test";
const overview = dashboardJson({ uid: "fleetscope-overview", title: "Overview v2" });
const session = dashboardJson({ uid: "fleetscope-session", title: "Session" });

function file(name: string, json: JsonObject): DashboardFile {
  return { file: name, path: name, json, parseError: undefined };
}

/**
 * A fake Grafana. `stored` is what it serves now; a reload copies `onReload` into it, the way
 * provisioning would load the changed files.
 */
function fakeGrafana(options: {
  stored: Record<string, JsonObject>;
  onReload?: Record<string, JsonObject>;
  reloadStatus?: number;
}) {
  const calls: { method: string; path: string; authorization: string | undefined }[] = [];
  const stored = { ...options.stored };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    calls.push({ method, path, authorization: headers.Authorization });
    if (method === "POST" && path === "/api/admin/provisioning/dashboards/reload") {
      if (options.reloadStatus && options.reloadStatus !== 200) {
        return new Response(JSON.stringify({ message: "invalid username or password" }), {
          status: options.reloadStatus,
        });
      }
      Object.assign(stored, options.onReload);
      return new Response(JSON.stringify({ message: "Dashboards config reloaded" }), {
        status: 200,
      });
    }
    const uid = /^\/api\/dashboards\/uid\/(.+)$/.exec(path)?.[1];
    const dashboard = uid ? stored[uid] : undefined;
    if (!dashboard) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({ dashboard: { ...dashboard, id: 7, version: 4 } }), {
      status: 200,
    });
  }) as unknown as Fetch;
  return { fetchImpl, calls };
}

const basic = { user: "admin", password: PASSWORD };
const files = [
  file("fleetscope-overview.json", overview),
  file("fleetscope-session.json", session),
];

describe("reloadDashboards", () => {
  it("reloads with the admin login and reports dashboards that now match their files", async () => {
    const stale = { ...overview, title: "Overview v1" };
    const { fetchImpl, calls } = fakeGrafana({
      stored: { "fleetscope-overview": stale, "fleetscope-session": session },
      onReload: { "fleetscope-overview": overview },
    });
    const lines: string[] = [];
    const result = await reloadDashboards({
      client: new GrafanaClient("http://127.0.0.1:3001", undefined, fetchImpl, basic),
      dashboardFiles: files,
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({
      inSync: ["fleetscope-overview", "fleetscope-session"],
      different: [],
      missing: [],
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/admin/provisioning/dashboards/reload",
    });
    const expected = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
    expect(calls.every((c) => c.authorization === expected)).toBe(true);
    expect(lines.join("\n")).not.toContain(PASSWORD);
  });

  it("says when Grafana still serves other JSON than the file, or lacks the dashboard", async () => {
    const { fetchImpl } = fakeGrafana({
      stored: { "fleetscope-overview": { ...overview, title: "old" } },
    });
    const lines: string[] = [];
    const result = await reloadDashboards({
      client: new GrafanaClient("http://127.0.0.1:3001", undefined, fetchImpl, basic),
      dashboardFiles: files,
      log: (line) => lines.push(line),
    });
    expect(result.different).toEqual(["fleetscope-overview"]);
    expect(result.missing).toEqual(["fleetscope-session"]);
    expect(lines.join("\n")).toMatch(/DIFFERENT\s+fleetscope-overview/);
    expect(lines.join("\n")).toMatch(/MISSING\s+fleetscope-session/);
  });

  it("explains a refused admin login (the password only applies to a new volume)", async () => {
    const { fetchImpl } = fakeGrafana({ stored: {}, reloadStatus: 401 });
    await expect(
      reloadDashboards({
        client: new GrafanaClient("http://127.0.0.1:3001", undefined, fetchImpl, basic),
        dashboardFiles: files,
        log: () => {},
      }),
    ).rejects.toThrow(/GRAFANA_ADMIN_PASSWORD.*first time Grafana starts/);
  });

  it("explains a Grafana that is not running", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as Fetch;
    await expect(
      reloadDashboards({
        client: new GrafanaClient("http://127.0.0.1:3001", undefined, down, basic),
        dashboardFiles: files,
        log: () => {},
      }),
    ).rejects.toThrow(/cannot reach Grafana at http:\/\/127\.0\.0\.1:3001/);
  });

  it("does not call Grafana when a dashboard file is broken", async () => {
    const { fetchImpl, calls } = fakeGrafana({ stored: {} });
    await expect(
      reloadDashboards({
        client: new GrafanaClient("http://127.0.0.1:3001", undefined, fetchImpl, basic),
        dashboardFiles: [
          {
            file: "broken.json",
            path: "broken.json",
            json: undefined,
            parseError: "Unexpected token",
          },
        ],
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(PushError);
    expect(calls).toEqual([]);
  });
});

describe("GrafanaClient authorization", () => {
  it("uses the Bearer token by default and Basic when given the admin login", async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = (async (_url: URL | string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers.Authorization);
      return new Response("{}", { status: 200 });
    }) as unknown as Fetch;
    await new GrafanaClient("https://g.example", "glsa_token", fetchImpl).get("/api/health");
    await new GrafanaClient("https://g.example", undefined, fetchImpl, basic).get("/api/health");
    await new GrafanaClient("https://g.example", undefined, fetchImpl).get("/api/health");
    expect(seen).toEqual([
      "Bearer glsa_token",
      `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`,
      undefined,
    ]);
  });
});
