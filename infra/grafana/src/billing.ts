// The ClickHouse Cloud billing side of the Capacity dashboard (docs: infra/grafana/README.md, "Billing").
//   - the Infinity plugin (yesoreyeram-infinity-datasource), pinned, installed on the Grafana if missing
//   - the data source clickhouse-cloud-api: base URL https://api.clickhouse.cloud, basic auth with an
//     API key (CLICKHOUSE_CLOUD_KEY_ID / CLICKHOUSE_CLOUD_KEY_SECRET), only that host allowed
//   - the organisation id written into the dashboards' constant variable `ch_org`
// Without the key the data source is skipped with a note. The key is never printed.
// Checked 2026-10-25:
//   plugin: https://grafana.com/api/plugins/yesoreyeram-infinity-datasource (4.1.3, signed by Grafana Labs,
//     needs Grafana >=12.2.5 or 11.6.11, so Grafana 13.2.4 is fine; plugin.json has "alerting": true)
//   provisioning keys: https://grafana.com/docs/plugins/yesoreyeram-infinity-datasource/latest/configure/
//   API: https://clickhouse.com/docs/_specs/cloud-openapi.json, GET /v1/organizations/{organizationId}/usageCost
import { GrafanaApiError } from "./errors";
import { asArray, isObject, type JsonObject } from "./json";
import type { GrafanaClient } from "./push";

export const INFINITY_PLUGIN_ID = "yesoreyeram-infinity-datasource";
/** Keep in sync with GF_PLUGINS_PREINSTALL_SYNC in infra/docker-compose.yml (checked by billing.test.ts). */
export const INFINITY_PLUGIN_VERSION = "4.1.3";
export const BILLING_DATASOURCE_UID = "clickhouse-cloud-api";
export const BILLING_DATASOURCE_NAME = "ClickHouse Cloud API";
export const BILLING_BASE_URL = "https://api.clickhouse.cloud";
/** The constant dashboard variable that holds the ClickHouse Cloud organisation id. */
export const CH_ORG_VARIABLE = "ch_org";

export interface BillingDataSourceSpec {
  uid: string;
  name: string;
  type: string;
  access: "proxy";
  isDefault: false;
  /** Infinity's base URL: query URLs may then be relative (`/v1/organizations/...`). */
  url: string;
  basicAuth: true;
  basicAuthUser: string;
  jsonData: { auth_method: "basicAuth"; allowedHosts: string[] };
  secureJsonData: { basicAuthPassword: string };
}

export type BillingConfig =
  | { enabled: true; dataSource: BillingDataSourceSpec }
  | { enabled: false; reason: string };

/** The billing data source from the environment, or why there is none. Never throws for a missing key. */
export function buildBillingDataSource(env: NodeJS.ProcessEnv): BillingConfig {
  const keyId = env.CLICKHOUSE_CLOUD_KEY_ID?.trim();
  const secret = env.CLICKHOUSE_CLOUD_KEY_SECRET?.trim();
  if (!keyId && !secret) {
    return {
      enabled: false,
      reason:
        "CLICKHOUSE_CLOUD_KEY_ID and CLICKHOUSE_CLOUD_KEY_SECRET are not set, so the billing data source is skipped (the billing panels and the billing alert will have no data)",
    };
  }
  if (!keyId || !secret) {
    return {
      enabled: false,
      reason: `${keyId ? "CLICKHOUSE_CLOUD_KEY_SECRET" : "CLICKHOUSE_CLOUD_KEY_ID"} is not set (the other one is); set both to get the billing data source. It is skipped for now`,
    };
  }
  return {
    enabled: true,
    dataSource: {
      uid: BILLING_DATASOURCE_UID,
      name: BILLING_DATASOURCE_NAME,
      type: INFINITY_PLUGIN_ID,
      access: "proxy",
      isDefault: false,
      url: BILLING_BASE_URL,
      basicAuth: true,
      basicAuthUser: keyId,
      // Required whenever authentication is configured: Infinity then talks to this host and no other,
      // so the key cannot be sent anywhere else, whatever URL a panel is edited to use.
      jsonData: { auth_method: "basicAuth", allowedHosts: [BILLING_BASE_URL] },
      secureJsonData: { basicAuthPassword: secret },
    },
  };
}

/** The `ch_org` value, or undefined if unset. A UUID, but only "no spaces" is enforced: the API says what is valid. */
export function chOrgFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.CLICKHOUSE_CLOUD_ORG_ID?.trim();
  return value ? value : undefined;
}

/** Writes a value into a constant dashboard variable. Returns the dashboard itself if it has no such variable. */
export function withConstantVariable(
  dashboard: JsonObject,
  name: string,
  value: string,
): JsonObject {
  const templating = isObject(dashboard.templating) ? dashboard.templating : undefined;
  const list = asArray(templating?.list);
  const index = list.findIndex((v) => isObject(v) && v.name === name && v.type === "constant");
  if (!templating || index === -1) return dashboard;
  const variable = list[index] as JsonObject;
  const updated: JsonObject = {
    ...variable,
    query: value,
    current: { selected: false, text: value, value },
    options: [{ selected: true, text: value, value }],
  };
  return {
    ...dashboard,
    templating: { ...templating, list: list.map((v, i) => (i === index ? updated : v)) },
  };
}

export function hasConstantVariable(dashboard: JsonObject, name: string): boolean {
  const templating = isObject(dashboard.templating) ? dashboard.templating : undefined;
  return asArray(templating?.list).some(
    (v) => isObject(v) && v.name === name && v.type === "constant",
  );
}

// ---------------------------------------------------------------- the plugin

export interface PluginResult {
  /** installed: this push installed it. unchanged: it was there. unavailable: it is not there and could not be installed. */
  state: "installed" | "unchanged" | "would-install" | "unavailable";
  /** The version found on the Grafana, if any. */
  version: string | undefined;
  note: string | undefined;
}

/**
 * Makes sure the Infinity plugin is on the Grafana. Grafana Cloud and Grafana OSS both answer
 * `GET /api/plugins/<id>/settings` (404 = not installed) and `POST /api/plugins/<id>/install` for admins.
 * An installed plugin of another version is left alone (Grafana Cloud manages plugin updates) and noted.
 */
export async function ensureInfinityPlugin(
  client: GrafanaClient,
  options: { dryRun: boolean; read: boolean },
): Promise<PluginResult> {
  const settings = options.read
    ? await client.get(`/api/plugins/${INFINITY_PLUGIN_ID}/settings`)
    : undefined;
  if (isObject(settings)) {
    const info = isObject(settings.info) ? settings.info : {};
    const version = typeof info.version === "string" ? info.version : undefined;
    const note =
      version && version !== INFINITY_PLUGIN_VERSION
        ? `version ${version} is installed, the repository pins ${INFINITY_PLUGIN_VERSION}; left as it is`
        : undefined;
    return { state: "unchanged", version, note };
  }
  if (options.dryRun) return { state: "would-install", version: undefined, note: undefined };
  try {
    await client.send("POST", `/api/plugins/${INFINITY_PLUGIN_ID}/install`, {
      version: INFINITY_PLUGIN_VERSION,
    });
    return { state: "installed", version: INFINITY_PLUGIN_VERSION, note: undefined };
  } catch (error) {
    if (error instanceof GrafanaApiError) {
      return {
        state: "unavailable",
        version: undefined,
        note: `could not install it (${error.message}). Install it by hand: Administration > Plugins and data > Plugins > "Infinity" > Install`,
      };
    }
    throw error;
  }
}
