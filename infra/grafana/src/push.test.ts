import { describe, expect, it } from "vitest";
import type { Fetch } from "./clickhouse-http";
import type { DashboardFile } from "./dashboards";
import type { JsonObject } from "./json";
import {
  buildDataSource,
  GrafanaClient,
  PushError,
  parseClickHouseUrl,
  parseGrafanaUrl,
  pushToGrafana,
  withApiUrl,
} from "./push";
import { dashboardJson } from "./test-fixtures";

const TOKEN = "glsa_super_secret_token_value";
const PASSWORD = "ro-password-123";
const env = {
  CLICKHOUSE_URL: "https://abc.eu-central-1.aws.clickhouse.cloud:8443",
  CLICKHOUSE_GRAFANA_USER: "grafana_ro",
  CLICKHOUSE_GRAFANA_PASSWORD: PASSWORD,
  CLICKHOUSE_DATABASE: "fleetscope",
};

// ---------------------------------------------------------------- a small in-memory Grafana

interface FakeState {
  folders: Map<string, JsonObject>;
  sources: Map<string, JsonObject>;
  dashboards: Map<string, JsonObject>;
  dashboardFolders: Map<string, unknown>;
  prefs: JsonObject;
  /** "METHOD /path" of every request, in order. */
  calls: string[];
  authHeaders: Set<string>;
  allowPreferences: boolean;
  healthy: boolean;
}

function fakeGrafana(): { fetchImpl: Fetch; state: FakeState } {
  const state: FakeState = {
    folders: new Map(),
    sources: new Map(),
    dashboards: new Map(),
    dashboardFolders: new Map(),
    prefs: { theme: "" },
    calls: [],
    authHeaders: new Set(),
    allowPreferences: true,
    healthy: true,
  };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    state.calls.push(`${method} ${path}`);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth) state.authHeaders.add(auth);
    const body = init?.body ? (JSON.parse(String(init.body)) as JsonObject) : undefined;
    const notFound = json(404, { message: "not found" });

    // The first capture group of `pattern`, when the path matches it.
    const at = (pattern: RegExp): string | undefined => pattern.exec(path)?.[1];

    const folderUid = at(/^\/api\/folders\/([^/]+)$/);
    if (folderUid) {
      const folder = state.folders.get(folderUid);
      if (method === "GET") return folder ? json(200, folder) : notFound;
      if (method === "PUT" && folder) {
        state.folders.set(folderUid, { ...folder, title: body?.title });
        return json(200, state.folders.get(folderUid));
      }
    }
    if (path === "/api/folders" && method === "POST" && body) {
      state.folders.set(String(body.uid), { uid: body.uid, title: body.title });
      return json(200, state.folders.get(String(body.uid)));
    }
    if (at(/^\/api\/datasources\/uid\/([^/]+)\/health$/)) {
      return state.healthy
        ? json(200, { status: "OK", message: "Data source is working" })
        : json(400, { status: "ERROR", message: "connection refused" });
    }
    const sourceUid = at(/^\/api\/datasources\/uid\/([^/]+)$/);
    if (sourceUid) {
      const source = state.sources.get(sourceUid);
      if (method === "GET")
        return source ? json(200, { ...source, secureJsonData: undefined }) : notFound;
      if (method === "PUT" && body) {
        state.sources.set(sourceUid, body);
        return json(200, { message: "Datasource updated" });
      }
    }
    if (path === "/api/datasources" && method === "POST" && body) {
      state.sources.set(String(body.uid), body);
      return json(200, { message: "Datasource added" });
    }
    const dashboardUid = at(/^\/api\/dashboards\/uid\/([^/]+)$/);
    if (dashboardUid) {
      const dashboard = state.dashboards.get(dashboardUid);
      return dashboard
        ? json(200, { dashboard: { ...dashboard, id: 5, version: 3 }, meta: {} })
        : notFound;
    }
    if (path === "/api/dashboards/db" && method === "POST" && body) {
      const dashboard = body.dashboard as JsonObject;
      state.dashboards.set(String(dashboard.uid), dashboard);
      state.dashboardFolders.set(String(dashboard.uid), body.folderUid);
      return json(200, { status: "success", uid: dashboard.uid });
    }
    if (path === "/api/search") {
      return json(
        200,
        [...state.dashboards.keys()].map((uid) => ({ uid })),
      );
    }
    if (path === "/api/org/preferences") {
      if (method === "GET") return json(200, state.prefs);
      if (method === "PATCH") {
        if (!state.allowPreferences)
          return json(403, { message: "Permissions needed: orgs.preferences:write" });
        state.prefs = { ...state.prefs, ...body };
        return json(200, { message: "Preferences updated" });
      }
    }
    return json(500, { message: `fake Grafana has no route for ${method} ${path}` });
  }) as unknown as Fetch;

  return { fetchImpl, state };
}

function dashboardFile(name: string, json: JsonObject): DashboardFile {
  return { file: name, path: name, json, parseError: undefined };
}

const sessionDashboard = dashboardJson({
  uid: "fleetscope-session",
  title: "Fleetscope / Session",
  templating: {
    list: [
      { name: "api_url", type: "constant", query: "http://localhost:4000", hide: 2 },
      { name: "session", type: "textbox", query: "" },
    ],
  },
});
const overviewDashboard = dashboardJson({
  uid: "fleetscope-overview",
  title: "Fleetscope / Overview",
});

function setup(overrides: Partial<Parameters<typeof pushToGrafana>[0]> = {}) {
  const grafana = fakeGrafana();
  const lines: string[] = [];
  const options = {
    client: new GrafanaClient("https://stack.grafana.net", TOKEN, grafana.fetchImpl),
    dataSource: buildDataSource(env, false),
    dashboardFiles: [
      dashboardFile("fleetscope-overview.json", overviewDashboard),
      dashboardFile("fleetscope-session.json", sessionDashboard),
    ],
    apiUrl: "https://api.fleetscope.example",
    grafanaIsLocal: false,
    dryRun: false,
    canRead: true,
    skipHealthCheck: false,
    log: (line: string) => lines.push(line),
    ...overrides,
  };
  return { ...grafana, lines, options };
}

// ---------------------------------------------------------------- tests

describe("pushToGrafana", () => {
  it("creates the folder, the data source, the dashboards and the theme", async () => {
    const { state, options, lines } = setup();
    const result = await pushToGrafana(options);

    expect(result.folder).toBe("created");
    expect(result.dataSource).toBe("created");
    expect(result.dashboards).toEqual([
      { uid: "fleetscope-overview", action: "created" },
      { uid: "fleetscope-session", action: "created" },
    ]);
    expect(result.theme).toBe("updated");
    expect(result.health).toEqual({ ok: true, message: "Data source is working" });

    expect(state.folders.get("fleetscope")).toEqual({ uid: "fleetscope", title: "Fleetscope" });
    const source = state.sources.get("fleetscope-clickhouse") as JsonObject;
    expect(source.type).toBe("grafana-clickhouse-datasource");
    expect(source.jsonData).toEqual({
      host: "abc.eu-central-1.aws.clickhouse.cloud",
      port: 8443,
      protocol: "http",
      secure: true,
      username: "grafana_ro",
      defaultDatabase: "fleetscope",
    });
    expect(source.secureJsonData).toEqual({ password: PASSWORD });
    const session = state.dashboards.get("fleetscope-session") as JsonObject;
    expect(session.id).toBeNull();
    expect(state.dashboardFolders.get("fleetscope-session")).toBe("fleetscope");
    expect(state.prefs.theme).toBe("dark");
    expect([...state.authHeaders]).toEqual([`Bearer ${TOKEN}`]);
    expect(lines.length).toBeGreaterThan(5);
  });

  it("never prints the token or the ClickHouse password", async () => {
    const { options, lines } = setup();
    await pushToGrafana(options);
    const output = lines.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(PASSWORD);
    expect(output).toContain("password ********");
  });

  it("is idempotent: a second push leaves folder, dashboards and theme unchanged", async () => {
    const { state, options } = setup();
    await pushToGrafana(options);
    state.calls.length = 0;

    const second = await pushToGrafana(options);

    expect(second.folder).toBe("unchanged");
    expect(second.dashboards.map((d) => d.action)).toEqual(["unchanged", "unchanged"]);
    expect(second.theme).toBe("unchanged");
    // The password cannot be read back from Grafana, so the data source is always sent again.
    expect(second.dataSource).toBe("updated");
    const writes = state.calls.filter((call) => !call.startsWith("GET"));
    expect(writes).toEqual(["PUT /api/datasources/uid/fleetscope-clickhouse"]);
  });

  it("updates a dashboard whose JSON changed", async () => {
    const { options } = setup();
    await pushToGrafana(options);
    const changed = dashboardJson({
      uid: "fleetscope-overview",
      title: "Fleetscope / Overview",
      refresh: "30s",
    });
    const result = await pushToGrafana({
      ...options,
      dashboardFiles: [dashboardFile("fleetscope-overview.json", changed)],
    });
    expect(result.dashboards).toEqual([{ uid: "fleetscope-overview", action: "updated" }]);
    expect(result.extraDashboards).toEqual(["fleetscope-session"]);
  });

  it("writes FLEETSCOPE_API_URL into the api_url variable and nothing else", async () => {
    const { state, options } = setup();
    await pushToGrafana(options);
    const stored = state.dashboards.get("fleetscope-session") as JsonObject;
    const list = (stored.templating as JsonObject).list as JsonObject[];
    expect(list[0]).toMatchObject({
      name: "api_url",
      query: "https://api.fleetscope.example",
      current: { value: "https://api.fleetscope.example" },
      options: [{ value: "https://api.fleetscope.example", selected: true }],
    });
    expect(list[1]).toEqual({ name: "session", type: "textbox", query: "" });
  });

  // api_url builds the browser-side Perfetto link, so a localhost API is valid while the API runs
  // on the laptop that opens Grafana Cloud. It is a warning, not a refusal.
  it("warns, but still pushes, when a remote Grafana gets a localhost API URL", async () => {
    const { state, options, lines } = setup({ apiUrl: "http://localhost:4000" });
    const result = await pushToGrafana(options);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /http:\/\/localhost:4000.*fleetscope-session\.json.*only work on the machine running the API/,
    );
    expect(lines.filter((line) => line.startsWith("warning"))).toHaveLength(1);
    const stored = state.dashboards.get("fleetscope-session") as JsonObject;
    const list = (stored.templating as JsonObject).list as JsonObject[];
    expect(list[0]).toMatchObject({ name: "api_url", query: "http://localhost:4000" });
  });

  it("does not warn about a localhost API URL for a local Grafana, or without an api_url variable", async () => {
    const local = setup({ apiUrl: "http://localhost:4000", grafanaIsLocal: true });
    expect((await pushToGrafana(local.options)).warnings).toEqual([]);

    const noVariable = setup({
      apiUrl: "http://localhost:4000",
      dashboardFiles: [dashboardFile("fleetscope-overview.json", overviewDashboard)],
    });
    expect((await pushToGrafana(noVariable.options)).warnings).toEqual([]);

    const publicUrl = setup({ apiUrl: "https://api.fleetscope.example" });
    expect((await pushToGrafana(publicUrl.options)).warnings).toEqual([]);
  });

  it("shows the warning in a dry run too", async () => {
    const { options } = setup({ apiUrl: "http://127.0.0.1:4000", dryRun: true });
    expect((await pushToGrafana(options)).warnings).toHaveLength(1);
  });

  it("does not stop when the token may not change the theme, and says what to do", async () => {
    const { state, options, lines } = setup();
    state.allowPreferences = false;
    const result = await pushToGrafana(options);
    expect(result.theme).toBe("not-allowed");
    expect(lines.join("\n")).toMatch(/Administration > Default preferences/);
    expect(result.dashboards).toHaveLength(2);
  });

  it("reports an unhealthy data source", async () => {
    const { state, options, lines } = setup();
    state.healthy = false;
    const result = await pushToGrafana(options);
    expect(result.health?.ok).toBe(false);
    expect(lines.join("\n")).toMatch(/health\s+FAILED: .*connection refused/);
  });

  it("can skip the health check", async () => {
    const { state, options } = setup({ skipHealthCheck: true });
    await pushToGrafana(options);
    expect(state.calls.some((c) => c.endsWith("/health"))).toBe(false);
  });

  it("changes nothing in a dry run, but still reads Grafana to say what would happen", async () => {
    const { state, options, lines } = setup({ dryRun: true });
    const result = await pushToGrafana(options);
    expect(state.calls.every((call) => call.startsWith("GET"))).toBe(true);
    expect(result.folder).toBe("created");
    expect(result.health).toBeUndefined();
    expect(lines.join("\n")).toContain("would be created");
    expect(state.folders.size + state.sources.size + state.dashboards.size).toBe(0);
  });

  it("makes no request at all in a dry run without credentials", async () => {
    const { state, options } = setup({ dryRun: true, canRead: false });
    await pushToGrafana(options);
    expect(state.calls).toEqual([]);
  });

  it("stops before any request when a dashboard file is broken", async () => {
    const { state, options } = setup({
      dashboardFiles: [
        dashboardFile("ok.json", overviewDashboard),
        {
          file: "broken.json",
          path: "broken.json",
          json: undefined,
          parseError: "Unexpected token",
        },
      ],
    });
    await expect(pushToGrafana(options)).rejects.toThrow(/broken\.json: not valid JSON/);
    expect(state.calls).toEqual([]);
  });

  it("explains a Grafana error without leaking the token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "invalid API key" }), {
        status: 401,
      })) as unknown as Fetch;
    const { options } = setup();
    const failing = {
      ...options,
      client: new GrafanaClient("https://stack.grafana.net", TOKEN, fetchImpl),
    };
    const error = (await pushToGrafana(failing).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/HTTP 401: invalid API key/);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("withApiUrl", () => {
  it("returns the same object when there is no api_url variable", () => {
    expect(withApiUrl(overviewDashboard, "https://x")).toBe(overviewDashboard);
  });
});

describe("parseGrafanaUrl", () => {
  it("accepts https and strips the trailing slash", () => {
    expect(parseGrafanaUrl("https://stack.grafana.net/")).toEqual({
      url: "https://stack.grafana.net",
      local: false,
    });
  });
  it("accepts http only for localhost", () => {
    expect(parseGrafanaUrl("http://127.0.0.1:3001")).toEqual({
      url: "http://127.0.0.1:3001",
      local: true,
    });
    expect(() => parseGrafanaUrl("http://stack.grafana.net")).toThrow(/https/);
    expect(() => parseGrafanaUrl("not a url")).toThrow(PushError);
  });
});

describe("parseClickHouseUrl", () => {
  it("reads host, port and TLS", () => {
    expect(parseClickHouseUrl("https://abc.clickhouse.cloud:8443")).toEqual({
      host: "abc.clickhouse.cloud",
      port: 8443,
      secure: true,
      path: undefined,
    });
    expect(parseClickHouseUrl("http://clickhouse:8123")).toMatchObject({
      port: 8123,
      secure: false,
    });
  });
  it("uses the default port of the scheme", () => {
    expect(parseClickHouseUrl("https://abc.clickhouse.cloud").port).toBe(8443);
    expect(parseClickHouseUrl("http://localhost").port).toBe(8123);
  });
  it("keeps a path prefix and rejects other schemes", () => {
    expect(parseClickHouseUrl("https://proxy.example/clickhouse/").path).toBe("/clickhouse");
    expect(() => parseClickHouseUrl("tcp://localhost:9000")).toThrow(/HTTP interface/);
  });
});

describe("buildDataSource", () => {
  it("needs the read-only user and never falls back to the admin user", () => {
    const { CLICKHOUSE_GRAFANA_USER: _u, CLICKHOUSE_GRAFANA_PASSWORD: _p, ...withoutUser } = env;
    expect(() =>
      buildDataSource(
        { ...withoutUser, CLICKHOUSE_USER: "admin", CLICKHOUSE_PASSWORD: "x" },
        false,
      ),
    ).toThrow(/read-only user/);
  });

  it("prefers GRAFANA_CLICKHOUSE_URL, the address as Grafana sees it", () => {
    const source = buildDataSource(
      {
        ...env,
        CLICKHOUSE_URL: "http://localhost:8123",
        GRAFANA_CLICKHOUSE_URL: "http://clickhouse:8123",
      },
      true,
    );
    expect(source.jsonData).toMatchObject({ host: "clickhouse", port: 8123, secure: false });
  });

  it("refuses a localhost ClickHouse for a remote Grafana", () => {
    expect(() =>
      buildDataSource({ ...env, CLICKHOUSE_URL: "http://localhost:8123" }, false),
    ).toThrow(/your own machine/);
    expect(() =>
      buildDataSource({ ...env, CLICKHOUSE_URL: "http://localhost:8123" }, true),
    ).not.toThrow();
  });

  it("defaults the database to fleetscope", () => {
    const { CLICKHOUSE_DATABASE: _d, ...rest } = env;
    expect(buildDataSource(rest, false).jsonData.defaultDatabase).toBe("fleetscope");
  });
});
