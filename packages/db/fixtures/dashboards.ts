// QA harness (M2): runs the SQL stored in infra/grafana/dashboards/*.json the way Grafana does, as the
// read-only user, against a throwaway database, and builds the known datasets the tests use.
//
// It reuses the check's own expansion code (infra/grafana/src), so a test sees exactly the SQL that
// `pnpm grafana:check` sends. What it adds is a way to choose the time range and the variables, and
// to read the rows back as objects.
import { fileURLToPath } from "node:url";
import {
  type EventEnvelope,
  type FleetEvent,
  type IssueKind,
  newEvent,
  type SessionStatus,
} from "@fleetscope/schema";
import { type ClickHouseConnection, runQuery } from "../../../infra/grafana/src/clickhouse-http";
import {
  collectPanels,
  DASHBOARD_DATASOURCE_UID,
  extractQueries,
  loadDashboardFiles,
  type QueryItem,
} from "../../../infra/grafana/src/dashboards";
import { interpolate, type VariableState } from "../../../infra/grafana/src/interpolate";
import { asArray, asString, isObject, type JsonObject } from "../../../infra/grafana/src/json";
import { displayNames, parseFieldPattern } from "../../../infra/grafana/src/panel-fields";
import { panelIntervalMs, parseIntervalMs } from "../../../infra/grafana/src/time";

export const DASHBOARD_DIR = fileURLToPath(
  new URL("../../../infra/grafana/dashboards", import.meta.url),
);

export type DashboardName = "overview" | "sessions" | "session" | "browsers";
const FILES: Record<DashboardName, string> = {
  overview: "fleetscope-overview.json",
  sessions: "fleetscope-sessions.json",
  session: "fleetscope-session.json",
  browsers: "fleetscope-browsers.json",
};

export const ENGINES = ["chromium", "chrome-headless-shell", "lightpanda"] as const;
const STATUSES = ["healthy", "degraded", "failed", "blocked", "running", "interrupted"];

export interface Range {
  from: number;
  to: number;
}

/** What the dashboard variables are set to. Anything left out is "All" (or empty for text boxes). */
export interface Filters {
  engines?: string[];
  source?: "real" | "sim";
  status?: string[];
  agent?: string[];
  scenario?: string[];
  cause?: string;
  /** The Sessions dashboard's "Routed" variable: `all` (default) or `routed` (routed_from is set). */
  routed?: "all" | "routed";
  session?: string;
}

export type Row = Record<string, unknown>;

function dashboardJson(name: DashboardName): JsonObject {
  const file = loadDashboardFiles(DASHBOARD_DIR).find((f) => f.file === FILES[name]);
  if (!file?.json) throw new Error(`dashboard ${FILES[name]} not found or not valid JSON`);
  return file.json;
}

/** The queries that hold SQL. A panel that reads another panel (R-M2-01) has none: see `resolveQuery`. */
export function queriesOf(name: DashboardName): QueryItem[] {
  return extractQueries(dashboardJson(name)).queries;
}

/** The query with this label. Titles can repeat (Session has an "Actions" stat and an "Actions" table): `nth` picks one. */
export function queryOf(name: DashboardName, where: string, nth = 0): QueryItem {
  const found = queriesOf(name).filter((q) => q.where === where);
  const item = found[nth];
  if (!item) throw new Error(`no query "${where}" (#${nth}) in ${name}`);
  return item;
}

export interface ResolvedQuery {
  /** The query that is run: the panel's own, or the one of the panel it reads. */
  item: QueryItem;
  /** Set when the panel only shows columns of another panel's query: which columns it keeps. */
  reader?: { title: string; columns: (all: string[]) => string[] };
}

/**
 * What Grafana runs for `panel "Title", query A`. Since R-M2-01 most single-number panels have no SQL:
 * they read panel 1 through the "-- Dashboard --" data source (`targets[0].panelId`) and show the
 * columns that `options.reduceOptions.fields` matches against the DISPLAY name (after the panel's
 * displayName overrides). This follows that chain, so a test sees the columns the panel shows.
 */
export function resolveQuery(name: DashboardName, where: string, nth = 0): ResolvedQuery {
  const own = queriesOf(name).filter((q) => q.where === where)[nth];
  if (own) return { item: own };
  const title = /^panel "(.*)", query \w+$/.exec(where)?.[1];
  const panel = collectPanels(dashboardJson(name)).find((p) => p.title === title)?.panel;
  const target = panel ? asArray(panel.targets).filter(isObject)[0] : undefined;
  const dataSource = isObject(target?.datasource) ? asString(target.datasource.uid) : undefined;
  if (!panel || !target || dataSource !== DASHBOARD_DATASOURCE_UID) {
    throw new Error(`no query "${where}" (#${nth}) in ${name}`);
  }
  const source = queriesOf(name).find((q) => q.panelId === target.panelId);
  if (!source) {
    throw new Error(`"${title}" reads panel ${String(target.panelId)}, which has no SQL`);
  }
  const options = isObject(panel.options) ? panel.options : {};
  const reduce = isObject(options.reduceOptions) ? options.reduceOptions : {};
  const fields = asString(reduce.fields);
  const pattern = fields ? parseFieldPattern(fields) : undefined;
  if (fields && !pattern) {
    throw new Error(`"${title}": reduceOptions.fields "${fields}" is not a valid pattern`);
  }
  return {
    item: source,
    reader: {
      title: title as string,
      columns: (all) => {
        if (!pattern) return all;
        const regex = new RegExp(pattern.source, pattern.flags);
        const display = displayNames(panel, all);
        return all.filter((column) => regex.test(display.get(column) ?? column));
      },
    },
  };
}

function state(
  name: string,
  options: string[],
  multi: boolean,
  selected: string[] | undefined,
): VariableState {
  return {
    name,
    multi,
    all: selected === undefined,
    allValue: undefined,
    selected: selected ?? [],
    options,
  };
}

function variables(filters: Filters): Map<string, VariableState> {
  const text = (name: string, value: string | undefined): VariableState => ({
    name,
    multi: false,
    all: false,
    allValue: undefined,
    selected: [value ?? ""],
    options: [],
  });
  return new Map<string, VariableState>([
    ["engine", state("engine", [...ENGINES], true, filters.engines)],
    [
      "source",
      state("source", ["real", "sim"], false, filters.source ? [filters.source] : undefined),
    ],
    ["status", state("status", STATUSES, true, filters.status)],
    ["agent", state("agent", [], true, filters.agent)],
    ["scenario", state("scenario", [], true, filters.scenario)],
    ["cause", text("cause", filters.cause)],
    ["routed", text("routed", filters.routed ?? "all")],
    ["session", text("session", filters.session)],
    ["api_url", text("api_url", "http://localhost:4000")],
  ]);
}

/** The SQL ClickHouse receives for one query of a dashboard. */
export function expandedSql(
  item: Pick<QueryItem, "sql" | "maxDataPoints" | "minInterval">,
  range: Range,
  filters: Filters = {},
  title = "test",
): string {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const intervalMs = panelIntervalMs(
    { from, to },
    item.maxDataPoints,
    parseIntervalMs(item.minInterval) ?? 1000,
  );
  return interpolate({
    sql: item.sql,
    variables: variables(filters),
    builtins: new Map([
      ["__from", String(range.from)],
      ["__to", String(range.to)],
      ["__interval_ms", String(intervalMs)],
      ["__dashboard", title],
    ]),
    macros: { from, to, intervalMs },
  });
}

export class DashboardRunner {
  constructor(private readonly connection: ClickHouseConnection) {}

  async rows(sql: string, keep?: (columns: string[]) => string[]): Promise<Row[]> {
    const result = await runQuery(this.connection, sql);
    const columns = keep ? keep(result.columns) : result.columns;
    return result.rows.map((cells) =>
      Object.fromEntries(
        result.columns
          .map((name, i) => [name, cells[i]] as const)
          .filter(([name]) => columns.includes(name)),
      ),
    );
  }

  /** Runs the panel (`panel "Title", query A`) of a dashboard and returns its rows. */
  async run(
    name: DashboardName,
    where: string,
    range: Range,
    filters: Filters = {},
    nth = 0,
  ): Promise<Row[]> {
    const { item, reader } = resolveQuery(name, where, nth);
    const rows = await this.rows(expandedSql(item, range, filters), reader?.columns);
    if (reader && rows.length > 0 && Object.keys(rows[0] as Row).length === 0) {
      // the real panel would show "No data": fail loudly, with the panel name
      throw new Error(`panel "${reader.title}" matches no column of the query it reads`);
    }
    return rows;
  }

  /** Milliseconds one query takes, rows included. */
  async time(
    name: DashboardName,
    where: string,
    range: Range,
    filters: Filters = {},
  ): Promise<{ ms: number; rows: number }> {
    const sql = expandedSql(resolveQuery(name, where).item, range, filters);
    const start = performance.now();
    const result = await runQuery(this.connection, sql);
    return { ms: performance.now() - start, rows: result.rows.length };
  }
}

/** ClickHouse returns UInt64 as a string and Nullable as null: one place that turns both into numbers. */
export const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

// ---------------------------------------------------------------------------------------------
// Known data
// ---------------------------------------------------------------------------------------------

export const MIN = 60_000;
export const toClickHouse = (ms: number) =>
  new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export interface SessionSpec {
  id: string;
  engine: (typeof ENGINES)[number];
  source?: "real" | "sim";
  provider?: string;
  /** `running` = the session never ended. */
  status: SessionStatus | "running";
  reason?: string | null;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number;
  startupMs: number;
  connectMs: number;
  engineVersion?: string | null;
  /** The engine the assignment chose before the fleet routed the session to `engine` (ADR 0005). */
  routedFrom?: (typeof ENGINES)[number] | null;
  scenario?: string;
  agent?: string;
  /** One entry per action: [duration_ms, error_code or null]. seq 0 is a goto, the rest are clicks. */
  actions?: Array<[number, string | null]>;
  issue?: IssueKind;
  /** Container samples as [cpu_pct, mem_mb, offset ms from the start]. */
  samples?: Array<[number, number, number?]>;
  /** CDP samples as js_heap_mb (null = the engine does not report it). */
  heap?: Array<number | null>;
  /** Network requests: [status or null, bytes or null, duration_ms]. */
  requests?: Array<[number | null, number | null, number]>;
}

export function eventsOf(spec: SessionSpec): FleetEvent[] {
  const ctx: EventEnvelope = {
    session_id: spec.id,
    source: spec.source ?? "real",
    agent_id: spec.agent ?? "qa-agent",
    engine: spec.engine,
    provider: spec.provider ?? "local-docker",
  };
  const start = spec.startedAt;
  const out: FleetEvent[] = [
    newEvent(
      "session.started",
      ctx,
      {
        engine_version: spec.engineVersion === undefined ? "1.0.0" : spec.engineVersion,
        scenario: spec.scenario ?? "login-and-search",
        region: "local",
        startup_ms: spec.startupMs,
        connect_ms: spec.connectMs,
        ...(spec.routedFrom === undefined ? {} : { routed_from: spec.routedFrom }),
      },
      start,
    ),
  ];
  (spec.actions ?? []).forEach(([ms, code], seq) => {
    out.push(
      newEvent(
        "action",
        ctx,
        {
          seq,
          action_type: seq === 0 ? "goto" : "click",
          target: seq === 0 ? "demo.test" : "button.buy",
          duration_ms: ms,
          ok: code === null,
          error_code: code,
        },
        start + 1000 + seq * 100,
      ),
    );
  });
  (spec.samples ?? []).forEach(([cpu, mem, at], i) => {
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        { origin: "container", cpu_pct: cpu, mem_mb: mem, net_rx_bytes: 1, net_tx_bytes: 1 },
        start + (at ?? 2000 + i * 2000),
      ),
    );
  });
  (spec.heap ?? []).forEach((heap, i) => {
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        {
          origin: "cdp",
          cpu_pct: null,
          mem_mb: null,
          net_rx_bytes: null,
          net_tx_bytes: null,
          js_heap_mb: heap,
        },
        start + 3000 + i * 2000,
      ),
    );
  });
  (spec.requests ?? []).forEach(([status, bytes, ms], i) => {
    out.push(
      newEvent(
        "network.request",
        ctx,
        {
          domain: "demo.test",
          status,
          bytes,
          duration_ms: ms,
          resource_type: "document",
        },
        start + 1500 + i * 100,
      ),
    );
  });
  if (spec.issue) {
    out.push(
      newEvent("issue", ctx, { kind: spec.issue, message: "seen by the test" }, start + 1200),
    );
  }
  if (spec.status !== "running") {
    out.push(
      newEvent(
        "session.ended",
        ctx,
        { status: spec.status, reason: spec.reason ?? null, duration_ms: spec.durationMs },
        start + spec.durationMs,
      ),
    );
  }
  return out;
}

/** Inserts sessions as the API would: the starts first, the ends in a later flush. */
export async function insertSpecs(
  insert: (events: FleetEvent[]) => Promise<unknown>,
  specs: SessionSpec[],
): Promise<void> {
  const events = specs.flatMap(eventsOf);
  await insert(events.filter((e) => e.type !== "session.ended"));
  await insert(events.filter((e) => e.type === "session.ended"));
}
