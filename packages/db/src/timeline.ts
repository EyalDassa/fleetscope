import type { SessionState } from "@fleetscope/schema";
import type { ClickHouseClient } from "./client";

/**
 * Everything the timeline of one session needs: the session itself and its actions, resource
 * samples, network requests and issues. Times are epoch milliseconds (numbers), so callers never
 * parse ClickHouse date strings.
 *
 * Meaning of the times: an action's `ts_ms` is when it STARTED; a network request's `ts_ms` is when
 * it FINISHED (it started `duration_ms` earlier); a sample's and an issue's is when it was taken
 * or raised.
 */

export interface TimelineSession {
  session_id: string;
  agent_id: string;
  source: string;
  engine: string;
  engine_version: string | null;
  provider: string;
  scenario: string;
  region: string;
  startup_ms: number;
  connect_ms: number;
  /** The engine the assignment chose before routing moved the session to `engine`; null if not routed. */
  routed_from: string | null;
  /** `running` until the session ended. */
  status: SessionState;
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  reason: string | null;
}

export interface TimelineAction {
  seq: number;
  ts_ms: number;
  action_type: string;
  target: string;
  duration_ms: number;
  ok: boolean;
  error_code: string | null;
}

export interface TimelineSample {
  ts_ms: number;
  origin: "container" | "cdp";
  /** Percent of one core. `null` on cdp samples. */
  cpu_pct: number | null;
  /** MiB. `null` on cdp samples. */
  mem_mb: number | null;
  /** MiB. `null` on container samples, and on cdp samples of an engine that cannot report it. */
  js_heap_mb: number | null;
}

export interface TimelineRequest {
  ts_ms: number;
  domain: string;
  status: number | null;
  bytes: number | null;
  duration_ms: number;
  resource_type: string;
}

export interface TimelineIssue {
  ts_ms: number;
  kind: string;
  message: string;
}

export interface SessionTimeline {
  session: TimelineSession;
  actions: TimelineAction[];
  samples: TimelineSample[];
  requests: TimelineRequest[];
  issues: TimelineIssue[];
  /** Tables that had more than `TIMELINE_ROW_LIMIT` rows for this session; only the first are returned. */
  truncated: Array<"actions" | "resource_samples" | "network_requests" | "issues">;
}

/**
 * Most rows read per table. A session of an hour has about 1,800 container samples; this keeps one
 * runaway session from turning a request into a multi-megabyte answer.
 */
export const TIMELINE_ROW_LIMIT = 20_000;

type Raw = Record<string, string | number | boolean | null>;

const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

async function rows<T = Raw>(
  client: ClickHouseClient,
  query: string,
  params: Record<string, string | number>,
): Promise<T[]> {
  const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return result.json<T>();
}

/**
 * Reads just the session row (the latest version, through FINAL), or `null` when there is no such
 * session. The Perfetto page uses it for its header without loading the whole timeline.
 */
export async function getTimelineSession(
  client: ClickHouseClient,
  sessionId: string,
): Promise<TimelineSession | null> {
  const [row] = await rows(
    client,
    `SELECT
       session_id, agent_id, source, engine, engine_version, provider, scenario, region,
       startup_ms, connect_ms, routed_from, status,
       toUnixTimestamp64Milli(started_at) AS started_at_ms,
       if(ended_at IS NULL, NULL, toUnixTimestamp64Milli(assumeNotNull(ended_at))) AS ended_at_ms,
       duration_ms, reason
     FROM sessions FINAL
     WHERE session_id = {id:String}
     LIMIT 1`,
    { id: sessionId },
  );
  if (!row) return null;

  return {
    session_id: String(row.session_id),
    agent_id: String(row.agent_id),
    source: String(row.source),
    engine: String(row.engine),
    engine_version: row.engine_version === null ? null : String(row.engine_version),
    provider: String(row.provider),
    scenario: String(row.scenario),
    region: String(row.region),
    startup_ms: num(row.startup_ms),
    connect_ms: num(row.connect_ms),
    routed_from: row.routed_from === null ? null : String(row.routed_from),
    status: String(row.status) as SessionState,
    started_at_ms: num(row.started_at_ms),
    ended_at_ms: numOrNull(row.ended_at_ms),
    duration_ms: numOrNull(row.duration_ms),
    reason: row.reason === null ? null : String(row.reason),
  };
}

/**
 * Reads the timeline of one session, or `null` when no such session exists. All parameters are
 * bound, never spliced into the SQL.
 *
 * The raw tables are sorted by `(engine, session_id, ts)`, so asking for the session's engine as
 * well (read from its own row first) lets ClickHouse use the primary key instead of scanning.
 */
export async function getSessionTimeline(
  client: ClickHouseClient,
  sessionId: string,
  options: { rowLimit?: number } = {},
): Promise<SessionTimeline | null> {
  const rowLimit = options.rowLimit ?? TIMELINE_ROW_LIMIT;
  const session = await getTimelineSession(client, sessionId);
  if (!session) return null;

  const params = { id: sessionId, engine: session.engine, limit: rowLimit + 1 };
  const where = "WHERE engine = {engine:String} AND session_id = {id:String}";
  const [actions, samples, requests, issues] = await Promise.all([
    rows(
      client,
      `SELECT toUnixTimestamp64Milli(ts) AS ts_ms, seq, action_type, target, duration_ms, ok, error_code
       FROM actions ${where} ORDER BY ts, seq LIMIT {limit:UInt32}`,
      params,
    ),
    rows(
      client,
      `SELECT toUnixTimestamp64Milli(ts) AS ts_ms, origin, cpu_pct, mem_mb, js_heap_mb
       FROM resource_samples ${where} ORDER BY ts LIMIT {limit:UInt32}`,
      params,
    ),
    rows(
      client,
      `SELECT toUnixTimestamp64Milli(ts) AS ts_ms, domain, status, bytes, duration_ms, resource_type
       FROM network_requests ${where} ORDER BY ts LIMIT {limit:UInt32}`,
      params,
    ),
    rows(
      client,
      `SELECT toUnixTimestamp64Milli(ts) AS ts_ms, kind, message
       FROM issues ${where} ORDER BY ts LIMIT {limit:UInt32}`,
      params,
    ),
  ]);

  const truncated: SessionTimeline["truncated"] = [];
  const cap = <T>(name: SessionTimeline["truncated"][number], list: T[]): T[] => {
    if (list.length <= rowLimit) return list;
    truncated.push(name);
    return list.slice(0, rowLimit);
  };

  return {
    session,
    actions: cap("actions", actions).map((r) => ({
      seq: num(r.seq),
      ts_ms: num(r.ts_ms),
      action_type: String(r.action_type),
      target: String(r.target),
      duration_ms: num(r.duration_ms),
      ok: r.ok === true || r.ok === 1,
      error_code: r.error_code === null ? null : String(r.error_code),
    })),
    samples: cap("resource_samples", samples).map((r) => ({
      ts_ms: num(r.ts_ms),
      origin: String(r.origin) as "container" | "cdp",
      cpu_pct: numOrNull(r.cpu_pct),
      mem_mb: numOrNull(r.mem_mb),
      js_heap_mb: numOrNull(r.js_heap_mb),
    })),
    requests: cap("network_requests", requests).map((r) => ({
      ts_ms: num(r.ts_ms),
      domain: String(r.domain),
      status: numOrNull(r.status),
      bytes: numOrNull(r.bytes),
      duration_ms: num(r.duration_ms),
      resource_type: String(r.resource_type),
    })),
    issues: cap("issues", issues).map((r) => ({
      ts_ms: num(r.ts_ms),
      kind: String(r.kind),
      message: String(r.message),
    })),
    truncated,
  };
}
