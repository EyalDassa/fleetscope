// pnpm grafana:pull <uid>: fetches a dashboard from Grafana and turns it back into repository JSON.
// Two uses:
//   - keep a change somebody made in the UI to an OFFICIAL dashboard (push refused to overwrite it)
//   - promote a TEAM dashboard: the file becomes an official candidate, which then goes through
//     `pnpm grafana:check` and a pull request like any other change
// What "repository JSON" means (what `grafana:push` and `grafana:check` expect):
//   - no `id`, no `version` (Grafana assigns them) and none of the response's `meta`
//   - the `api_url` constant is the committed placeholder again, not the URL push wrote into it
//   - every ClickHouse data source reference points at uid fleetscope-clickhouse
//   - two-space JSON with a final newline, as the committed files are
import { CLICKHOUSE_DATASOURCE_UID, FOLDER_UID } from "./dashboards";
import { TEAM_FOLDER_UID } from "./folder-access";
import { asArray, asString, isObject, type JsonObject } from "./json";
import {
  API_URL_VARIABLE,
  committedApiUrl,
  DATASOURCE_TYPE,
  type GrafanaClient,
  PushError,
  withApiUrl,
} from "./push";

/** The `api_url` value of the committed dashboards (.env.example: FLEETSCOPE_API_URL). */
export const API_URL_PLACEHOLDER = "http://localhost:4000";

export interface PulledDashboard {
  /** The normalised dashboard, ready to write. */
  json: JsonObject;
  /** The file content: two-space JSON and a final newline. */
  text: string;
  /** Folder the dashboard lives in, as Grafana reports it ("" for the General folder). */
  folderUid: string;
  folderTitle: string;
  /** What was changed on the way, for the log. */
  notes: string[];
}

/** Rewrites every ClickHouse data source reference to the provisioned uid. Returns how many changed. */
function fixDataSources(value: unknown): number {
  let changed = 0;
  if (Array.isArray(value)) {
    for (const item of value) changed += fixDataSources(item);
  } else if (isObject(value)) {
    if (value.type === DATASOURCE_TYPE && value.uid !== CLICKHOUSE_DATASOURCE_UID) {
      value.uid = CLICKHOUSE_DATASOURCE_UID;
      changed += 1;
    }
    for (const child of Object.values(value)) changed += fixDataSources(child);
  }
  return changed;
}

/** The `api_url` constant variable of a (committed) dashboard, or undefined. */
function apiUrlVariable(dashboard: unknown): JsonObject | undefined {
  if (!isObject(dashboard) || !isObject(dashboard.templating)) return undefined;
  const found = asArray(dashboard.templating.list).find(
    (v) => isObject(v) && v.name === API_URL_VARIABLE && v.type === "constant",
  );
  return isObject(found) ? found : undefined;
}

/** `dashboard` with its api_url variable replaced by `variable`; unchanged if it has none. */
function replaceApiUrlVariable(dashboard: JsonObject, variable: JsonObject): JsonObject {
  if (!apiUrlVariable(dashboard) || !isObject(dashboard.templating)) return dashboard;
  const list = asArray(dashboard.templating.list).map((v) =>
    isObject(v) && v.name === API_URL_VARIABLE && v.type === "constant"
      ? (JSON.parse(JSON.stringify(variable)) as JsonObject)
      : v,
  );
  return { ...dashboard, templating: { ...dashboard.templating, list } };
}

/**
 * Puts the keys of `value` in the order of `reference` (the file that is in the repository now).
 * Grafana's API returns every object with its keys sorted alphabetically; the committed files keep
 * the order a human gave them, and a diff of the pulled file against it should show the real change,
 * not a shuffle. Keys the reference lacks come last, in the order Grafana gave them.
 */
export function alignKeyOrder(value: unknown, reference: unknown): unknown {
  if (Array.isArray(value)) {
    const refItems = Array.isArray(reference) ? reference : [];
    return value.map((item, index) => alignKeyOrder(item, refItems[index]));
  }
  if (!isObject(value)) return value;
  const ref = isObject(reference) ? reference : {};
  const keys = [
    ...Object.keys(ref).filter((key) => key in value),
    ...Object.keys(value).filter((key) => !(key in ref)),
  ];
  return Object.fromEntries(keys.map((key) => [key, alignKeyOrder(value[key], ref[key])]));
}

/**
 * Normalises a dashboard from Grafana's API (`/api/dashboards/uid/:uid`) for the repository.
 * `committedUrl` is the api_url value to restore (the existing repo file's, else the placeholder).
 */
export function normaliseDashboard(
  response: unknown,
  committedUrl: string = API_URL_PLACEHOLDER,
  reference?: unknown,
  asUid?: string,
): PulledDashboard {
  if (!isObject(response) || !isObject(response.dashboard)) {
    throw new PushError("Grafana returned no dashboard");
  }
  const notes: string[] = [];
  // A deep copy, so the caller's response is not changed.
  const copy = JSON.parse(JSON.stringify(response.dashboard)) as JsonObject;
  const { id: _id, version: _version, ...rest } = copy;
  let dashboard: JsonObject = rest;
  const meta = isObject(response.meta) ? response.meta : {};
  notes.push("removed id and version");

  const before = committedApiUrl(dashboard);
  // The committed variable itself when the repository has this dashboard (exactly as committed),
  // otherwise the placeholder written into the variable the way push writes it.
  const committedVariable = apiUrlVariable(reference);
  const restored = committedVariable
    ? replaceApiUrlVariable(dashboard, committedVariable)
    : withApiUrl(dashboard, committedUrl);
  if (restored !== dashboard) {
    dashboard = restored;
    if (before !== committedUrl) notes.push(`api_url set back to ${committedUrl} (was ${before})`);
  }
  const fixed = fixDataSources(dashboard);
  if (fixed > 0) {
    notes.push(`${fixed} data source reference(s) set to ${CLICKHOUSE_DATASOURCE_UID}`);
  }

  if (reference !== undefined) {
    dashboard = alignKeyOrder(dashboard, reference) as JsonObject;
    notes.push("keys in the order of the existing file, so a diff shows the real change");
  }

  if (asUid !== undefined) {
    dashboard = { ...dashboard, uid: asUid };
    notes.push(`uid set to ${asUid}`);
  }

  return {
    json: dashboard,
    text: `${JSON.stringify(dashboard, null, 2)}\n`,
    folderUid: asString(meta.folderUid) ?? "",
    folderTitle: asString(meta.folderTitle) ?? "",
    notes,
  };
}

export async function fetchDashboard(
  client: GrafanaClient,
  uid: string,
  committedUrl?: string,
  reference?: unknown,
  asUid?: string,
): Promise<PulledDashboard> {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(uid)) {
    throw new PushError(`"${uid}" is not a dashboard uid (letters, digits, - and _)`);
  }
  const response = await client.get(`/api/dashboards/uid/${uid}`);
  if (response === undefined) throw new PushError(`Grafana has no dashboard with uid ${uid}`);
  return normaliseDashboard(response, committedUrl, reference, asUid);
}

/** What to tell the user after a pull, depending on where the dashboard came from. */
export function pullReminder(pulled: PulledDashboard, uid: string): string[] {
  const sameUid = pulled.json.uid === uid;
  if (pulled.folderUid === FOLDER_UID) {
    return [
      `${uid} is an official dashboard. The file now holds the version saved in Grafana: review the diff,`,
      'run pnpm grafana:check and commit it in a pull request. At the next pnpm grafana:push the dashboard equals the repository, and push saves it once under its own account ("adopted"); after that, ordinary repository changes are pushed without --force.',
    ];
  }
  const where =
    pulled.folderUid === TEAM_FOLDER_UID
      ? "the team folder"
      : `folder "${pulled.folderTitle || "General"}"`;
  return [
    `${uid} comes from ${where}: the file is now an official dashboard CANDIDATE.`,
    "It must pass pnpm grafana:check (design rules, query rules, links) and go through a pull request before it counts.",
    ...(sameUid
      ? [
          `The file still has the uid ${uid} of the dashboard in ${where}. Grafana has one dashboard per uid, so push would refuse it (team folder) or move it.`,
          `Give the official copy its own uid: pnpm grafana:pull ${uid} --as fleetscope-<name> (the title and tags are yours to set in the file).`,
        ]
      : [
          "Nothing in Grafana changed. After the merge, pnpm grafana:push puts it into the official folder; the team copy stays where it is.",
        ]),
  ];
}
