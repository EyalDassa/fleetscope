// The dashboard check: structure, design rules, and a real run of every SQL query against ClickHouse.
// The CLI is src/cli/check.ts; this file is the part the tests call.
import {
  type ClickHouseConnection,
  ClickHouseQueryError,
  type Fetch,
  runQuery,
} from "./clickhouse-http";
import {
  checkDashboardLinks,
  checkStructure,
  type Dashboard,
  extractQueries,
  loadDashboardFiles,
  type Problem,
  parseCustomOptions,
  type QueryItem,
  type VariableDefinition,
  variableDefinitions,
} from "./dashboards";
import { designProblems, sqlRuleProblems } from "./design-rules";
import {
  ALL_VALUE,
  InterpolationError,
  interpolate,
  type VariableMode,
  type VariableState,
} from "./interpolate";
import { formatInterval } from "./macros";
import { panelIntervalMs, parseIntervalMs, resolveTimeRange, type TimeRange } from "./time";

export interface CheckOptions {
  dir: string;
  /** Without a connection only the static rules run (no SQL is executed). */
  connection: ClickHouseConnection | undefined;
  now?: Date;
  fetchImpl?: Fetch;
  /** Report links to dashboards that are not in the folder as warnings, not problems. */
  allowDanglingLinks?: boolean;
}

export interface QueryRun {
  where: string;
  rows: number;
  /** "" for the normal run, a note when the variables were set to single values. */
  note: string;
}

export interface FileReport {
  file: string;
  title: string | undefined;
  problems: Problem[];
  warnings: Problem[];
  ran: QueryRun[];
}

export interface CheckReport {
  files: FileReport[];
  problemCount: number;
  queriesRun: number;
}

/** What `check` assumes for a variable's value when the SQL has `$__conditionalAll` and friends. */
const FILTERED_NOTE = " (variables set to one value)";
const PLACEHOLDER_VALUE = "fleetscope-check-placeholder";

// ---------------------------------------------------------------- variables

function optionsOf(def: VariableDefinition): string[] {
  switch (def.type) {
    case "custom":
      return parseCustomOptions(def.queryText).length > 0
        ? parseCustomOptions(def.queryText)
        : def.jsonOptions;
    case "interval":
      return def.queryText
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "" && v !== "auto");
    case "constant":
      return def.queryText === "" ? [] : [def.queryText];
    default:
      return def.jsonOptions;
  }
}

/** The state of one variable for one mode ("default": what the dashboard opens with, "filtered": one value). */
export function makeVariableState(
  def: VariableDefinition,
  options: string[],
  mode: VariableMode,
): VariableState | undefined {
  const base = { name: def.name, allValue: def.allValue, options };
  if (def.type === "constant") {
    return {
      ...base,
      multi: false,
      all: false,
      selected: [def.queryText],
      options: [def.queryText],
    };
  }
  if (def.type === "textbox") {
    return {
      ...base,
      multi: false,
      all: false,
      selected: [def.current[0] ?? def.queryText],
      options: [],
    };
  }
  if (!["custom", "query", "interval"].includes(def.type)) return undefined;

  const concrete = def.current.filter((v) => v !== ALL_VALUE);
  const wantsAll = def.current.includes(ALL_VALUE);
  if (mode === "filtered") {
    const first = concrete[0] ?? options[0] ?? PLACEHOLDER_VALUE;
    return { ...base, multi: def.multi, all: false, selected: [first] };
  }
  if (wantsAll || (concrete.length === 0 && def.includeAll)) {
    return { ...base, multi: def.multi, all: true, selected: [] };
  }
  const selected = concrete.length > 0 ? concrete : options.slice(0, 1);
  return { ...base, multi: def.multi, all: false, selected };
}

function builtinVariables(
  range: TimeRange,
  intervalMs: number,
  dashboardTitle: string,
): Map<string, string> {
  const rangeMs = range.to.getTime() - range.from.getTime();
  return new Map([
    ["__from", String(range.from.getTime())],
    ["__to", String(range.to.getTime())],
    ["__interval", formatInterval(intervalMs)],
    ["__interval_ms", String(intervalMs)],
    ["__range", `${Math.round(rangeMs / 1000)}s`],
    ["__range_s", String(Math.round(rangeMs / 1000))],
    ["__range_ms", String(rangeMs)],
    ["__dashboard", dashboardTitle],
  ]);
}

// ---------------------------------------------------------------- running

function excerpt(sql: string): string {
  const flat = sql.trim();
  return flat.length > 1500 ? `${flat.slice(0, 1500)} ... (${flat.length} characters)` : flat;
}

function clickHouseMessage(error: unknown, connection: ClickHouseConnection): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ClickHouseQueryError && /AUTHENTICATION_FAILED|Code: 516/.test(message)) {
    return `${message}\nHint: user "${connection.user}" cannot log in. If it is the read-only Grafana user, create it with \`pnpm db:grafana-user\`.`;
  }
  return message;
}

async function checkDashboardQueries(
  dashboard: Dashboard,
  queries: QueryItem[],
  options: CheckOptions & { connection: ClickHouseConnection },
  report: FileReport,
): Promise<void> {
  const { connection, fetchImpl } = options;
  const now = options.now ?? new Date();
  const timeField = dashboard.json.time;
  const range = resolveTimeRange(
    typeof timeField === "object" && timeField !== null
      ? (timeField as { from?: string; to?: string })
      : undefined,
    now,
  );
  const definitions = variableDefinitions(dashboard.json);

  const run = async (item: QueryItem, sql: string, note: string): Promise<boolean> => {
    try {
      const result = await runQuery(connection, sql, fetchImpl);
      report.ran.push({ where: item.where, rows: result.rows.length, note });
      return true;
    } catch (error) {
      report.problems.push({
        where: item.where,
        message: `ClickHouse error${note}: ${clickHouseMessage(error, connection)}`,
        detail: `SQL sent:\n${excerpt(sql)}`,
      });
      return false;
    }
  };

  // Pass 1: find out which values each variable offers. Query variables run their own SQL.
  const defaultStates = new Map<string, VariableState>();
  const optionsByName = new Map<string, string[]>();
  const variableQueries = new Map(
    queries.filter((q) => q.kind === "variable").map((q) => [q.where, q] as const),
  );
  const intervalMs = panelIntervalMs(range);
  const builtins = builtinVariables(range, intervalMs, dashboard.title);
  for (const def of definitions) {
    let options = optionsOf(def);
    const item = variableQueries.get(`variable "${def.name}"`);
    if (def.type === "query" && item) {
      try {
        const sql = interpolate({
          sql: item.sql,
          variables: defaultStates,
          builtins,
          macros: { from: range.from, to: range.to, intervalMs },
        });
        const result = await runQuery(connection, sql, fetchImpl);
        report.ran.push({ where: item.where, rows: result.rows.length, note: "" });
        // One column: value = text. Two columns: the first is the value, the second the label.
        options = result.rows.map((row) => String(row[0]));
      } catch (error) {
        report.problems.push({
          where: item.where,
          message:
            error instanceof InterpolationError
              ? error.message
              : `ClickHouse error: ${clickHouseMessage(error, connection)}`,
        });
      }
    }
    optionsByName.set(def.name, options);
    const state = makeVariableState(def, options, "default");
    if (state) defaultStates.set(def.name, state);
  }

  // Pass 2: every panel and annotation query, with the variables in each mode.
  for (const item of queries) {
    if (item.kind === "variable") continue;
    const itemIntervalMs = panelIntervalMs(
      range,
      item.maxDataPoints,
      parseIntervalMs(item.minInterval) ?? 1000,
    );
    const itemBuiltins = builtinVariables(range, itemIntervalMs, dashboard.title);
    const seen = new Set<string>();
    for (const mode of ["default", "filtered"] as const) {
      const states = new Map<string, VariableState>();
      for (const def of definitions) {
        const state = makeVariableState(def, optionsByName.get(def.name) ?? [], mode);
        if (state) states.set(def.name, state);
      }
      let sql: string;
      try {
        sql = interpolate({
          sql: item.sql,
          variables: states,
          builtins: itemBuiltins,
          macros: { from: range.from, to: range.to, intervalMs: itemIntervalMs },
        });
      } catch (error) {
        if (!(error instanceof InterpolationError)) throw error;
        report.problems.push({
          where: item.where,
          message: error.message,
          detail: `SQL in the dashboard:\n${excerpt(item.sql)}`,
        });
        break; // the same error would repeat in the other mode
      }
      if (seen.has(sql)) continue; // the variables made no difference to this query
      seen.add(sql);
      const ok = await run(item, sql, mode === "filtered" ? FILTERED_NOTE : "");
      if (!ok) break;
    }
  }

  const totalRows = report.ran.reduce((sum, r) => sum + r.rows, 0);
  if (report.ran.length > 0 && totalRows === 0) {
    report.warnings.push({
      where: "data",
      message: "every query returned 0 rows. Is the database seeded? (pnpm db:seed)",
    });
  }
}

export async function checkDashboards(options: CheckOptions): Promise<CheckReport> {
  const files = loadDashboardFiles(options.dir);
  const structure = checkStructure(files);
  const linkProblems = checkDashboardLinks(structure.dashboards);
  const reports: FileReport[] = [];

  for (const file of files) {
    const dashboard = structure.dashboards.find((d) => d.file === file.file);
    const links = linkProblems.get(file.file) ?? [];
    const report: FileReport = {
      file: file.file,
      title: dashboard?.title,
      problems: [
        ...(structure.problems.get(file.file) ?? []),
        ...(options.allowDanglingLinks ? [] : links),
      ],
      warnings: [
        ...(structure.warnings.get(file.file) ?? []),
        ...(options.allowDanglingLinks ? links : []),
      ],
      ran: [],
    };
    reports.push(report);
    if (!dashboard) continue;

    const extracted = extractQueries(dashboard.json);
    report.problems.push(...extracted.problems, ...designProblems(dashboard.json));
    report.warnings.push(...extracted.warnings);
    for (const query of extracted.queries) {
      report.problems.push(...sqlRuleProblems(query.sql, query.where));
    }
    if (options.connection) {
      await checkDashboardQueries(
        dashboard,
        extracted.queries,
        { ...options, connection: options.connection },
        report,
      );
    }
  }

  return {
    files: reports,
    problemCount: reports.reduce((sum, r) => sum + r.problems.length, 0),
    queriesRun: reports.reduce((sum, r) => sum + r.ran.length, 0),
  };
}
