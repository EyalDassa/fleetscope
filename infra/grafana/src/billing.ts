// The ClickHouse Cloud billing side of the Capacity dashboard (docs: infra/grafana/README.md, "Capacity").
//   - the Infinity plugin (yesoreyeram-infinity-datasource), pinned, installed on the Grafana if missing
//   - the data source clickhouse-cloud-api: basic auth with an API key (CLICKHOUSE_CLOUD_KEY_ID /
//     CLICKHOUSE_CLOUD_KEY_SECRET). Its base URL contains the organisation id (CLICKHOUSE_CLOUD_ORG_ID):
//     https://api.clickhouse.cloud/v1/organizations/<org>. Panels and alert rules then use the relative URL
//     /usageCost?... and need no variable: an alert rule has no dashboard variables to fill in.
// Without the key or the org id the data source is skipped with a note. The key is never printed.
// Checked 2026-10-25:
//   plugin: https://grafana.com/api/plugins/yesoreyeram-infinity-datasource (4.1.3, signed by Grafana Labs,
//     needs Grafana >=12.2.5 or 11.6.11, so Grafana 13.2.4 is fine; plugin.json has "alerting": true)
//   provisioning keys: https://grafana.com/docs/plugins/yesoreyeram-infinity-datasource/latest/configure/
//   API: https://clickhouse.com/docs/_specs/cloud-openapi.json, GET /v1/organizations/{organizationId}/usageCost
import { GrafanaApiError } from "./errors";
import { isObject } from "./json";
import type { GrafanaClient } from "./push";

export const INFINITY_PLUGIN_ID = "yesoreyeram-infinity-datasource";
/** Keep in sync with GF_PLUGINS_PREINSTALL_SYNC in infra/docker-compose.yml (checked by billing.test.ts). */
export const INFINITY_PLUGIN_VERSION = "4.1.3";
export const BILLING_DATASOURCE_UID = "clickhouse-cloud-api";
export const BILLING_DATASOURCE_NAME = "ClickHouse Cloud API";
export const BILLING_API_URL = "https://api.clickhouse.cloud";
const ORG_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface BillingDataSourceSpec {
  uid: string;
  name: string;
  type: string;
  access: "proxy";
  isDefault: false;
  /** Infinity's base URL: https://api.clickhouse.cloud/v1/organizations/<org>. Query URLs are relative to it. */
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
  const org = env.CLICKHOUSE_CLOUD_ORG_ID?.trim();
  const missing = [
    ["CLICKHOUSE_CLOUD_KEY_ID", keyId],
    ["CLICKHOUSE_CLOUD_KEY_SECRET", secret],
    ["CLICKHOUSE_CLOUD_ORG_ID", org],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !keyId || !secret || !org) {
    return {
      enabled: false,
      reason: `${missing.join(", ")} not set, so the billing data source is skipped (set all three to get it). What a Grafana already has is left as it is`,
    };
  }
  if (!ORG_ID.test(org)) {
    return {
      enabled: false,
      reason:
        "CLICKHOUSE_CLOUD_ORG_ID is not an organisation id (a UUID such as 3f1c2d4e-0000-4000-8000-000000000001), so the billing data source is skipped",
    };
  }
  const base = `${BILLING_API_URL}/v1/organizations/${org}`;
  return {
    enabled: true,
    dataSource: {
      uid: BILLING_DATASOURCE_UID,
      name: BILLING_DATASOURCE_NAME,
      type: INFINITY_PLUGIN_ID,
      access: "proxy",
      isDefault: false,
      url: base,
      basicAuth: true,
      basicAuthUser: keyId,
      // Required whenever authentication is configured. Pinned to the one endpoint the dashboards read, so
      // the key cannot be sent to another host or another API path, whatever URL a panel is edited to.
      jsonData: { auth_method: "basicAuth", allowedHosts: [`${base}/usageCost`] },
      secureJsonData: { basicAuthPassword: secret },
    },
  };
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
