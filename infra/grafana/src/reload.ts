// pnpm grafana:reload: make the LOCAL Grafana pick up the dashboard files you just edited, and check
// that it did.
//
// Why this exists (QA-M2-01): Grafana watches the dashboards folder with fsnotify when
// `updateIntervalSeconds` is 10 or less, and fsnotify gets no events for files edited on the
// Windows (or macOS) side of a Docker Desktop bind mount. So the local Grafana kept serving the
// dashboards it loaded at start. The provisioning file now polls (interval above 10), and this
// command forces the reload at once through the admin API:
//   POST /api/admin/provisioning/dashboards/reload
// which only accepts Basic auth (the admin login), not a service account token, and answers after
// the dashboards are stored.
import { checkStructure, type DashboardFile } from "./dashboards";
import { isObject, type JsonObject } from "./json";
import { comparable, GrafanaApiError, type GrafanaClient, PushError } from "./push";

export interface ReloadResult {
  /** Dashboards whose stored JSON equals the file. */
  inSync: string[];
  /** Dashboards that Grafana has, but with different JSON than the file. */
  different: string[];
  /** Dashboards that Grafana does not have at all. */
  missing: string[];
}

export async function reloadDashboards(options: {
  client: GrafanaClient;
  dashboardFiles: DashboardFile[];
  log: (line: string) => void;
}): Promise<ReloadResult> {
  const { client, log } = options;
  const structure = checkStructure(options.dashboardFiles);
  const broken = [...structure.problems.entries()].flatMap(([file, problems]) =>
    problems.map((p) => `${file}: ${p.message}`),
  );
  if (broken.length > 0) {
    throw new PushError(
      `fix the dashboard files first (pnpm grafana:check):\n  ${broken.join("\n  ")}`,
    );
  }

  try {
    await client.send("POST", "/api/admin/provisioning/dashboards/reload", undefined);
  } catch (error) {
    if (error instanceof GrafanaApiError && error.status === 401) {
      throw new PushError(
        "Grafana refused the admin login. GRAFANA_ADMIN_PASSWORD must be the password the Grafana volume was created with: the variable only takes effect the first time Grafana starts on an empty grafana_data volume",
      );
    }
    throw error;
  }
  log("reloaded the dashboard provisioning");

  return verifyDashboards(client, structure.dashboards, log);
}

/** Compares every repository dashboard with what Grafana stores, and says which differ. */
export async function verifyDashboards(
  client: GrafanaClient,
  dashboards: { uid: string; file: string; json: JsonObject }[],
  log: (line: string) => void,
): Promise<ReloadResult> {
  const result: ReloadResult = { inSync: [], different: [], missing: [] };
  for (const dashboard of dashboards) {
    const stored = await client.get(`/api/dashboards/uid/${dashboard.uid}`);
    const remote = isObject(stored) && isObject(stored.dashboard) ? stored.dashboard : undefined;
    if (!remote) {
      result.missing.push(dashboard.uid);
      log(`MISSING     ${dashboard.uid}  (${dashboard.file}): Grafana does not have it`);
    } else if (comparable(remote) === comparable({ ...dashboard.json, id: null })) {
      result.inSync.push(dashboard.uid);
      log(`in sync     ${dashboard.uid}  (${dashboard.file})`);
    } else {
      result.different.push(dashboard.uid);
      log(`DIFFERENT   ${dashboard.uid}  (${dashboard.file}): Grafana still serves other JSON`);
    }
  }
  return result;
}
