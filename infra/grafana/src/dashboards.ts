// Reads infra/grafana/dashboards/*.json and applies the structural rules: valid JSON, unique UIDs,
// every query on the Fleetscope data source, links that point at real dashboards. It also pulls the
// SQL out of panels, variables and annotations for the executing part of the check.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asArray, asString, isObject, type JsonObject } from "./json";
import { hasTransformations } from "./panel-fields";

export const CLICKHOUSE_DATASOURCE_UID = "fleetscope-clickhouse";
export const FOLDER_UID = "fleetscope";
/** Grafana's "Dashboard" data source: a panel that shows the result of another panel's query. */
export const DASHBOARD_DATASOURCE_UID = "-- Dashboard --";

/** Grafana's built-in data sources: they need no SQL and no ClickHouse. */
const BUILT_IN_DATASOURCE_UIDS = new Set(["grafana", "-- Grafana --", "-- Dashboard --"]);
const MIXED_DATASOURCE_UID = "-- Mixed --";

/** Panel types that show no query result, so they need no data source. */
const PANEL_TYPES_WITHOUT_DATA = new Set(["row", "text"]);

export interface Problem {
  /** Where in the dashboard, e.g. `panel "Success rate", query A`. */
  where: string;
  message: string;
  /** Extra lines shown under the message, e.g. the SQL that was sent. */
  detail?: string;
}

export interface DashboardFile {
  /** File name, e.g. fleetscope-overview.json. */
  file: string;
  path: string;
  /** Undefined when the file could not be parsed (see `parseError`). */
  json: JsonObject | undefined;
  parseError: string | undefined;
}

export function loadDashboardFiles(dir: string): DashboardFile[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.map((file) => {
    const path = join(dir, file);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed)) {
        return { file, path, json: undefined, parseError: "the top level is not a JSON object" };
      }
      return { file, path, json: parsed, parseError: undefined };
    } catch (error) {
      return { file, path, json: undefined, parseError: (error as Error).message };
    }
  });
}

export interface Dashboard {
  file: string;
  uid: string;
  title: string;
  json: JsonObject;
}

export interface StructureResult {
  dashboards: Dashboard[];
  /** Problems per file name (a parse error, a missing uid, ...). */
  problems: Map<string, Problem[]>;
  /** Things worth knowing that do not fail the check. */
  warnings: Map<string, Problem[]>;
}

function addTo(map: Map<string, Problem[]>, file: string, problem: Problem): void {
  map.set(file, [...(map.get(file) ?? []), problem]);
}

/** File-level rules: parses, has uid and title, UIDs and titles are unique, classic JSON format. */
export function checkStructure(files: DashboardFile[]): StructureResult {
  const problems = new Map<string, Problem[]>();
  const warnings = new Map<string, Problem[]>();
  const dashboards: Dashboard[] = [];
  const byUid = new Map<string, string>();
  const byTitle = new Map<string, string>();

  for (const { file, json, parseError } of files) {
    if (!json) {
      addTo(problems, file, { where: "file", message: `not valid JSON: ${parseError}` });
      continue;
    }
    const uid = asString(json.uid);
    const title = asString(json.title);
    if (!uid) addTo(problems, file, { where: "dashboard", message: 'missing a string "uid"' });
    if (!title) addTo(problems, file, { where: "dashboard", message: 'missing a string "title"' });
    if (!uid || !title) continue;

    if ("elements" in json || "apiVersion" in json) {
      addTo(problems, file, {
        where: "dashboard",
        message:
          'looks like the v2 dashboard schema ("elements"/"apiVersion"). Export the classic JSON model instead (Dashboard settings > JSON Model, schemaVersion 39+)',
      });
      continue;
    }
    if (typeof json.schemaVersion !== "number") {
      addTo(problems, file, { where: "dashboard", message: 'missing a numeric "schemaVersion"' });
    }
    if (json.id !== null && json.id !== undefined) {
      addTo(warnings, file, {
        where: "dashboard",
        message: `"id" is ${JSON.stringify(json.id)}; set it to null (ids belong to one Grafana database). grafana:push ignores it`,
      });
    }

    const sameUid = byUid.get(uid);
    if (sameUid) {
      addTo(problems, file, {
        where: "dashboard",
        message: `uid "${uid}" is also used by ${sameUid}`,
      });
    } else {
      byUid.set(uid, file);
    }
    const sameTitle = byTitle.get(title);
    if (sameTitle) {
      addTo(problems, file, {
        where: "dashboard",
        message: `title "${title}" is also used by ${sameTitle} (Grafana needs unique titles within a folder)`,
      });
    } else {
      byTitle.set(title, file);
    }
    dashboards.push({ file, uid, title, json });
  }
  return { dashboards, problems, warnings };
}

// ---------------------------------------------------------------- panels

export interface PanelRef {
  panel: JsonObject;
  title: string;
}

/** Every panel, including those inside rows (collapsed rows keep theirs in `panels`). */
export function collectPanels(dashboard: JsonObject): PanelRef[] {
  const out: PanelRef[] = [];
  const visit = (panels: unknown[]): void => {
    for (const item of panels) {
      if (!isObject(item)) continue;
      out.push({
        panel: item,
        title:
          asString(item.title) || `(untitled ${asString(item.type) ?? "panel"} #${item.id ?? "?"})`,
      });
      visit(asArray(item.panels));
    }
  };
  visit(asArray(dashboard.panels));
  return out;
}

/** The data source UID of an object that has a `datasource` field; undefined when it has none. */
function datasourceUid(holder: JsonObject): { uid: string | undefined; present: boolean } {
  const ds = holder.datasource;
  if (ds === undefined || ds === null) return { uid: undefined, present: false };
  if (typeof ds === "string") return { uid: ds, present: true };
  if (isObject(ds)) return { uid: asString(ds.uid), present: true };
  return { uid: undefined, present: true };
}

function describeDatasourceProblem(
  uid: string | undefined,
  present: boolean,
  where: string,
): Problem | undefined {
  if (uid === CLICKHOUSE_DATASOURCE_UID) return undefined;
  if (uid !== undefined && BUILT_IN_DATASOURCE_UIDS.has(uid)) return undefined;
  if (!present || uid === undefined) {
    return {
      where,
      message: `no data source set. Pin it to {"type": "grafana-clickhouse-datasource", "uid": "${CLICKHOUSE_DATASOURCE_UID}"}: without it Grafana uses whatever the default data source is, and on Grafana Cloud that is not ours`,
    };
  }
  if (uid === MIXED_DATASOURCE_UID) {
    return {
      where,
      message: `a query cannot use "${MIXED_DATASOURCE_UID}"; set the data source on the query itself`,
    };
  }
  return {
    where,
    message: `data source "${uid}" is not "${CLICKHOUSE_DATASOURCE_UID}". Dashboards use one data source, with a fixed UID (a "\${DS_...}" input from "Export for sharing externally" does not work with provisioning)`,
  };
}

// ---------------------------------------------------------------- queries

export interface QueryItem {
  kind: "panel" | "variable" | "annotation";
  /** Human label, e.g. `panel "Success rate", query A` or `variable "agent"`. */
  where: string;
  sql: string;
  /** Panel query options that change $__interval. */
  maxDataPoints: number | undefined;
  minInterval: string | undefined;
  /** The `id` of the panel that owns the query (panels only); other panels may read its result. */
  panelId?: number;
}

/**
 * A panel that shows the result of another panel's query (Grafana's "Dashboard" data source,
 * R-M2-01). It has no SQL of its own, so the check looks at the source panel's query instead.
 */
export interface DashboardRead {
  where: string;
  panel: JsonObject;
  /** The ids of the panels it reads (usually one). */
  sourcePanelIds: number[];
  /** True when transformations may rename or drop fields, so the field names cannot be checked. */
  skipFields: boolean;
}

/**
 * Checks one query of a panel that uses the Dashboard data source: the panel it reads must exist in
 * this dashboard, must not be itself, and must hold ClickHouse SQL (so that the query is one we run).
 */
function readsAnotherPanel(input: {
  panel: JsonObject;
  target: JsonObject;
  where: string;
  byId: Map<number, PanelRef>;
}): { problems: Problem[]; sourcePanelId: number | undefined; skipFields: boolean } {
  const { panel, target, where, byId } = input;
  const fail = (message: string) => ({
    problems: [{ where, message }],
    sourcePanelId: undefined,
    skipFields: false,
  });
  const id = target.panelId;
  if (typeof id !== "number") {
    return fail(
      'uses the Dashboard data source but has no numeric "panelId", so it shows the result of no panel',
    );
  }
  const source = byId.get(id);
  if (!source) {
    const known = [...byId.keys()].sort((a, b) => a - b).join(", ");
    return fail(`reads panel ${id}, which does not exist in this dashboard (panel ids: ${known})`);
  }
  if (source.panel === panel) return fail(`reads itself (panelId ${id})`);
  if (!hasOwnSql(source.panel)) {
    return fail(
      `reads panel ${id} ("${source.title}"), which has no ClickHouse SQL of its own. Point it at the panel that holds the query: a Dashboard-data-source panel cannot read another one`,
    );
  }
  const refId = asString(target.panelRefId);
  const refIds = asArray(source.panel.targets)
    .filter(isObject)
    .map((t) => asString(t.refId));
  if (refId && !refIds.includes(refId)) {
    return fail(
      `reads query ${refId} of panel ${id} ("${source.title}"), which has only: ${refIds.join(", ")}`,
    );
  }
  const skipFields =
    hasTransformations(panel) ||
    (target.withTransforms === true && hasTransformations(source.panel));
  return { problems: [], sourcePanelId: id, skipFields };
}

export interface Extracted {
  queries: QueryItem[];
  problems: Problem[];
  warnings: Problem[];
  dashboardReads: DashboardRead[];
}

/** Does a panel hold a ClickHouse query with SQL of its own? */
function hasOwnSql(panel: JsonObject): boolean {
  const panelDs = datasourceUid(panel);
  return asArray(panel.targets)
    .filter(isObject)
    .some((target) => {
      const own = datasourceUid(target);
      const effective = own.present ? own : panelDs;
      return (
        effective.uid === CLICKHOUSE_DATASOURCE_UID && Boolean(asString(target.rawSql)?.trim())
      );
    });
}

export function extractQueries(dashboard: JsonObject): Extracted {
  const queries: QueryItem[] = [];
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  const dashboardReads = new Map<JsonObject, DashboardRead>();

  const allPanels = collectPanels(dashboard);
  const byId = new Map<number, PanelRef>();
  for (const found of allPanels) {
    const id = found.panel.id;
    if (typeof id !== "number") continue;
    const same = byId.get(id);
    if (same) {
      problems.push({
        where: `panel "${found.title}"`,
        message: `has the same id (${id}) as panel "${same.title}". Panel ids must be unique: the Dashboard data source and links refer to panels by id`,
      });
    } else {
      byId.set(id, found);
    }
  }

  for (const { panel, title } of allPanels) {
    const type = asString(panel.type) ?? "";
    if (panel.libraryPanel !== undefined) {
      warnings.push({
        where: `panel "${title}"`,
        message: "is a library panel: its queries live in Grafana's database and are not checked",
      });
      continue;
    }
    const targets = asArray(panel.targets).filter(isObject);
    if (targets.length === 0) {
      if (!PANEL_TYPES_WITHOUT_DATA.has(type) && datasourceUid(panel).present) {
        const found = datasourceUid(panel);
        const problem = describeDatasourceProblem(found.uid, true, `panel "${title}"`);
        if (problem) problems.push(problem);
      }
      continue;
    }
    const panelDs = datasourceUid(panel);
    for (const [index, target] of targets.entries()) {
      const refId = asString(target.refId) ?? String.fromCharCode(65 + index);
      const where = `panel "${title}", query ${refId}`;
      const own = datasourceUid(target);
      const effective = own.present ? own : panelDs;
      const problem = describeDatasourceProblem(effective.uid, effective.present, where);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (effective.uid === DASHBOARD_DATASOURCE_UID) {
        const read = readsAnotherPanel({ panel, target, where, byId });
        problems.push(...read.problems);
        if (read.sourcePanelId !== undefined) {
          const known = dashboardReads.get(panel) ?? {
            where: `panel "${title}"`,
            panel,
            sourcePanelIds: [],
            skipFields: false,
          };
          known.sourcePanelIds.push(read.sourcePanelId);
          known.skipFields = known.skipFields || read.skipFields;
          dashboardReads.set(panel, known);
        }
        continue;
      }
      if (effective.uid !== CLICKHOUSE_DATASOURCE_UID) continue; // another built-in data source: nothing to run
      const sql = asString(target.rawSql);
      if (!sql || sql.trim() === "") {
        problems.push({
          where,
          message:
            target.editorType === "builder"
              ? 'is a query-builder query without "rawSql". Open the panel, switch to the SQL editor or save it again, then re-export'
              : 'has no "rawSql"',
        });
        continue;
      }
      queries.push({
        kind: "panel",
        where,
        sql,
        maxDataPoints: typeof panel.maxDataPoints === "number" ? panel.maxDataPoints : undefined,
        minInterval: asString(target.interval) ?? asString(panel.interval),
        panelId: typeof panel.id === "number" ? panel.id : undefined,
      });
    }
  }

  const templating = isObject(dashboard.templating) ? asArray(dashboard.templating.list) : [];
  for (const variable of templating.filter(isObject)) {
    if (variable.type !== "query") continue;
    const name = asString(variable.name) ?? "(unnamed)";
    const where = `variable "${name}"`;
    const found = datasourceUid(variable);
    const problem = describeDatasourceProblem(found.uid, found.present, where);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const sql = variableSql(variable);
    if (!sql) {
      problems.push({ where, message: "is a query variable without SQL" });
      continue;
    }
    queries.push({
      kind: "variable",
      where,
      sql,
      maxDataPoints: undefined,
      minInterval: undefined,
    });
  }

  const annotations = isObject(dashboard.annotations) ? asArray(dashboard.annotations.list) : [];
  for (const annotation of annotations.filter(isObject)) {
    const name = asString(annotation.name) ?? "(unnamed)";
    const where = `annotation "${name}"`;
    const found = datasourceUid(annotation);
    const problem = describeDatasourceProblem(found.uid, found.present, where);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (found.uid !== CLICKHOUSE_DATASOURCE_UID) continue;
    const target = isObject(annotation.target) ? annotation.target : undefined;
    const sql = asString(target?.rawSql) ?? asString(annotation.rawQuery);
    if (!sql) {
      problems.push({ where, message: 'has no SQL ("target.rawSql")' });
      continue;
    }
    queries.push({
      kind: "annotation",
      where,
      sql,
      maxDataPoints: undefined,
      minInterval: undefined,
    });
  }

  return { queries, problems, warnings, dashboardReads: [...dashboardReads.values()] };
}

/** The SQL of a query variable. The ClickHouse plugin stores it as `query.rawSql`; old files use a string. */
export function variableSql(variable: JsonObject): string | undefined {
  const query = variable.query;
  const text =
    typeof query === "string" ? query : isObject(query) ? asString(query.rawSql) : undefined;
  return text?.trim() ? text : asString(variable.definition)?.trim() || undefined;
}

// ---------------------------------------------------------------- variables

export interface VariableDefinition {
  name: string;
  type: string;
  multi: boolean;
  includeAll: boolean;
  allValue: string | undefined;
  /** Raw `query` text of custom, interval, constant and textbox variables. */
  queryText: string;
  /** SQL of a query variable. */
  sql: string | undefined;
  /** `current.value` as a list ("$__all" when All is selected). */
  current: string[];
  /** `options[].value`, when the JSON carries them. */
  jsonOptions: string[];
}

function valueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

export function variableDefinitions(dashboard: JsonObject): VariableDefinition[] {
  const templating = isObject(dashboard.templating) ? asArray(dashboard.templating.list) : [];
  return templating.filter(isObject).map((variable) => {
    const current = isObject(variable.current) ? valueList(variable.current.value) : [];
    return {
      name: asString(variable.name) ?? "",
      type: asString(variable.type) ?? "",
      multi: variable.multi === true,
      includeAll: variable.includeAll === true,
      allValue: asString(variable.allValue) || undefined,
      queryText: typeof variable.query === "string" ? variable.query : "",
      sql: variable.type === "query" ? variableSql(variable) : undefined,
      current,
      jsonOptions: asArray(variable.options)
        .filter(isObject)
        .map((option) => String(option.value ?? ""))
        .filter((value) => value !== "" && value !== "$__all"),
    };
  });
}

/**
 * The values a custom variable offers. Grafana's format: `a,b,c` or `Text : value` pairs; a comma
 * can be escaped with a backslash.
 */
export function parseCustomOptions(query: string): string[] {
  const items = query.match(/(?:\\,|[^,])+/g) ?? [];
  return items
    .map((item) => item.replace(/\\,/g, ",").trim())
    .filter((item) => item !== "")
    .map((item) => {
      const pair = /^(.+?)\s*:\s*(.+)$/.exec(item);
      return pair ? (pair[2] as string).trim() : item;
    });
}

// ---------------------------------------------------------------- links

/** Relative links to other dashboards (`/d/<uid>...`) must point at a dashboard in this folder. */
export function checkDashboardLinks(dashboards: Dashboard[]): Map<string, Problem[]> {
  const known = new Set(dashboards.map((d) => d.uid));
  const problems = new Map<string, Problem[]>();
  for (const dashboard of dashboards) {
    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        const uid = /^\/d\/([\w-]+)/.exec(value)?.[1];
        if (uid && !known.has(uid) && !seen.has(uid)) {
          seen.add(uid);
          addTo(problems, dashboard.file, {
            where: "links",
            message: `a link points at /d/${uid}, but no dashboard in infra/grafana/dashboards has that uid (known: ${[...known].sort().join(", ")})`,
          });
        }
      } else if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (isObject(value)) {
        for (const item of Object.values(value)) walk(item);
      }
    };
    walk(dashboard.json);
  }
  return problems;
}
