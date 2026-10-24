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
  type DashboardRead,
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
import { CAPACITY_DASHBOARD_UID } from "./palette";
import { unmatchedFieldReferences } from "./panel-fields";
import { sessionFactsProblems } from "./session-facts";
import { snippetCopyProblems } from "./snippet-copies";
import { panelIntervalMs, parseIntervalMs, resolveTimeRange, type TimeRange } from "./time";
import { textboxProblems } from "./variable-rules";

export interface CheckOptions {
  dir: string;
  /** Without a connection only the static rules run (no SQL is executed). */
  connection: ClickHouseConnection | undefined;
  now?: Date;
  fetchImpl?: Fetch;
  /** Report links to dashboards that are not in the folder as warnings, not problems. */
  allowDanglingLinks?: boolean;
  /**
   * The `session-facts` block of packages/db/README.md. When given, every copy of it in a dashboard's
   * SQL must equal it (R-M2-05). The CLI always passes it; a test may leave it out.
   */
  sessionFacts?: string;
  /**
   * Every named block of the README. When given, a query that names a block (`-- snippet: <name>`) must
   * equal it, and on the Capacity dashboard every query must be a copy of some block (snippet-copies.ts).
   */
  snippets?: Map<string, string>;
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

/**
 * The state of one variable for one mode ("default": what the dashboard opens with, "filtered": one
 * value, so the filter branches such as `$__conditionalAll(cause = ${cause}, $cause)` run too).
 * `sessionId` is the newest real session, for the Session dashboard's `session` text box.
 */
export function makeVariableState(
  def: VariableDefinition,
  options: string[],
  mode: VariableMode,
  sessionId?: string,
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
    // A text box starts empty, so by default its filter is off. In the filtered mode it gets a value
    // (R-M2-13): the newest real session id for `session`, a placeholder for the rest, such as `cause`.
    const preset = def.current[0] || def.queryText;
    const filtered = def.name === "session" && sessionId ? sessionId : PLACEHOLDER_VALUE;
    return {
      ...base,
      multi: false,
      all: false,
      selected: [mode === "filtered" && !preset ? filtered : preset],
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
  reads: DashboardRead[],
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

  // The columns each panel's query returned, for the panels that show its result (R-M2-01).
  const columnsByPanel = new Map<number, Set<string>>();

  const run = async (item: QueryItem, sql: string, note: string): Promise<boolean> => {
    try {
      const result = await runQuery(connection, sql, fetchImpl);
      report.ran.push({ where: item.where, rows: result.rows.length, note });
      if (item.panelId !== undefined) {
        const known = columnsByPanel.get(item.panelId) ?? new Set<string>();
        for (const column of result.columns) known.add(column);
        columnsByPanel.set(item.panelId, known);
      }
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

  // The Session dashboard's `session` text box is empty by default, so without this every query
  // there would run on no data. Use the newest session in the database (R-M2-13).
  let sessionId: string | undefined;
  if (definitions.some((def) => def.type === "textbox" && def.name === "session")) {
    let why = "the sessions table is empty (pnpm db:seed)";
    try {
      const latest = await runQuery(
        connection,
        "SELECT session_id FROM sessions FINAL ORDER BY started_at DESC LIMIT 1",
        fetchImpl,
      );
      const first = latest.rows[0]?.[0];
      sessionId = first === undefined ? undefined : String(first);
    } catch (error) {
      why = clickHouseMessage(error, connection);
    }
    if (sessionId === undefined) {
      report.warnings.push({
        where: 'variable "session"',
        message: `no real session id was found (${why}), so the per-session queries run with a placeholder id`,
      });
    }
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
        const state = makeVariableState(def, optionsByName.get(def.name) ?? [], mode, sessionId);
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

  // Panels that show another panel's result (Dashboard data source): the fields they select must
  // exist in that result. The source's own query was run above, so a failing source is already a problem.
  for (const read of reads) {
    if (read.skipFields) {
      report.warnings.push({
        where: read.where,
        message: "has transformations, so the field names it selects are not checked",
      });
      continue;
    }
    const sources = read.sourcePanelIds.map((id) => ({
      id,
      columns: columnsByPanel.get(id),
      label: queries.find((q) => q.panelId === id)?.where ?? `panel ${id}`,
    }));
    if (sources.some((source) => !source.columns || source.columns.size === 0)) continue;
    const columns = [...new Set(sources.flatMap((source) => [...(source.columns ?? [])]))];
    for (const message of unmatchedFieldReferences(read.panel, columns)) {
      report.problems.push({
        where: read.where,
        message,
        detail: `It shows the result of ${sources.map((source) => source.label).join(" and ")}`,
      });
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
    const textboxes = variableDefinitions(dashboard.json)
      .filter((def) => def.type === "textbox")
      .map((def) => def.name);
    for (const query of extracted.queries) {
      report.problems.push(...sqlRuleProblems(query.sql, query.where));
      // Text boxes take any text: they may reach SQL only through percentencode (R-M2-19).
      for (const found of textboxProblems(query.sql, textboxes)) {
        report.problems.push({ where: query.where, message: found.message, detail: found.detail });
      }
      if (options.snippets !== undefined) {
        const copy = snippetCopyProblems(query.sql, options.snippets, {
          where: query.where,
          requireCopy: dashboard.uid === CAPACITY_DASHBOARD_UID && query.kind !== "variable",
        });
        report.problems.push(...copy.problems);
      }
      if (options.sessionFacts !== undefined) {
        for (const found of sessionFactsProblems(query.sql, options.sessionFacts, dashboard.uid)) {
          report.problems.push({
            where: query.where,
            message: found.message,
            detail: found.detail,
          });
        }
      }
    }
    if (options.connection) {
      await checkDashboardQueries(
        dashboard,
        extracted.queries,
        extracted.dashboardReads,
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
