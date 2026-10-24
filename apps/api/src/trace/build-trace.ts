import type { SessionTimeline } from "@fleetscope/db";
import { type ChromeTrace, TRACE_PROCESS_ID, TRACE_TID, type TraceEvent } from "@fleetscope/schema";

/**
 * Turns the timeline of one session into a Chrome Trace Event Format file for Perfetto. The layout
 * is specified in design/DESIGN.md section 5; this file is where it is implemented.
 *
 *   process 1  "<session id> · <engine> <version> · REAL|SIM · <status word>"
 *     thread "actions"      one slice per action (more threads "actions 2"... if they really overlap)
 *     thread "network"      one slice per request, on at most MAX_NETWORK_LANES threads
 *                           ("network", "network 2"...); see below for what happens beyond that
 *     thread "issues"       one instant per issue
 *     thread "session"      the start and the end of the session
 *     counters              "CPU %", "memory MB" (container samples), "JS heap MB" (cdp samples),
 *                           and "network in flight" when requests could not all be drawn
 *
 * Times are microseconds from the start of the session. A value that was not measured is skipped,
 * never written as 0: a counter keeps its last value until the next event, so a made-up 0 would
 * look like a real drop.
 *
 * Three rules that come from what Perfetto does with a trace (checked with its trace_processor):
 *  - Slices on one thread must nest. Partly overlapping ones are not dropped but silently CLIPPED
 *    to their parent's end (`slice_spill_overlapping_complete_event`), so overlapping requests need
 *    one thread each. Chrome's async events do not help: every id gets a track of its own, and
 *    overlapping slices of one id are matched last-in-first-out, with wrong durations.
 *  - A thread track is as tall as its thread list is long. A heavy page has dozens of requests in
 *    flight at once, and 40 network threads pushed the counters 1,000 px down the screen. So the
 *    network gets at most MAX_NETWORK_LANES threads. Requests that fail come first, then the
 *    slowest; a request that finds every lane busy is NOT drawn. That is said on the track (an instant "note: N of M requests not drawn"), in the
 *    metadata, and the real concurrency is kept as the "network in flight" counter. The full list
 *    of requests is in the Network table of the Session detail dashboard.
 *  - A negative `ts` is silently dropped by trace_processor. An event stamped before the session
 *    started (a request that began earlier, clock skew) is moved to 0, keeps its end, and records the
 *    original offset in `args.ms_before_session_start` (counters have no args: they are counted in
 *    the metadata).
 */

const PID = TRACE_PROCESS_ID;
/** Slice names are cut at this many characters (design/DESIGN.md: "target cut at 60 chars"). */
const NAME_TARGET_CHARS = 60;
/** Prefix of a failed slice. Perfetto ignores the `cname` colour hint, so the name carries it. */
const FAILED = "✕ ";
/** Extra threads for overlapping slices start here, so they never collide with TRACE_TID. */
const EXTRA_LANE_TID_BASE = 100;
const NETWORK_LANE_TID_BASE = 200;
/** The most threads the network gets (see the header comment: it keeps the timeline short). */
export const MAX_NETWORK_LANES = 6;
/**
 * Where each group of tracks sorts. Every group has a range of its own, so the tracks stay in the
 * order of design/DESIGN.md (actions, network, issues, session) however many lanes a group has.
 */
const SORT_INDEX = { actions: 1000, network: 2000, issues: 3000, session: 4000 } as const;

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

/**
 * Like `layoutSlices`, but with a fixed number of lanes, for slices that cannot all be drawn. The
 * slices get a lane in the order of `priority` (indexes into `items`, most important first): each
 * takes the first lane where it overlaps nothing already placed by more than the rounding tolerance.
 * A slice that fits no lane gets lane -1 and is not placed. Afterwards a slice that runs into the
 * next one of its lane by rounding noise only is cut back to that start, as in `layoutSlices`.
 */
export function layoutCapped(
  items: Array<{ start: number; end: number }>,
  priority: number[],
  maxLanes: number,
  toleranceMs = ROUNDING_TOLERANCE_MS,
): Array<{ lane: number; end: number }> {
  const placed = items.map((item) => ({ lane: -1, end: item.end }));
  // the slices of each lane, kept in time order; none conflicts with its neighbours
  const lanes: number[][] = Array.from({ length: maxLanes }, () => []);
  // Two slices conflict when each starts before the other has ended, by more than the tolerance. A
  // point strictly inside a slice therefore conflicts with it, and slices that only touch do not.
  const conflict = (a: number, b: number): boolean => {
    const x = items[a] as { start: number; end: number };
    const y = items[b] as { start: number; end: number };
    return x.start < y.end - toleranceMs && y.start < x.end - toleranceMs;
  };
  // x sorts before y: earlier start first, and at the same start the shorter one first
  const sortsBefore = (a: number, b: number): boolean => {
    const x = items[a] as { start: number; end: number };
    const y = items[b] as { start: number; end: number };
    return x.start < y.start || (x.start === y.start && x.end <= y.end);
  };
  for (const index of priority) {
    for (let lane = 0; lane < maxLanes; lane++) {
      const members = lanes[lane] as number[];
      // where this slice would go in the lane, found by bisection
      let low = 0;
      let high = members.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (sortsBefore(members[mid] as number, index)) low = mid + 1;
        else high = mid;
      }
      const before = low > 0 ? (members[low - 1] as number) : null;
      const after = low < members.length ? (members[low] as number) : null;
      if (
        (before !== null && conflict(before, index)) ||
        (after !== null && conflict(after, index))
      ) {
        continue;
      }
      members.splice(low, 0, index);
      (placed[index] as { lane: number }).lane = lane;
      break;
    }
  }
  for (const members of lanes) {
    for (let i = 0; i + 1 < members.length; i++) {
      const current = placed[members[i] as number] as { end: number };
      const nextStart = (items[members[i + 1] as number] as { start: number }).start;
      current.end = Math.min(current.end, nextStart);
    }
  }
  return placed;
}

const ms = (value: number): number => Math.round(value) * 1000; // ms -> microseconds
const laneCount = (layout: Array<{ lane: number }>): number =>
  layout.reduce((count, slot) => Math.max(count, slot.lane + 1), 0);

/**
 * How many of the intervals are open at each moment where that number changes: the concurrency
 * that the capped network lanes cannot show. Intervals that only touch do not add up, and an empty
 * interval is never "in flight".
 */
export function inFlight(
  intervals: Array<{ start: number; end: number }>,
): Array<{ at: number; count: number }> {
  const changes = new Map<number, number>();
  for (const { start, end } of intervals) {
    if (end <= start) continue;
    changes.set(start, (changes.get(start) ?? 0) + 1);
    changes.set(end, (changes.get(end) ?? 0) - 1);
  }
  let count = 0;
  return [...changes.keys()]
    .sort((a, b) => a - b)
    .map((at) => {
      count += changes.get(at) as number;
      return { at, count };
    });
}

export function buildTrace(timeline: SessionTimeline): ChromeTrace {
  const { session } = timeline;
  const origin = session.started_at_ms;
  /** Events moved to the start of the session because they were stamped before it. */
  const early = { events: 0, maxMs: 0 };
  /** How many ms before the session start `epochMs` is (0 when it is not), counting the event. */
  const msBefore = (epochMs: number): number => {
    const before = origin - epochMs;
    if (before <= 0) return 0;
    early.events++;
    early.maxMs = Math.max(early.maxMs, before);
    return before;
  };
  /** Epoch ms, but never before the start of the session. */
  const clamp = (epochMs: number): number => Math.max(epochMs, origin);
  /** Microseconds from the start of the session, never negative. */
  const at = (epochMs: number): number => ms(clamp(epochMs) - origin);

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
    timeline.actions.map((a) => ({ start: clamp(a.ts_ms), end: clamp(a.ts_ms + a.duration_ms) })),
  );
  const actionLaneCount = laneCount(actionLayout);
  thread(TRACE_TID.actions, "actions", SORT_INDEX.actions);
  for (let lane = 1; lane < actionLaneCount; lane++) {
    thread(EXTRA_LANE_TID_BASE + lane, `actions ${lane + 1}`, SORT_INDEX.actions + lane);
  }
  timeline.actions.forEach((a, i) => {
    const { lane, end } = actionLayout[i] as { lane: number; end: number };
    const before = msBefore(a.ts_ms);
    events.push({
      ph: "X",
      name: `${a.ok ? "" : FAILED}${a.action_type} ${clip(a.target, NAME_TARGET_CHARS)}`.trimEnd(),
      cat: "action",
      pid: PID,
      tid: lane === 0 ? TRACE_TID.actions : EXTRA_LANE_TID_BASE + lane,
      ts: at(a.ts_ms),
      dur: ms(end - clamp(a.ts_ms)),
      args: {
        seq: a.seq,
        ok: a.ok,
        duration_ms: a.duration_ms,
        error_code: a.error_code,
        ...(before > 0 && { ms_before_session_start: before }),
      },
    });
  });

  // network ------------------------------------------------------------------------------------
  // The event is stamped when the request finished, so it started duration_ms earlier.
  const networkSpans = timeline.requests.map((r) => ({
    start: clamp(r.ts_ms - r.duration_ms),
    end: clamp(r.ts_ms),
  }));
  // Which requests get a lane when there are too many: the ones that failed, then the slowest. A fast
  // image can go missing from the timeline; a failure or a stall must not.
  const isFailed = (r: { status: number | null }): boolean => r.status === null || r.status >= 400;
  const byImportance = timeline.requests
    .map((_, i) => i)
    .sort((a, b) => {
      const x = timeline.requests[a] as (typeof timeline.requests)[number];
      const y = timeline.requests[b] as (typeof timeline.requests)[number];
      return (
        Number(isFailed(y)) - Number(isFailed(x)) ||
        y.duration_ms - x.duration_ms ||
        x.ts_ms - y.ts_ms ||
        a - b
      );
    });
  const networkLayout = layoutCapped(networkSpans, byImportance, MAX_NETWORK_LANES);
  const networkLaneCount = laneCount(networkLayout);
  thread(TRACE_TID.network, "network", SORT_INDEX.network);
  for (let lane = 1; lane < networkLaneCount; lane++) {
    thread(NETWORK_LANE_TID_BASE + lane, `network ${lane + 1}`, SORT_INDEX.network + lane);
  }
  let networkDrawn = 0;
  timeline.requests.forEach((r, i) => {
    const { lane, end } = networkLayout[i] as { lane: number; end: number };
    const span = networkSpans[i] as { start: number; end: number };
    if (lane === -1) return; // every lane was busy: counted below, not drawn
    networkDrawn++;
    const before = msBefore(r.ts_ms - r.duration_ms);
    const failed = isFailed(r);
    const label = `${r.resource_type} ${r.domain}`;
    events.push({
      ph: "X",
      name: failed ? `${FAILED}${label} ${r.status ?? "no response"}` : label,
      cat: "network",
      pid: PID,
      tid: lane === 0 ? TRACE_TID.network : NETWORK_LANE_TID_BASE + lane,
      ts: ms(span.start - origin),
      dur: ms(end - span.start),
      args: {
        status: r.status,
        bytes: r.bytes,
        duration_ms: r.duration_ms,
        ...(before > 0 && { ms_before_session_start: before }),
      },
    });
  });
  const concurrency = inFlight(networkSpans);
  const maxInFlight = concurrency.reduce((max, point) => Math.max(max, point.count), 0);
  const networkNotDrawn = timeline.requests.length - networkDrawn;

  // issues -------------------------------------------------------------------------------------
  thread(TRACE_TID.issues, "issues", SORT_INDEX.issues);
  for (const issue of timeline.issues) {
    const before = msBefore(issue.ts_ms);
    events.push({
      ph: "i",
      name: issue.kind,
      cat: "issue",
      pid: PID,
      tid: TRACE_TID.issues,
      ts: at(issue.ts_ms),
      s: "t",
      args: { message: issue.message, ...(before > 0 && { ms_before_session_start: before }) },
    });
  }

  // session start and end ----------------------------------------------------------------------
  thread(TRACE_TID.session, "session", SORT_INDEX.session);
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
    msBefore(sample.ts_ms); // a counter has no args: moved to 0 and counted in the metadata
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

  if (networkNotDrawn > 0) {
    // The slices that fit are on the network threads; the concurrency of ALL requests is this counter.
    for (const point of concurrency) counter("network", "in flight", at(point.at), point.count);
    const message = `${networkNotDrawn} of ${timeline.requests.length} requests are not drawn: more than ${MAX_NETWORK_LANES} were in flight at once (up to ${maxInFlight}). See "network in flight".`;
    events.push({
      ph: "i",
      name: `note: ${networkNotDrawn} of ${timeline.requests.length} requests not drawn`,
      cat: "network",
      pid: PID,
      tid: TRACE_TID.network,
      ts: 0,
      s: "t",
      args: {
        message,
        requests: timeline.requests.length,
        drawn: networkDrawn,
        lanes: MAX_NETWORK_LANES,
        max_in_flight: maxInFlight,
      },
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
      network: {
        requests: timeline.requests.length,
        drawn: networkDrawn,
        not_drawn: networkNotDrawn,
        lanes: MAX_NETWORK_LANES,
        max_in_flight: maxInFlight,
      },
      // events stamped before the session started, moved to 0 (see the header comment)
      before_session_start: { events: early.events, max_ms: early.maxMs },
    },
  };
}
