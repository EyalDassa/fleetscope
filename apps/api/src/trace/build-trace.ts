import type { SessionTimeline } from "@fleetscope/db";
import { type ChromeTrace, TRACE_PROCESS_ID, TRACE_TID, type TraceEvent } from "@fleetscope/schema";

/**
 * Turns the timeline of one session into a Chrome Trace Event Format file for Perfetto. The layout
 * is specified in design/DESIGN.md section 5; this file is where it is implemented.
 *
 *   process 1  "<session id> · <engine> <version> · REAL|SIM · <status word>"
 *     thread "actions"      one slice per action
 *     thread "network"      one slice per request (more threads "network 2"... if they overlap)
 *     thread "issues"       one instant per issue
 *     thread "session"      the start and the end of the session
 *     counters              "CPU %", "memory MB" (container samples), "JS heap MB" (cdp samples)
 *
 * Times are microseconds from the start of the session. A value that was not measured is skipped,
 * never written as 0: a counter keeps its last value until the next event, so a made-up 0 would
 * look like a real drop.
 */

const PID = TRACE_PROCESS_ID;
/** Slice names are cut at this many characters (design/DESIGN.md: "target cut at 60 chars"). */
const NAME_TARGET_CHARS = 60;
/** Prefix of a failed slice. Perfetto ignores the `cname` colour hint, so the name carries it. */
const FAILED = "✕ ";
/** Extra threads for overlapping slices start here, so they never collide with TRACE_TID. */
const EXTRA_LANE_TID_BASE = 100;
const NETWORK_LANE_TID_BASE = 200;

export type DisplayStatus =
  | "healthy"
  | "degraded"
  | "failed"
  | "blocked"
  | "running"
  | "interrupted";

export const STATUS_WORD: Record<DisplayStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  blocked: "Blocked",
  running: "Running",
  interrupted: "Interrupted",
};

/**
 * The six display statuses (packages/db/README.md, "Display status"; the SQL there is the source of
 * truth and this must say the same).
 */
export function displayStatus(
  session: { status: string; reason: string | null },
  failedActions: number,
  issues: number,
): DisplayStatus {
  if (session.status === "running") return "running";
  if (session.status === "failed" && (session.reason ?? "") === "interrupted") return "interrupted";
  if (session.status === "success") {
    return failedActions === 0 && issues === 0 ? "healthy" : "degraded";
  }
  if (session.status === "blocked") return "blocked";
  return "failed"; // failed, timeout, crashed
}

/** At most `max` characters (not UTF-16 units, so an emoji is never cut in half), then an ellipsis. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/**
 * Overlaps up to this many milliseconds are timer rounding, not concurrency. An action's start is a
 * whole-millisecond clock reading and its duration is measured separately and rounded, so two
 * back-to-back actions of one page often "overlap" by 1 ms (seen in real sessions).
 */
export const ROUNDING_TOLERANCE_MS = 2;

/**
 * Lays slices out on lanes. A slice goes to the first lane that is free when it starts, and every
 * lane becomes a thread, because slices on one thread must nest and real ones (network requests,
 * actions of several pages) overlap. Returns, for every item in the order of `items`, its lane
 * (0, 1, ...) and the end it should be drawn with: when the previous slice of a lane overruns the
 * next one's start by rounding noise only, its drawn end is cut back to that start.
 */
export function layoutSlices(
  items: Array<{ start: number; end: number }>,
  toleranceMs = ROUNDING_TOLERANCE_MS,
): Array<{ lane: number; end: number }> {
  const order = items
    .map((_, i) => i)
    .sort((a, b) => {
      const x = items[a] as { start: number; end: number };
      const y = items[b] as { start: number; end: number };
      return x.start - y.start || x.end - y.end || a - b;
    });
  const laneLast: number[] = []; // the item that is currently last in each lane
  const placed = items.map((item) => ({ lane: 0, end: item.end }));
  for (const index of order) {
    const item = items[index] as { start: number; end: number };
    let lane = laneLast.findIndex(
      (last) => (placed[last] as { end: number }).end <= item.start + toleranceMs,
    );
    if (lane === -1) {
      lane = laneLast.length;
      laneLast.push(index);
    } else {
      const previous = placed[laneLast[lane] as number] as { end: number };
      previous.end = Math.min(previous.end, item.start);
      laneLast[lane] = index;
    }
    (placed[index] as { lane: number }).lane = lane;
  }
  return placed;
}

const ms = (value: number): number => Math.round(value) * 1000; // ms -> microseconds
const laneCount = (layout: Array<{ lane: number }>): number =>
  layout.length === 0 ? 0 : Math.max(...layout.map((slot) => slot.lane)) + 1;

export function buildTrace(timeline: SessionTimeline): ChromeTrace {
  const { session } = timeline;
  const origin = session.started_at_ms;
  /** Microseconds from the start of the session. */
  const at = (epochMs: number): number => ms(epochMs - origin);

  const failedActions = timeline.actions.filter((a) => !a.ok).length;
  const status = displayStatus(session, failedActions, timeline.issues.length);

  const events: TraceEvent[] = [];
  const meta = (
    name: "process_name" | "process_sort_index" | "thread_name" | "thread_sort_index",
    tid: number,
    args: Record<string, unknown>,
  ) => events.push({ ph: "M", name, pid: PID, tid, args });
  const thread = (tid: number, name: string, sortIndex: number) => {
    meta("thread_name", tid, { name });
    meta("thread_sort_index", tid, { sort_index: sortIndex });
  };

  const engine = session.engine_version
    ? `${session.engine} ${session.engine_version}`
    : session.engine;
  meta("process_name", 0, {
    name: `${session.session_id} · ${engine} · ${session.source === "sim" ? "SIM" : "REAL"} · ${STATUS_WORD[status]}`,
  });

  // actions ------------------------------------------------------------------------------------
  // One lane when the actions are sequential, as they are for a single page. Actions of several
  // pages can really overlap, and then they get their own threads instead of breaking the nesting.
  const actionLayout = layoutSlices(
    timeline.actions.map((a) => ({ start: a.ts_ms, end: a.ts_ms + a.duration_ms })),
  );
  const actionLaneCount = laneCount(actionLayout);
  thread(TRACE_TID.actions, "actions", 10);
  for (let lane = 1; lane < actionLaneCount; lane++) {
    thread(EXTRA_LANE_TID_BASE + lane, `actions ${lane + 1}`, 10 + lane);
  }
  timeline.actions.forEach((a, i) => {
    const { lane, end } = actionLayout[i] as { lane: number; end: number };
    events.push({
      ph: "X",
      name: `${a.ok ? "" : FAILED}${a.action_type} ${clip(a.target, NAME_TARGET_CHARS)}`.trimEnd(),
      cat: "action",
      pid: PID,
      tid: lane === 0 ? TRACE_TID.actions : EXTRA_LANE_TID_BASE + lane,
      ts: at(a.ts_ms),
      dur: ms(end - a.ts_ms),
      args: { seq: a.seq, ok: a.ok, duration_ms: a.duration_ms, error_code: a.error_code },
    });
  });

  // network ------------------------------------------------------------------------------------
  // The event is stamped when the request finished, so it started duration_ms earlier.
  const networkLayout = layoutSlices(
    timeline.requests.map((r) => ({ start: r.ts_ms - r.duration_ms, end: r.ts_ms })),
  );
  const networkLaneCount = laneCount(networkLayout);
  thread(TRACE_TID.network, "network", 20);
  for (let lane = 1; lane < networkLaneCount; lane++) {
    thread(NETWORK_LANE_TID_BASE + lane, `network ${lane + 1}`, 20 + lane);
  }
  timeline.requests.forEach((r, i) => {
    const { lane, end } = networkLayout[i] as { lane: number; end: number };
    const start = r.ts_ms - r.duration_ms;
    const failed = r.status === null || r.status >= 400;
    const label = `${r.resource_type} ${r.domain}`;
    events.push({
      ph: "X",
      name: failed ? `${FAILED}${label} ${r.status ?? "no response"}` : label,
      cat: "network",
      pid: PID,
      tid: lane === 0 ? TRACE_TID.network : NETWORK_LANE_TID_BASE + lane,
      ts: at(start),
      dur: ms(end - start),
      args: { status: r.status, bytes: r.bytes, duration_ms: r.duration_ms },
    });
  });

  // issues -------------------------------------------------------------------------------------
  thread(TRACE_TID.issues, "issues", 30);
  for (const issue of timeline.issues) {
    events.push({
      ph: "i",
      name: issue.kind,
      cat: "issue",
      pid: PID,
      tid: TRACE_TID.issues,
      ts: at(issue.ts_ms),
      s: "t",
      args: { message: issue.message },
    });
  }

  // session start and end ----------------------------------------------------------------------
  thread(TRACE_TID.session, "session", 40);
  events.push({
    ph: "i",
    name: "session started",
    cat: "session",
    pid: PID,
    tid: TRACE_TID.session,
    ts: 0,
    s: "t",
    args: {
      engine: session.engine,
      engine_version: session.engine_version,
      scenario: session.scenario,
      region: session.region,
      // before the session clock starts: container creation, and the client's connect()
      startup_ms: session.startup_ms,
      connect_ms: session.connect_ms,
    },
  });
  if (session.ended_at_ms !== null) {
    events.push({
      ph: "i",
      name: "session ended",
      cat: "session",
      pid: PID,
      tid: TRACE_TID.session,
      ts: at(session.ended_at_ms),
      s: "t",
      args: { status: session.status, reason: session.reason, duration_ms: session.duration_ms },
    });
  }

  // counters -----------------------------------------------------------------------------------
  // The counter name and its argument key together make the track name: "CPU" + "%" is "CPU %".
  const counter = (name: string, unit: string, ts: number, value: number) =>
    events.push({ ph: "C", name, pid: PID, tid: 0, ts, args: { [unit]: value } });
  let jsHeapSamples = 0;
  let jsHeapValues = 0;
  for (const sample of timeline.samples) {
    const ts = at(sample.ts_ms);
    if (sample.origin === "container") {
      if (sample.cpu_pct !== null) counter("CPU", "%", ts, sample.cpu_pct);
      if (sample.mem_mb !== null) counter("memory", "MB", ts, sample.mem_mb);
    } else {
      jsHeapSamples++;
      if (sample.js_heap_mb !== null) {
        jsHeapValues++;
        counter("JS heap", "MB", ts, sample.js_heap_mb);
      }
    }
  }
  if (jsHeapSamples > 0 && jsHeapValues === 0) {
    // A counter cannot show a gap, so say it in words instead of drawing a flat line at 0.
    events.push({
      ph: "i",
      name: "note: JS heap not available (engine reports null)",
      cat: "issue",
      pid: PID,
      tid: TRACE_TID.issues,
      ts: 0,
      s: "t",
      args: { message: "JS heap not available (engine reports null)" },
    });
  }

  return {
    traceEvents: events,
    displayTimeUnit: "ms",
    metadata: {
      generator: "fleetscope",
      session_id: session.session_id,
      source: session.source,
      agent_id: session.agent_id,
      engine: session.engine,
      engine_version: session.engine_version,
      provider: session.provider,
      scenario: session.scenario,
      region: session.region,
      status: session.status,
      display_status: status,
      reason: session.reason,
      started_at: new Date(session.started_at_ms).toISOString(),
      ended_at: session.ended_at_ms === null ? null : new Date(session.ended_at_ms).toISOString(),
      duration_ms: session.duration_ms,
      startup_ms: session.startup_ms,
      connect_ms: session.connect_ms,
      // tables that had more rows than one answer carries (a runaway session)
      truncated: timeline.truncated,
    },
  };
}
