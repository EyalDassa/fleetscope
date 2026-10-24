// pnpm grafana:push: makes a Grafana (normally Grafana Cloud) match the repository.
//   1. folder "Fleetscope" (uid fleetscope)
//   2. the ClickHouse data source (uid fleetscope-clickhouse), built from the environment
//   3. every dashboards/*.json, into that folder
//   4. the organisation's default theme: dark (DESIGN.md section 2)
// It only reads and writes through Grafana's HTTP API, it can run again and again (it says
// "unchanged" for what is already right), and it never prints the token or the ClickHouse password.
// HTTP API reference: https://grafana.com/docs/grafana/latest/developers/http_api/

import type { Fetch } from "./clickhouse-http";
import {
  CLICKHOUSE_DATASOURCE_UID,
  checkStructure,
  type DashboardFile,
  FOLDER_UID,
} from "./dashboards";
import { isLoopbackHost } from "./hosts";
import { asArray, canonicalJson, isObject, type JsonObject } from "./json";

export const FOLDER_TITLE = "Fleetscope";
export const DATASOURCE_NAME = "Fleetscope ClickHouse";
export const DATASOURCE_TYPE = "grafana-clickhouse-datasource";
/** The constant variable of the session dashboard that holds the API base URL (DESIGN.md 4.1). */
export const API_URL_VARIABLE = "api_url";

export class PushError extends Error {
  override name = "PushError";
}

export class GrafanaApiError extends PushError {
  override name = "GrafanaApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- configuration

/** The Grafana base URL without a trailing slash. A token only travels over HTTPS (or to localhost). */
export function parseGrafanaUrl(raw: string): { url: string; local: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PushError(
      `GRAFANA_URL "${raw}" is not a URL (example: https://your-stack.grafana.net)`,
    );
  }
  const local = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new PushError(
      "GRAFANA_URL must start with https:// (the service account token must not travel in clear text). http:// is accepted for localhost only",
    );
  }
  return { url: raw.replace(/\/+$/, ""), local };
}

export interface ClickHouseTarget {
  host: string;
  port: number;
  secure: boolean;
  /** Only for ClickHouse behind a reverse proxy with a path prefix. */
  path: string | undefined;
}

/** `https://abc.clickhouse.cloud:8443` -> host, port 8443, secure. Default ports: 8123 (http), 8443 (https). */
export function parseClickHouseUrl(raw: string): ClickHouseTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PushError(
      `the ClickHouse URL "${raw}" is not a URL (example: https://abc.clickhouse.cloud:8443)`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PushError(
      `the ClickHouse URL must use the HTTP interface (http:// or https://), got "${parsed.protocol}//"`,
    );
  }
  const secure = parsed.protocol === "https:";
  const path = parsed.pathname === "/" ? undefined : parsed.pathname.replace(/\/+$/, "");
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : secure ? 8443 : 8123,
    secure,
    path,
  };
}

export interface DataSourceSpec {
  uid: string;
  name: string;
  type: string;
  access: "proxy";
  isDefault: boolean;
  jsonData: Record<string, unknown>;
  secureJsonData: { password: string };
}

export function buildDataSource(
  env: NodeJS.ProcessEnv,
  grafanaIsLocal: boolean,
  clickhouseUrlOverride?: string,
): DataSourceSpec {
  const url = clickhouseUrlOverride ?? env.GRAFANA_CLICKHOUSE_URL ?? env.CLICKHOUSE_URL;
  if (!url)
    throw new PushError(
      "set CLICKHOUSE_URL (or GRAFANA_CLICKHOUSE_URL, the URL as Grafana sees it)",
    );
  const user = env.CLICKHOUSE_GRAFANA_USER;
  const password = env.CLICKHOUSE_GRAFANA_PASSWORD;
  if (!user || !password) {
    throw new PushError(
      "set CLICKHOUSE_GRAFANA_USER and CLICKHOUSE_GRAFANA_PASSWORD: the read-only user Grafana connects as. The admin CLICKHOUSE_USER is never used here",
    );
  }
  const target = parseClickHouseUrl(url);
  if (!grafanaIsLocal && isLoopbackHost(target.host)) {
    throw new PushError(
      `ClickHouse host "${target.host}" is your own machine; a remote Grafana cannot reach it. Set GRAFANA_CLICKHOUSE_URL to the public ClickHouse address`,
    );
  }
  return {
    uid: CLICKHOUSE_DATASOURCE_UID,
    name: DATASOURCE_NAME,
    type: DATASOURCE_TYPE,
    access: "proxy",
    isDefault: false,
    jsonData: {
      host: target.host,
      port: target.port,
      protocol: "http",
      secure: target.secure,
      username: user,
      defaultDatabase: env.CLICKHOUSE_DATABASE || "fleetscope",
      ...(target.path ? { path: target.path } : {}),
    },
    secureJsonData: { password },
  };
}

// ---------------------------------------------------------------- Grafana HTTP client

export interface BasicAuth {
  user: string;
  password: string;
}

export class GrafanaClient {
  /**
   * `token` is a service account token (Bearer). `basic` is the admin login, only for the few
   * admin endpoints that refuse tokens, such as the provisioning reload.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
    private readonly basic?: BasicAuth,
  ) {}

  /** Returns undefined for 404, so "does it exist?" is one call. Other errors throw. */
  async get(path: string): Promise<unknown> {
    try {
      return await this.request("GET", path);
    } catch (error) {
      if (error instanceof GrafanaApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async send(method: "POST" | "PUT" | "PATCH", path: string, body: unknown): Promise<unknown> {
    return this.request(method, path, body);
  }

  private authorization(): { Authorization?: string } {
    if (this.basic) {
      const login = Buffer.from(`${this.basic.user}:${this.basic.password}`).toString("base64");
      return { Authorization: `Basic ${login}` };
    }
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...this.authorization(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new PushError(`cannot reach Grafana at ${this.baseUrl}: ${(error as Error).message}`);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const detail =
        isObject(json) && typeof json.message === "string" ? json.message : text.slice(0, 300);
      throw new GrafanaApiError(
        response.status,
        `${method} ${path} -> HTTP ${response.status}: ${detail}`,
      );
    }
    return json;
  }
}

// ---------------------------------------------------------------- the push

export type Action = "created" | "updated" | "unchanged";

export interface PushResult {
  folder: Action;
  dataSource: Action;
  dashboards: { uid: string; action: Action }[];
  /** "dark" was set, was already set, or the token may not change it. */
  theme: Action | "not-allowed";
  /** Dashboards in the Grafana folder that are not in the repository. They are left alone. */
  extraDashboards: string[];
  /** Things worth knowing that did not stop the push (also logged). */
  warnings: string[];
  /** The data source health check, or undefined in a dry run. */
  health: { ok: boolean; message: string } | undefined;
}

export interface PushOptions {
  client: GrafanaClient;
  dataSource: DataSourceSpec;
  dashboardFiles: DashboardFile[];
  /** FLEETSCOPE_API_URL: written into the dashboards' `api_url` variable. */
  apiUrl: string | undefined;
  /** True when Grafana is on this machine, so a localhost API URL needs no warning. */
  grafanaIsLocal: boolean;
  dryRun: boolean;
  /** Without a token a dry run cannot read Grafana, and only prints what it would send. */
  canRead: boolean;
  skipHealthCheck: boolean;
  log: (line: string) => void;
}

/** Writes the API URL into the constant variable `api_url`. Returns the dashboard unchanged if it has none. */
export function withApiUrl(dashboard: JsonObject, apiUrl: string): JsonObject {
  const templating = isObject(dashboard.templating) ? dashboard.templating : undefined;
  const list = asArray(templating?.list);
  const index = list.findIndex(
    (v) => isObject(v) && v.name === API_URL_VARIABLE && v.type === "constant",
  );
  if (!templating || index === -1) return dashboard;
  const variable = list[index] as JsonObject;
  const updated: JsonObject = {
    ...variable,
    query: apiUrl,
    current: { selected: false, text: apiUrl, value: apiUrl },
    options: [{ selected: true, text: apiUrl, value: apiUrl }],
  };
  return {
    ...dashboard,
    templating: { ...templating, list: list.map((v, i) => (i === index ? updated : v)) },
  };
}

/** The dashboard as stored, minus what Grafana assigns itself, for comparing with the repo file. */
export function comparable(dashboard: JsonObject): string {
  const { id: _id, version: _version, ...rest } = dashboard;
  return canonicalJson(rest);
}

export async function pushToGrafana(options: PushOptions): Promise<PushResult> {
  const { client, dataSource, dryRun, canRead, log } = options;
  const would = dryRun ? "would be " : "";
  const read = !dryRun || canRead;

  // The files must be sound before anything is sent.
  const structure = checkStructure(options.dashboardFiles);
  const broken = [...structure.problems.entries()].flatMap(([file, problems]) =>
    problems.map((p) => `${file}: ${p.message}`),
  );
  if (broken.length > 0) {
    throw new PushError(
      `fix the dashboard files first (pnpm grafana:check):\n  ${broken.join("\n  ")}`,
    );
  }

  // Build every dashboard body before the first write, so a problem found now leaves Grafana
  // untouched instead of half updated.
  const apiUrl = options.apiUrl;
  const filesWithApiUrl: string[] = [];
  const prepared = structure.dashboards.map((dashboard) => {
    let body = { ...dashboard.json, id: null } as JsonObject;
    if (apiUrl !== undefined) {
      const withUrl = withApiUrl(body, apiUrl);
      if (withUrl !== body) {
        filesWithApiUrl.push(dashboard.file);
        body = withUrl;
      }
    }
    return { dashboard, body };
  });

  // api_url only builds the "Open timeline in Perfetto" link, which the viewer's BROWSER opens (not
  // Grafana's server). So a localhost API is right while the API runs on the laptop that also
  // opens Grafana; it is just worth saying out loud. A localhost ClickHouse is different: the
  // data source is queried by Grafana's server, so that one is refused in buildDataSource.
  const warnings: string[] = [];
  if (
    apiUrl !== undefined &&
    filesWithApiUrl.length > 0 &&
    !options.grafanaIsLocal &&
    isLoopbackHost(safeHostname(apiUrl))
  ) {
    warnings.push(
      `FLEETSCOPE_API_URL is ${apiUrl}: the Perfetto links (${filesWithApiUrl.join(", ")}) will only work on the machine running the API`,
    );
  }
  for (const warning of warnings) log(`warning     ${warning}`);

  // 1. Folder
  let folder: Action = "created";
  const existingFolder = read ? await client.get(`/api/folders/${FOLDER_UID}`) : undefined;
  if (isObject(existingFolder)) {
    folder = existingFolder.title === FOLDER_TITLE ? "unchanged" : "updated";
    if (folder === "updated" && !dryRun) {
      await client.send("PUT", `/api/folders/${FOLDER_UID}`, {
        title: FOLDER_TITLE,
        overwrite: true,
      });
    }
  } else if (!dryRun) {
    await client.send("POST", "/api/folders", { uid: FOLDER_UID, title: FOLDER_TITLE });
  }
  log(`folder      ${FOLDER_UID} ("${FOLDER_TITLE}")  ${would}${folder}`);

  // 2. Data source. Grafana never returns the password, so it is always sent again.
  const existingSource = read
    ? await client.get(`/api/datasources/uid/${dataSource.uid}`)
    : undefined;
  const sourceAction: Action = isObject(existingSource) ? "updated" : "created";
  if (!dryRun) {
    if (sourceAction === "updated") {
      await client.send("PUT", `/api/datasources/uid/${dataSource.uid}`, dataSource);
    } else {
      await client.send("POST", "/api/datasources", dataSource);
    }
  }
  const shown = dataSource.jsonData;
  log(
    `data source ${dataSource.uid}  ${would}${sourceAction}  ` +
      `(${String(shown.secure ? "https" : "http")}://${String(shown.host)}:${String(shown.port)}, ` +
      `database ${String(shown.defaultDatabase)}, user ${String(shown.username)}, password ********)`,
  );

  // 3. Dashboards
  const results: PushResult["dashboards"] = [];
  const pushedUids = new Set<string>();
  for (const { dashboard, body } of prepared) {
    const remote = read ? await client.get(`/api/dashboards/uid/${dashboard.uid}`) : undefined;
    const remoteDashboard =
      isObject(remote) && isObject(remote.dashboard) ? remote.dashboard : undefined;
    let action: Action = "created";
    if (remoteDashboard) {
      action = comparable(remoteDashboard) === comparable(body) ? "unchanged" : "updated";
    }
    if (action !== "unchanged" && !dryRun) {
      await client.send("POST", "/api/dashboards/db", {
        dashboard: body,
        folderUid: FOLDER_UID,
        overwrite: true,
        message: "grafana:push",
      });
    }
    pushedUids.add(dashboard.uid);
    results.push({ uid: dashboard.uid, action });
    log(`dashboard   ${dashboard.uid}  ${would}${action}  (${dashboard.file})`);
  }

  // Dashboards that exist in the folder but not in the repo are reported, never deleted.
  let extraDashboards: string[] = [];
  if (read) {
    const found = await client.get(`/api/search?type=dash-db&folderUIDs=${FOLDER_UID}`);
    extraDashboards = asArray(found)
      .filter(isObject)
      .map((d) => String(d.uid))
      .filter((uid) => !pushedUids.has(uid));
    for (const uid of extraDashboards) {
      log(
        `note        dashboard ${uid} is in the Grafana folder but not in the repository; left alone`,
      );
    }
  }

  // 4. Dark theme as the organisation default
  let theme: PushResult["theme"] = "updated";
  if (read) {
    const preferences = await client.get("/api/org/preferences");
    if (isObject(preferences) && preferences.theme === "dark") theme = "unchanged";
  }
  if (theme === "updated" && !dryRun) {
    try {
      await client.send("PATCH", "/api/org/preferences", { theme: "dark" });
    } catch (error) {
      if (error instanceof GrafanaApiError && (error.status === 403 || error.status === 401)) {
        theme = "not-allowed";
      } else {
        throw error;
      }
    }
  }
  if (theme === "not-allowed") {
    log(
      "theme       could not be set with this token. Set it by hand: Administration > Default preferences > Interface theme = Dark",
    );
  } else {
    log(`theme       organisation default dark  ${would}${theme}`);
  }

  // 5. Does the data source work? Last, so a failure does not hide the uploads above.
  let health: PushResult["health"];
  if (!dryRun && !options.skipHealthCheck) {
    health = await checkHealth(client, dataSource.uid);
    log(`health      ${health.ok ? "OK" : "FAILED"}: ${health.message}`);
  }

  return {
    folder,
    dataSource: sourceAction,
    dashboards: results,
    theme,
    extraDashboards,
    warnings,
    health,
  };
}

async function checkHealth(
  client: GrafanaClient,
  uid: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const answer = await client.get(`/api/datasources/uid/${uid}/health`);
    if (isObject(answer)) {
      return {
        ok: answer.status === "OK",
        message: String(answer.message ?? answer.status ?? "no message"),
      };
    }
    return { ok: false, message: "Grafana returned no health answer" };
  } catch (error) {
    // Grafana answers 4xx/5xx with {status: "ERROR", message}; GrafanaApiError carries that text.
    return { ok: false, message: (error as Error).message };
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
