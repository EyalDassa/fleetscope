import type { ClickHouseClient } from "./client";

/**
 * Rows for `pnpm sim calibrate` (apps/simulator): the REAL sessions of the last `days` days with
 * their actions, samples and network requests. All SQL lives here (CLAUDE.md); `days` is a query
 * parameter. Interrupted and running sessions are left out: they did not finish, so their duration
 * and action count say nothing about a normal session.
 */

export interface CalibrationSession {
  session_id: string;
  engine: string;
  scenario: string;
  status: string;
  reason: string | null;
  engine_version: string | null;
  started_at: string;
  startup_ms: number;
  connect_ms: number;
  duration_ms: number;
}
export interface CalibrationAction {
  session_id: string;
  seq: number;
  action_type: string;
  target: string;
  duration_ms: number;
  ok: boolean;
  error_code: string | null;
}
export interface CalibrationSample {
  session_id: string;
  origin: string;
  cpu_pct: number | null;
  mem_mb: number | null;
  js_heap_mb: number | null;
}
export interface CalibrationRequest {
  session_id: string;
  domain: string;
  bytes: number | null;
  duration_ms: number;
  resource_type: string;
}
export interface CalibrationData {
  sessions: CalibrationSession[];
  actions: CalibrationAction[];
  samples: CalibrationSample[];
  requests: CalibrationRequest[];
}

export const DEFAULT_CALIBRATION_DAYS = 14;

const GOOD_SESSIONS = `
  SELECT session_id FROM sessions FINAL
  WHERE source = 'real' AND status != 'running'
    AND NOT (status = 'failed' AND ifNull(reason, '') = 'interrupted')
    AND started_at >= now() - INTERVAL {days:UInt32} DAY`;

export async function readCalibrationData(
  client: ClickHouseClient,
  options: { days?: number } = {},
): Promise<CalibrationData> {
  const days = Math.max(1, Math.trunc(options.days ?? DEFAULT_CALIBRATION_DAYS));
  const rows = async <T>(query: string): Promise<T[]> =>
    (await client.query({ query, query_params: { days }, format: "JSONEachRow" })).json<T>();
  return {
    sessions: await rows<CalibrationSession>(`
      SELECT session_id, engine, scenario, status, reason, engine_version,
             toString(started_at) AS started_at, startup_ms, connect_ms, ifNull(duration_ms, 0) AS duration_ms
      FROM sessions FINAL WHERE session_id IN (${GOOD_SESSIONS})
      ORDER BY started_at`),
    actions: await rows<CalibrationAction>(`
      SELECT session_id, seq, action_type, target, duration_ms, ok, error_code
      FROM actions
      WHERE source = 'real' AND ts >= now() - INTERVAL {days:UInt32} DAY
        AND session_id IN (${GOOD_SESSIONS})
      ORDER BY session_id, seq`),
    samples: await rows<CalibrationSample>(`
      SELECT session_id, origin, cpu_pct, mem_mb, js_heap_mb
      FROM resource_samples
      WHERE source = 'real' AND ts >= now() - INTERVAL {days:UInt32} DAY
        AND session_id IN (${GOOD_SESSIONS})
      ORDER BY session_id, ts`),
    requests: await rows<CalibrationRequest>(`
      SELECT session_id, domain, bytes, duration_ms, resource_type
      FROM network_requests
      WHERE source = 'real' AND ts >= now() - INTERVAL {days:UInt32} DAY
        AND session_id IN (${GOOD_SESSIONS})`),
  };
}
