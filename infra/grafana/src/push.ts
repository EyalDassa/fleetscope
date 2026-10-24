// pnpm grafana:push: makes a Grafana (normally Grafana Cloud) match the repository.
//   1. folder "Fleetscope" (uid fleetscope), locked: Viewer and Editor may view, only Admins edit
//      folder "Team dashboards" (uid fleetscope-team), where Editors build their own dashboards.
//      Push creates it and sets who may do what, and never reads, changes or deletes what is in it.
//   2. the ClickHouse data source (uid fleetscope-clickhouse), built from the environment
//   3. every dashboards/*.json, into the official folder. A dashboard that somebody else saved in
//      Grafana and that differs from the repository is REFUSED (pnpm grafana:pull keeps it,
//      --force [uid] discards it). One that somebody else saved but that already equals the
//      repository (after a merged pull) is saved once more under the push's account: "adopted"
//   4. the organisation's default theme: dark (DESIGN.md section 2)
// It only reads and writes through Grafana's HTTP API, it can run again and again (it says
// "unchanged" for what is already right), and it never prints the token or the ClickHouse password.
// HTTP API reference: https://grafana.com/docs/grafana/latest/developers/http_api/

import {
  type AlertFile,
  type AlertGroupResult,
  alertStructureProblems,
  pushAlertGroups,
} from "./alerts";
import {
  BILLING_DATASOURCE_UID,
  type BillingConfig,
  CH_ORG_VARIABLE,
  ensureInfinityPlugin,
  hasConstantVariable,
  type PluginResult,
  withConstantVariable,
} from "./billing";
import type { Fetch } from "./clickhouse-http";
import {
  CLICKHOUSE_DATASOURCE_UID,
  checkStructure,
  type DashboardFile,
  FOLDER_UID,
} from "./dashboards";
import { driftVerdict, identityFrom } from "./drift";
import { GrafanaApiError, PushError } from "./errors";
import {
  describeAccess,
  ensureFolderAccess,
  OFFICIAL_FOLDER_ACCESS,
  TEAM_FOLDER_ACCESS,
  TEAM_FOLDER_TITLE,
  TEAM_FOLDER_UID,
} from "./folder-access";
import { isLoopbackHost } from "./hosts";
import { asArray, canonicalJson, isObject, type JsonObject } from "./json";

export const FOLDER_TITLE = "Fleetscope";
export const DATASOURCE_NAME = "Fleetscope ClickHouse";
export const DATASOURCE_TYPE = "grafana-clickhouse-datasource";
/** The constant variable of the session dashboard that holds the API base URL (DESIGN.md 4.1). */
export const API_URL_VARIABLE = "api_url";

export { GrafanaApiError, PushError };

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

/** A dashboard push did not overwrite, because somebody else saved it in Grafana. */
export interface Refusal {
  uid: string;
  by: string | undefined;
  at: string | undefined;
  /** Why, in a sentence. */
  reason: string;
}

export interface PushResult {
  folder: Action;
  /** The role permissions of the official folder (View for Viewer and Editor, Admin for Admin). */
  lock: Action;
  teamFolder: Action;
  teamAccess: Action;
  dataSource: Action;
  /** The Infinity plugin (billing data source): installed, found, or not available. */
  infinityPlugin: PluginResult["state"] | "not-needed";
  /** The ClickHouse Cloud API data source, or "skipped" when no API key is set. */
  billingSource: Action | "skipped";
  /** One entry per alert rule group file. */
  alerts: AlertGroupResult[];
  dashboards: { uid: string; action: Action | "refused" | "adopted" }[];
  /** Dashboards that were not overwritten. `grafana:push` exits non-zero when this is not empty. */
  refused: Refusal[];
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
  /** The ClickHouse Cloud billing data source, or why there is none. Default: skipped without a reason. */
  billing?: BillingConfig;
  /** CLICKHOUSE_CLOUD_ORG_ID: written into the dashboards' constant variable `ch_org`. */
  chOrg?: string;
  /** infra/grafana/alerts/*.json: rule groups for the official folder. */
  alertFiles?: AlertFile[];
  /** FLEETSCOPE_API_URL: written into the dashboards' `api_url` variable. */
  apiUrl: string | undefined;
  /** True when Grafana is on this machine, so a localhost API URL needs no warning. */
  grafanaIsLocal: boolean;
  dryRun: boolean;
  /** Overwrite every dashboard that was changed in Grafana by somebody else. */
  force?: boolean;
  /** Overwrite only these dashboards (`--force <uid>`). Every uid must be one of the repository's. */
  forceUids?: readonly string[];
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

/** The value of the `api_url` constant variable as committed, or undefined if the dashboard has none. */
export function committedApiUrl(dashboard: JsonObject): string | undefined {
  const list = asArray(isObject(dashboard.templating) ? dashboard.templating.list : []);
  const variable = list.find(
    (v) => isObject(v) && v.name === API_URL_VARIABLE && v.type === "constant",
  );
  if (!isObject(variable)) return undefined;
  return typeof variable.query === "string" ? variable.query : "";
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

  const brokenAlerts = alertStructureProblems(options.alertFiles ?? []).map(
    (p) => `${p.where}: ${p.message}`,
  );
  if (brokenAlerts.length > 0) {
    throw new PushError(
      `fix the alert files first (pnpm grafana:check):\n  ${brokenAlerts.join("\n  ")}`,
    );
  }

  // `--force <uid>` must name a dashboard of the repository (checked before the first write).
  const forceUids = new Set(options.forceUids ?? []);
  const knownUids = new Set(structure.dashboards.map((d) => d.uid));
  for (const uid of forceUids) {
    if (!knownUids.has(uid)) {
      throw new PushError(`--force ${uid}: no dashboard file in the repository has that uid`);
    }
  }

  // Build every dashboard body before the first write, so a problem found now leaves Grafana
  // untouched instead of half updated.
  const apiUrl = options.apiUrl;
  const filesWithApiUrl: string[] = [];
  /** Dashboards with an api_url variable that keep the value they were committed with. */
  const keepingCommittedUrl: { file: string; url: string }[] = [];
  const prepared = structure.dashboards.map((dashboard) => {
    let body = { ...dashboard.json, id: null } as JsonObject;
    if (apiUrl !== undefined) {
      const withUrl = withApiUrl(body, apiUrl);
      if (withUrl !== body) {
        filesWithApiUrl.push(dashboard.file);
        body = withUrl;
      }
    } else {
      const committed = committedApiUrl(body);
      if (committed !== undefined)
        keepingCommittedUrl.push({ file: dashboard.file, url: committed });
    }
    if (options.chOrg !== undefined)
      body = withConstantVariable(body, CH_ORG_VARIABLE, options.chOrg);
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
  // Unset on a remote Grafana: the links silently keep the committed (localhost) address (QA-M2-11).
  if (!options.grafanaIsLocal && keepingCommittedUrl.length > 0) {
    const urls = [...new Set(keepingCommittedUrl.map((k) => k.url))].join(", ");
    warnings.push(
      `FLEETSCOPE_API_URL is not set, so the Perfetto links (${keepingCommittedUrl.map((k) => k.file).join(", ")}) keep the committed ${urls}. Set it to the URL of your API; http://localhost:4000 only works on the machine running the API`,
    );
  }
  if (options.chOrg === undefined) {
    const needing = prepared
      .filter(({ body }) => hasConstantVariable(body, CH_ORG_VARIABLE))
      .map(({ dashboard }) => dashboard.file);
    if (needing.length > 0) {
      warnings.push(
        `CLICKHOUSE_CLOUD_ORG_ID is not set, so the billing panels (${needing.join(", ")}) keep the committed ${CH_ORG_VARIABLE} and will show no data`,
      );
    }
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

  // Who the token is: the drift guard below needs it, and so does the report on single-user grants.
  const me = identityFrom(read ? await client.get("/api/user") : undefined);

  // 1b. Lock the official folder. Folder access is read back from Grafana, so a second push says unchanged.
  const lockResult = await ensureFolderAccess(client, FOLDER_UID, OFFICIAL_FOLDER_ACCESS, {
    read: dryRun ? read && existingFolder !== undefined : true, // a real run has just created it
    dryRun,
    ignoreLogins: me.names,
  });
  log(
    `lock        ${FOLDER_UID}: ${describeAccess(OFFICIAL_FOLDER_ACCESS)}  ${would}${lockResult.action}` +
      (lockResult.changes.length > 0 ? ` (${lockResult.changes.join("; ")})` : ""),
  );
  if (lockResult.extraGrants.length > 0) {
    log(
      `note        ${FOLDER_UID} also has grants to single users or teams (${lockResult.extraGrants.join(", ")}); kept. Anyone with Edit there can change the official dashboards`,
    );
  }

  // 1c. The team folder: created if missing, access set, and then not looked at again.
  const existingTeamFolder = read ? await client.get(`/api/folders/${TEAM_FOLDER_UID}`) : undefined;
  const teamFolder: Action = isObject(existingTeamFolder) ? "unchanged" : "created";
  if (teamFolder === "created" && !dryRun) {
    await client.send("POST", "/api/folders", { uid: TEAM_FOLDER_UID, title: TEAM_FOLDER_TITLE });
  }
  log(`folder      ${TEAM_FOLDER_UID} ("${TEAM_FOLDER_TITLE}")  ${would}${teamFolder}`);
  const teamResult = await ensureFolderAccess(client, TEAM_FOLDER_UID, TEAM_FOLDER_ACCESS, {
    read: dryRun ? read && existingTeamFolder !== undefined : true,
    dryRun,
    ignoreLogins: me.names,
  });
  log(
    `access      ${TEAM_FOLDER_UID}: ${describeAccess(TEAM_FOLDER_ACCESS)}  ${would}${teamResult.action}` +
      (teamResult.changes.length > 0 ? ` (${teamResult.changes.join("; ")})` : "") +
      "  (its dashboards are never touched)",
  );

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
    `data source ${dataSource.uid}  ${would}${sourceAction}${
      sourceAction === "updated"
        ? " (the password cannot be compared, so it is always sent again)"
        : ""
    }  ` +
      `(${String(shown.secure ? "https" : "http")}://${String(shown.host)}:${String(shown.port)}, ` +
      `database ${String(shown.defaultDatabase)}, user ${String(shown.username)}, password ********)`,
  );

  // 2b. The billing data source (Infinity plugin + ClickHouse Cloud API key). No key: skipped, not an error.
  const billing: BillingConfig = options.billing ?? {
    enabled: false,
    reason: "billing is not configured",
  };
  let infinityPlugin: PushResult["infinityPlugin"] = "not-needed";
  let billingSource: PushResult["billingSource"] = "skipped";
  if (billing.enabled) {
    const plugin = await ensureInfinityPlugin(client, { dryRun, read });
    infinityPlugin = plugin.state;
    log(
      `plugin      yesoreyeram-infinity-datasource  ${plugin.state === "would-install" ? "would be installed" : plugin.state}${plugin.version ? ` (${plugin.version})` : ""}${plugin.note ? `: ${plugin.note}` : ""}`,
    );
    if (plugin.state === "unavailable") {
      warnings.push("the Infinity plugin is not available, so the billing data source was skipped");
      log(`warning     ${warnings[warnings.length - 1]}`);
    } else {
      const spec = billing.dataSource;
      const existing = read ? await client.get(`/api/datasources/uid/${spec.uid}`) : undefined;
      billingSource = isObject(existing) ? "updated" : "created";
      if (!dryRun) {
        if (billingSource === "updated")
          await client.send("PUT", `/api/datasources/uid/${spec.uid}`, spec);
        else await client.send("POST", "/api/datasources", spec);
      }
      log(
        `data source ${spec.uid}  ${would}${billingSource}${billingSource === "updated" ? " (the key cannot be compared, so it is always sent again)" : ""}  (${spec.url}, only that host allowed, key ********)`,
      );
    }
  } else {
    log(`note        billing: ${billing.reason}`);
  }

  // 3. Dashboards. The drift guard compares the last author with the token's login (`me`).

  const results: PushResult["dashboards"] = [];
  const refused: Refusal[] = [];
  const pushedUids = new Set<string>();
  for (const { dashboard, body } of prepared) {
    const remote = read ? await client.get(`/api/dashboards/uid/${dashboard.uid}`) : undefined;
    const remoteDashboard =
      isObject(remote) && isObject(remote.dashboard) ? remote.dashboard : undefined;
    let action: Action = "created";
    if (remoteDashboard) {
      action = comparable(remoteDashboard) === comparable(body) ? "unchanged" : "updated";
    }
    const meta = isObject(remote) ? remote.meta : undefined;
    // A repository uid that lives in the team folder is somebody's work: never move or overwrite it.
    const inTeamFolder = isObject(meta) && meta.folderUid === TEAM_FOLDER_UID;
    // meta.updatedBy first; when it names somebody else, confirm with the version history, which is
    // the more reliable record (a dashboard that the service account only created reports "Anonymous"
    // in meta, but "fleetscope-push" in its history; measured on Grafana 13.2.4).
    let verdict = driftVerdict(meta, me);
    if (verdict.refuse && remoteDashboard && !inTeamFolder) {
      const latest = await latestVersion(client, dashboard.uid);
      if (latest) {
        verdict = driftVerdict(
          {
            ...(isObject(meta) ? meta : {}),
            updatedBy: latest.by,
            updated: latest.at ?? undefined,
          },
          me,
        );
      }
    }
    const refusal: Refusal | undefined =
      action === "unchanged"
        ? undefined
        : inTeamFolder
          ? {
              uid: dashboard.uid,
              by: verdict.by,
              at: verdict.at,
              reason: `it is in the "${TEAM_FOLDER_TITLE}" folder, which push never touches`,
            }
          : action === "updated" &&
              verdict.refuse &&
              !options.force &&
              !forceUids.has(dashboard.uid)
            ? {
                uid: dashboard.uid,
                by: verdict.by,
                at: verdict.at,
                reason: `last saved in Grafana by ${verdict.by ?? "someone"}${verdict.at ? ` at ${verdict.at}` : ""} and it differs from the repository. Run pnpm grafana:pull ${dashboard.uid} to keep it, or pnpm grafana:push --force ${dashboard.uid} to discard it`,
              }
            : undefined;
    if (refusal) {
      refused.push(refusal);
      pushedUids.add(dashboard.uid);
      results.push({ uid: dashboard.uid, action: "refused" });
      log(
        `REFUSED     dashboard ${dashboard.uid}  ${dryRun ? "would be refused" : "not overwritten"}: ${refusal.reason}`,
      );
      continue;
    }
    // Equal to the repository but last saved by somebody else (a pull that was merged): save it once
    // more as the push's account. Otherwise the next repository change would look like their edit.
    const adopt = action === "unchanged" && verdict.refuse && !inTeamFolder && remoteDashboard;
    if (adopt) {
      if (!dryRun) {
        // Grafana makes no new version for a save that changes nothing, so the author would stay.
        // Save a copy with a different title first, then the real body: the last save is the push's.
        await client.send("POST", "/api/dashboards/db", {
          dashboard: { ...body, title: `${String(body.title)} (adopting)` },
          folderUid: FOLDER_UID,
          overwrite: true,
          message: "grafana:push adopting",
        });
        await client.send("POST", "/api/dashboards/db", {
          dashboard: body,
          folderUid: FOLDER_UID,
          overwrite: true,
          message: "grafana:push adopted",
        });
      }
      pushedUids.add(dashboard.uid);
      results.push({ uid: dashboard.uid, action: "adopted" });
      log(
        `dashboard   ${dashboard.uid}  ${would}adopted  (equals the repository; last saved by ${verdict.by}, now saved by ${me.label})`,
      );
      continue;
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

  // 3b. Alert rules, after the data sources and the folder they refer to exist.
  const skipDataSources = new Set<string>(
    billingSource === "skipped" ? [BILLING_DATASOURCE_UID] : [],
  );
  const alerts = await pushAlertGroups(client, options.alertFiles ?? [], {
    dryRun,
    // A dry run that could not read the folder cannot tell created from updated; it reads whatever it can.
    read,
    skipDataSources,
    log,
  });

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
    lock: lockResult.action,
    teamFolder,
    teamAccess: teamResult.action,
    dataSource: sourceAction,
    infinityPlugin,
    billingSource,
    alerts,
    dashboards: results,
    refused,

    theme,
    extraDashboards,
    warnings,
    health,
  };
}

/** Who saved the newest version of a dashboard, and when, from its version history. */
async function latestVersion(
  client: GrafanaClient,
  uid: string,
): Promise<{ by: string; at: string | undefined } | undefined> {
  try {
    const answer = await client.get(`/api/dashboards/uid/${uid}/versions?limit=1`);
    // Grafana 13 answers { versions: [...] }; older versions answer the array itself.
    const list = asArray(isObject(answer) ? answer.versions : answer).filter(isObject);
    const newest = list.reduce<JsonObject | undefined>(
      (best, v) => (best === undefined || Number(v.version) > Number(best.version) ? v : best),
      undefined,
    );
    const by = typeof newest?.createdBy === "string" ? newest.createdBy : undefined;
    if (!newest || !by) return undefined;
    return { by, at: typeof newest.created === "string" ? newest.created : undefined };
  } catch {
    return undefined; // no history (permissions, older Grafana): the meta answer stands
  }
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
