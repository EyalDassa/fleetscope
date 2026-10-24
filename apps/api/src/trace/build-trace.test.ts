import type { SessionTimeline, TimelineSession } from "@fleetscope/db";
import { ChromeTrace, type TraceEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import {
  buildTrace,
  displayStatus,
  inFlight,
  layoutCapped,
  layoutSlices,
  MAX_NETWORK_LANES,
  ROUNDING_TOLERANCE_MS,
} from "./build-trace";

const START = Date.UTC(2026, 9, 24, 10, 0, 0);

function session(overrides: Partial<TimelineSession> = {}): TimelineSession {
  return {
    session_id: "sess-abcdef12-3456",
    agent_id: "agent-1",
    source: "real",
    engine: "chromium",
    engine_version: "141.0",
    provider: "local-docker",
    scenario: "login-and-search",
    region: "local",
    startup_ms: 900,
    connect_ms: 400,
    routed_from: null,
    status: "success",
    started_at_ms: START,
    ended_at_ms: START + 5000,
    duration_ms: 5000,
    reason: null,
    ...overrides,
  };
}

function timeline(overrides: Partial<SessionTimeline> = {}): SessionTimeline {
  return {
    session: session(),
    actions: [
      {
        seq: 0,
        ts_ms: START + 100,
        action_type: "goto",
        target: "demo.test/login",
        duration_ms: 800,
        ok: true,
        error_code: null,
      },
      {
        seq: 1,
        ts_ms: START + 1000,
        action_type: "click",
        target: "#submit",
        duration_ms: 3000,
        ok: false,
        error_code: "timeout",
      },
    ],
    samples: [
      { ts_ms: START + 2000, origin: "container", cpu_pct: 12.5, mem_mb: 210, js_heap_mb: null },
      { ts_ms: START + 4000, origin: "container", cpu_pct: 30, mem_mb: 230, js_heap_mb: null },
      { ts_ms: START + 3000, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: 38 },
    ],
    requests: [
      {
        ts_ms: START + 600,
        domain: "demo.test",
        status: 200,
        bytes: 1234,
        duration_ms: 400,
        resource_type: "document",
      },
    ],
    issues: [{ ts_ms: START + 4100, kind: "timeout", message: "waiting for #submit" }],
    truncated: [],
    ...overrides,
  };
}

type Kind<P extends TraceEvent["ph"]> = Extract<TraceEvent, { ph: P }>;
/** The events of one kind, typed as that kind (a counter has no `cat`, metadata has no `ts`). */
const named = <P extends TraceEvent["ph"]>(events: TraceEvent[], ph: P): Array<Kind<P>> =>
  events.filter((e): e is Kind<P> => e.ph === ph);

describe("buildTrace", () => {
  it("produces a valid Chrome trace (the shared zod schema accepts it)", () => {
    const trace = buildTrace(timeline());
    expect(() => ChromeTrace.parse(trace)).not.toThrow();
    expect(trace.displayTimeUnit).toBe("ms");
    // and it survives a round trip through JSON, which is how Perfetto receives it
    expect(ChromeTrace.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
  });

  it("names the process after the session: id, engine and version, REAL or SIM, status word", () => {
    const [process] = named(buildTrace(timeline()).traceEvents, "M").filter(
      (e) => e.name === "process_name",
    );
    // success, but one action failed and an issue was raised: Degraded
    expect(process?.args).toEqual({
      name: "sess-abcdef12-3456 · chromium 141.0 · REAL · Degraded",
    });
  });

  it("writes microseconds from the start of the session, one X slice per action", () => {
    const slices = named(buildTrace(timeline()).traceEvents, "X").filter((e) => e.cat === "action");
    expect(slices).toEqual([
      {
        ph: "X",
        name: "goto demo.test/login",
        cat: "action",
        pid: 1,
        tid: 1,
        ts: 100_000,
        dur: 800_000,
        args: { seq: 0, ok: true, duration_ms: 800, error_code: null },
      },
      {
        ph: "X",
        name: "✕ click #submit",
        cat: "action",
        pid: 1,
        tid: 1,
        ts: 1_000_000,
        dur: 3_000_000,
        args: { seq: 1, ok: false, duration_ms: 3000, error_code: "timeout" },
      },
    ]);
  });

  it("does not use cname: Perfetto ignores it, so a failed slice is marked in its name", () => {
    const json = JSON.stringify(buildTrace(timeline()));
    expect(json).not.toContain("cname");
  });

  it("names the counter tracks CPU %, memory MB and JS heap MB, and skips nulls", () => {
    const counters = named(buildTrace(timeline()).traceEvents, "C");
    const track = (e: TraceEvent) => {
      if (e.ph !== "C") return "";
      const [unit] = Object.keys(e.args);
      return `${e.name} ${unit}`;
    };
    expect([...new Set(counters.map(track))].sort()).toEqual(["CPU %", "JS heap MB", "memory MB"]);
    const cpu = named(counters, "C").filter((e) => e.name === "CPU");
    expect(cpu.map((e) => [e.ts, e.args["%"]])).toEqual([
      [2_000_000, 12.5],
      [4_000_000, 30],
    ]);
    const heap = named(counters, "C").filter((e) => e.name === "JS heap");
    expect(heap.map((e) => e.args.MB)).toEqual([38]);
  });

  it("never writes a counter for a value that was not measured", () => {
    const trace = buildTrace(
      timeline({
        samples: [
          { ts_ms: START + 1000, origin: "container", cpu_pct: null, mem_mb: 50, js_heap_mb: null },
          { ts_ms: START + 2000, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: null },
        ],
      }),
    );
    const counters = named(trace.traceEvents, "C");
    expect(counters).toHaveLength(1); // only the memory value
    expect(counters[0]).toMatchObject({ name: "memory", args: { MB: 50 } });
  });

  it("says in words when the engine reports no JS heap, instead of drawing a track", () => {
    const trace = buildTrace(
      timeline({
        samples: [
          { ts_ms: START + 1000, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: null },
          { ts_ms: START + 3000, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: null },
        ],
      }),
    );
    expect(named(trace.traceEvents, "C")).toEqual([]);
    const note = named(trace.traceEvents, "i").find((e) => e.name.startsWith("note:"));
    expect(note).toMatchObject({
      name: "note: JS heap not available (engine reports null)",
      tid: 3,
      ts: 0,
    });
  });

  it("adds no JS heap note when there are no cdp samples at all", () => {
    const trace = buildTrace(timeline({ samples: [] }));
    expect(named(trace.traceEvents, "i").some((e) => e.name.startsWith("note:"))).toBe(false);
  });

  it("puts issues on the issues track as thread instants", () => {
    const issues = named(buildTrace(timeline()).traceEvents, "i").filter((e) => e.cat === "issue");
    expect(issues).toEqual([
      {
        ph: "i",
        name: "timeout",
        cat: "issue",
        pid: 1,
        tid: 3,
        ts: 4_100_000,
        s: "t",
        args: { message: "waiting for #submit" },
      },
    ]);
  });

  it("marks the start and the end of the session", () => {
    const markers = named(buildTrace(timeline()).traceEvents, "i").filter(
      (e) => e.cat === "session",
    );
    expect(markers.map((m) => [m.name, m.ts])).toEqual([
      ["session started", 0],
      ["session ended", 5_000_000],
    ]);
    expect(markers[1]?.args).toMatchObject({ status: "success", duration_ms: 5000 });
    expect(markers[0]?.args).toMatchObject({ startup_ms: 900, connect_ms: 400 });
  });

  it("has no end marker for a session that is still running", () => {
    const trace = buildTrace(
      timeline({ session: session({ status: "running", ended_at_ms: null, duration_ms: null }) }),
    );
    expect(named(trace.traceEvents, "i").map((e) => e.name)).not.toContain("session ended");
  });

  it("names every track with thread_name metadata", () => {
    const names = named(buildTrace(timeline()).traceEvents, "M").filter(
      (e) => e.name === "thread_name",
    );
    expect(names.map((e) => [e.tid, e.args.name])).toEqual([
      [1, "actions"],
      [2, "network"],
      [3, "issues"],
      [4, "session"],
    ]);
  });

  it("starts a network request when it started, not when it finished", () => {
    // the event is stamped at the end of the request (START+600) and took 400 ms
    const [request] = named(buildTrace(timeline()).traceEvents, "X").filter(
      (e) => e.cat === "network",
    );
    expect(request).toMatchObject({
      name: "document demo.test",
      tid: 2,
      ts: 200_000,
      dur: 400_000,
      args: { status: 200, bytes: 1234, duration_ms: 400 },
    });
  });

  it("marks a failed request in its name: status null or 400 and up", () => {
    const trace = buildTrace(
      timeline({
        requests: [
          {
            ts_ms: START + 500,
            domain: "a.test",
            status: null,
            bytes: null,
            duration_ms: 100,
            resource_type: "xhr",
          },
          {
            ts_ms: START + 900,
            domain: "b.test",
            status: 403,
            bytes: 10,
            duration_ms: 100,
            resource_type: "document",
          },
          {
            ts_ms: START + 1500,
            domain: "c.test",
            status: 200,
            bytes: 10,
            duration_ms: 100,
            resource_type: "image",
          },
        ],
      }),
    );
    expect(
      named(trace.traceEvents, "X")
        .filter((e) => e.cat === "network")
        .map((e) => e.name),
    ).toEqual(["✕ xhr a.test no response", "✕ document b.test 403", "image c.test"]);
  });

  it("puts overlapping requests on their own threads so slices still nest", () => {
    const trace = buildTrace(
      timeline({
        requests: [
          {
            ts_ms: START + 1000,
            domain: "a.test",
            status: 200,
            bytes: 1,
            duration_ms: 800,
            resource_type: "script",
          },
          {
            ts_ms: START + 1200,
            domain: "b.test",
            status: 200,
            bytes: 1,
            duration_ms: 800,
            resource_type: "script",
          },
          {
            ts_ms: START + 2200,
            domain: "c.test",
            status: 200,
            bytes: 1,
            duration_ms: 100,
            resource_type: "script",
          },
        ],
      }),
    );
    const requests = named(trace.traceEvents, "X").filter((e) => e.cat === "network");
    // a: 200-1000, b: 400-1200 (overlaps a), c: 2100-2200 (free again, back on the first thread)
    expect(requests.map((e) => [e.name, e.tid])).toEqual([
      ["script a.test", 2],
      ["script b.test", 201],
      ["script c.test", 2],
    ]);
    const threads = named(trace.traceEvents, "M").filter((e) => e.name === "thread_name");
    expect(threads.map((e) => e.args.name)).toContain("network 2");
  });

  it("keeps actions on one thread when they are sequential, and splits them only when they overlap", () => {
    const sequential = buildTrace(timeline());
    expect(
      sequential.traceEvents.filter((e) => e.name === "thread_name").map((e) => e.args.name),
    ).not.toContain("actions 2");

    const overlapping = buildTrace(
      timeline({
        actions: [
          {
            seq: 0,
            ts_ms: START + 100,
            action_type: "goto",
            target: "a",
            duration_ms: 1000,
            ok: true,
            error_code: null,
          },
          {
            seq: 1,
            ts_ms: START + 500,
            action_type: "goto",
            target: "b",
            duration_ms: 1000,
            ok: true,
            error_code: null,
          },
        ],
      }),
    );
    expect(
      named(overlapping.traceEvents, "X")
        .filter((e) => e.cat === "action")
        .map((e) => [e.name, e.tid]),
    ).toEqual([
      ["goto a", 1],
      ["goto b", 101],
    ]);
  });

  it("does not split actions that only overlap by a millisecond of timer rounding (real sessions do)", () => {
    const trace = buildTrace(
      timeline({
        actions: [
          {
            seq: 0,
            ts_ms: START + 222,
            action_type: "fill",
            target: "#user",
            duration_ms: 26,
            ok: true,
            error_code: null,
          },
          {
            seq: 1,
            ts_ms: START + 247,
            action_type: "fill",
            target: "#pass",
            duration_ms: 26,
            ok: true,
            error_code: null,
          },
        ],
      }),
    );
    const actions = named(trace.traceEvents, "X").filter((e) => e.cat === "action");
    expect(actions.map((e) => e.tid)).toEqual([1, 1]);
    // the first slice is drawn up to where the second starts; its args keep what was measured
    expect(actions[0]).toMatchObject({ ts: 222_000, dur: 25_000, args: { duration_ms: 26 } });
    expect(actions[1]).toMatchObject({ ts: 247_000, dur: 26_000 });
  });

  it("cuts a long target at 60 characters without splitting an emoji", () => {
    const target = `${"x".repeat(59)}😀${"y".repeat(20)}`;
    const [slice] = named(
      buildTrace(
        timeline({
          actions: [
            {
              seq: 0,
              ts_ms: START,
              action_type: "goto",
              target,
              duration_ms: 1,
              ok: true,
              error_code: null,
            },
          ],
        }),
      ).traceEvents,
      "X",
    ).filter((e) => e.cat === "action");
    expect(slice?.name).toBe(`goto ${"x".repeat(59)}😀…`);
    expect(JSON.stringify(slice)).not.toMatch(/\\ud[89ab]/i); // no lone surrogate escape
  });

  it("labels a simulated session SIM in the process name", () => {
    const trace = buildTrace(
      timeline({ session: session({ source: "sim", engine_version: null }) }),
    );
    const process = named(trace.traceEvents, "M").find((e) => e.name === "process_name");
    expect(process?.args.name).toBe("sess-abcdef12-3456 · chromium · SIM · Degraded");
  });

  it("says in the process name that a session was routed, and from which engine", () => {
    const name = (overrides: Partial<TimelineSession>) =>
      named(buildTrace(timeline({ session: session(overrides) })).traceEvents, "M").find(
        (e) => e.name === "process_name",
      )?.args.name;
    expect(
      name({ engine: "chrome-headless-shell", engine_version: null, routed_from: "lightpanda" }),
    ).toBe("sess-abcdef12-3456 · chrome-headless-shell (routed from lightpanda) · REAL · Degraded");
    expect(name({})).not.toContain("routed");
  });

  it("copies the session facts into metadata, and lists truncated tables", () => {
    const trace = buildTrace(timeline({ truncated: ["network_requests"] }));
    expect(trace.metadata).toMatchObject({
      generator: "fleetscope",
      session_id: "sess-abcdef12-3456",
      engine: "chromium",
      status: "success",
      display_status: "degraded",
      started_at: "2026-10-24T10:00:00.000Z",
      ended_at: "2026-10-24T10:00:05.000Z",
      duration_ms: 5000,
      truncated: ["network_requests"],
    });
  });

  it("builds a valid, nearly empty trace for a session with no events at all", () => {
    const trace = buildTrace({
      session: session({ status: "running", ended_at_ms: null, duration_ms: null }),
      actions: [],
      samples: [],
      requests: [],
      issues: [],
      truncated: [],
    });
    expect(() => ChromeTrace.parse(trace)).not.toThrow();
    expect(named(trace.traceEvents, "X")).toEqual([]);
    expect(named(trace.traceEvents, "C")).toEqual([]);
  });
});

describe("displayStatus (the rule in packages/db/README.md)", () => {
  it.each([
    [{ status: "running", reason: null }, 0, 0, "running"],
    [{ status: "failed", reason: "interrupted" }, 1, 0, "interrupted"],
    [{ status: "success", reason: null }, 0, 0, "healthy"],
    [{ status: "success", reason: null }, 1, 0, "degraded"],
    [{ status: "success", reason: null }, 0, 2, "degraded"],
    [{ status: "blocked", reason: "bot wall" }, 0, 1, "blocked"],
    [{ status: "failed", reason: "boom" }, 0, 0, "failed"],
    [{ status: "failed", reason: null }, 0, 0, "failed"],
    [{ status: "timeout", reason: "60s" }, 0, 0, "failed"],
    [{ status: "crashed", reason: "browser disconnected" }, 0, 0, "failed"],
  ] as const)("%j with %i failed actions and %i issues is %s", (row, failed, issues, expected) => {
    expect(displayStatus(row, failed, issues)).toBe(expected);
  });
});

describe("layoutSlices", () => {
  const lanes = (items: Array<{ start: number; end: number }>, tolerance = 0) =>
    layoutSlices(items, tolerance).map((slot) => slot.lane);

  it("reuses a lane as soon as it is free and opens a new one when slices overlap", () => {
    expect(
      lanes([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 10, end: 20 },
        { start: 12, end: 13 },
      ]),
    ).toEqual([0, 1, 0, 2]);
  });

  it("is stable for identical slices and does not depend on the input order", () => {
    expect(
      lanes([
        { start: 0, end: 5 },
        { start: 0, end: 5 },
      ]),
    ).toEqual([0, 1]);
    expect(
      lanes([
        { start: 5, end: 9 },
        { start: 0, end: 6 },
      ]),
    ).toEqual([1, 0]);
    expect(lanes([])).toEqual([]);
  });

  it("treats an overlap within the tolerance as rounding: same lane, previous end cut back", () => {
    const layout = layoutSlices(
      [
        { start: 0, end: 101 },
        { start: 100, end: 150 },
      ],
      2,
    );
    expect(layout).toEqual([
      { lane: 0, end: 100 },
      { lane: 0, end: 150 },
    ]);
  });

  it("starts a new lane for an overlap above the tolerance, and leaves both ends alone", () => {
    const layout = layoutSlices(
      [
        { start: 0, end: 105 },
        { start: 100, end: 150 },
      ],
      ROUNDING_TOLERANCE_MS,
    );
    expect(layout).toEqual([
      { lane: 0, end: 105 },
      { lane: 1, end: 150 },
    ]);
  });
});

describe("layoutCapped", () => {
  const items = [
    { start: 0, end: 100 },
    { start: 10, end: 100 },
    { start: 20, end: 100 },
    { start: 100, end: 150 },
  ];

  it("gives lanes in the order of the priority, and leaves a slice out when no lane is free", () => {
    // items 0 and 1 first, then 2 does not fit in two lanes, then 3 is free again
    expect(layoutCapped(items, [0, 1, 2, 3], 2, 0).map((slot) => slot.lane)).toEqual([0, 1, -1, 0]);
    // the same slices, but the one that did not fit comes first: now another one is left out
    expect(layoutCapped(items, [2, 1, 0, 3], 2, 0).map((slot) => slot.lane)).toEqual([-1, 1, 0, 0]);
  });

  it("does not let a slice that was left out cut anyone's end", () => {
    const layout = layoutCapped(items, [0, 1, 2, 3], 2, 0);
    expect(layout.map((slot) => slot.end)).toEqual([100, 100, 100, 150]);
  });

  it("puts slices into the first lane that has room, also when they come in the wrong order", () => {
    const layout = layoutCapped(
      [
        { start: 100, end: 200 },
        { start: 0, end: 100 },
        { start: 50, end: 150 },
      ],
      [0, 1, 2],
      3,
      0,
    );
    // 0 takes lane 0; 1 only touches it, so it joins lane 0 before it; 2 overlaps both
    expect(layout.map((slot) => slot.lane)).toEqual([0, 0, 1]);
  });

  it("treats an overlap within the tolerance as rounding and cuts the earlier slice back", () => {
    const layout = layoutCapped(
      [
        { start: 0, end: 101 },
        { start: 100, end: 150 },
      ],
      [0, 1],
      1,
      2,
    );
    expect(layout).toEqual([
      { lane: 0, end: 100 },
      { lane: 0, end: 150 },
    ]);
  });
});

describe("inFlight", () => {
  it("counts the open intervals at each change, and lets intervals that only touch not add up", () => {
    expect(
      inFlight([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([
      { at: 0, count: 1 },
      { at: 5, count: 2 },
      { at: 10, count: 2 }, // one ends and one starts at 10
      { at: 15, count: 1 },
      { at: 20, count: 0 },
    ]);
  });

  it("ignores empty intervals", () => {
    expect(inFlight([{ start: 3, end: 3 }])).toEqual([]);
    expect(inFlight([])).toEqual([]);
  });
});

describe("a heavy page: many requests in flight at once", () => {
  // 30 requests that all run from +1000 ms to +5000 ms, like the demo site's /heavy page
  const heavy = (count = 30) =>
    timeline({
      requests: Array.from({ length: count }, (_, i) => ({
        ts_ms: START + 5000 + i, // finished one ms apart
        domain: `img${i}.test`,
        status: 200,
        bytes: 100,
        duration_ms: 4000,
        resource_type: "image",
      })),
    });
  const threadNames = (trace: ReturnType<typeof buildTrace>) =>
    named(trace.traceEvents, "M")
      .filter((e) => e.name === "thread_name")
      .map((e) => String(e.args.name));

  it(`uses at most ${MAX_NETWORK_LANES} network threads, however many requests overlap`, () => {
    const trace = buildTrace(heavy());
    expect(threadNames(trace).filter((n) => n.startsWith("network"))).toEqual([
      "network",
      "network 2",
      "network 3",
      "network 4",
      "network 5",
      "network 6",
    ]);
    expect(named(trace.traceEvents, "X").filter((e) => e.cat === "network")).toHaveLength(
      MAX_NETWORK_LANES,
    );
  });

  it("says so on the network track, and keeps the real concurrency as a counter", () => {
    const trace = buildTrace(heavy());
    const note = named(trace.traceEvents, "i").find((e) => e.name.startsWith("note: "));
    expect(note).toMatchObject({
      name: "note: 24 of 30 requests not drawn",
      tid: 2,
      ts: 0,
      args: { requests: 30, drawn: 6, lanes: 6, max_in_flight: 30 },
    });
    expect(String(note?.args.message)).toContain('"network in flight"');

    const track = named(trace.traceEvents, "C").filter((e) => e.name === "network");
    expect(track.every((e) => Object.keys(e.args).join() === "in flight")).toBe(true); // "network in flight"
    const values = track.map((e) => e.args["in flight"] as number);
    expect(Math.max(...values)).toBe(30);
    expect(values.at(-1)).toBe(0); // everything has finished at the end
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
  });

  it("draws the failed requests first, then the slowest, when they cannot all be drawn", () => {
    // 10 requests in flight at once: 8 fine and fast (100 ms .. 800 ms), 1 slow, 1 failed and fast
    const at = (i: number, over: Partial<SessionTimeline["requests"][number]>) => ({
      ts_ms: START + 2000 + i,
      domain: `r${i}.test`,
      status: 200,
      bytes: 1,
      duration_ms: 100 * (i + 1),
      resource_type: "image",
      ...over,
    });
    const requests = [
      ...Array.from({ length: 8 }, (_, i) => at(i, {})),
      at(8, { duration_ms: 1900, domain: "slow.test" }),
      at(9, { duration_ms: 50, domain: "broken.test", status: null }),
    ];
    const names = named(buildTrace(timeline({ requests })).traceEvents, "X")
      .filter((e) => e.cat === "network")
      .map((e) => e.name)
      .sort();
    // 6 lanes: the failed one, the slow one and the four next slowest (r7, r6, r5, r4), no fast ones
    expect(names).toEqual(
      [
        "✕ image broken.test no response",
        "image slow.test",
        "image r7.test",
        "image r6.test",
        "image r5.test",
        "image r4.test",
      ].sort(),
    );
  });

  it("records the counts in the metadata", () => {
    expect(buildTrace(heavy()).metadata.network).toEqual({
      requests: 30,
      drawn: 6,
      not_drawn: 24,
      lanes: 6,
      max_in_flight: 30,
    });
  });

  it("adds neither the counter nor the note when every request fits", () => {
    const trace = buildTrace(heavy(6));
    expect(named(trace.traceEvents, "C").filter((e) => e.name === "network")).toEqual([]);
    expect(named(trace.traceEvents, "i").some((e) => e.name.startsWith("note: "))).toBe(false);
    expect(trace.metadata.network).toMatchObject({ requests: 6, drawn: 6, not_drawn: 0 });
  });

  it("draws a request again once a lane is free", () => {
    const requests = [
      ...heavy(8).requests, // 8 at once: 6 drawn, 2 not
      // one more, long after the others finished
      {
        ts_ms: START + 9000,
        domain: "late.test",
        status: 200,
        bytes: 1,
        duration_ms: 100,
        resource_type: "script",
      },
    ];
    const trace = buildTrace(timeline({ requests }));
    const names = named(trace.traceEvents, "X")
      .filter((e) => e.cat === "network")
      .map((e) => e.name);
    expect(names).toContain("script late.test");
    expect(trace.metadata.network).toMatchObject({ requests: 9, drawn: 7, not_drawn: 2 });
  });

  it("sorts the tracks actions, network, issues, session with a range for each, all different", () => {
    const trace = buildTrace(
      timeline({ ...heavy(), issues: [{ ts_ms: START + 10, kind: "captcha", message: "x" }] }),
    );
    const sortIndex = new Map(
      named(trace.traceEvents, "M")
        .filter((e) => e.name === "thread_sort_index")
        .map((e) => [e.tid, e.args.sort_index as number]),
    );
    const nameOf = new Map(
      named(trace.traceEvents, "M")
        .filter((e) => e.name === "thread_name")
        .map((e) => [e.tid, String(e.args.name)]),
    );
    const order = [...sortIndex.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([tid]) => nameOf.get(tid));
    expect(order).toEqual([
      "actions",
      "network",
      "network 2",
      "network 3",
      "network 4",
      "network 5",
      "network 6",
      "issues",
      "session",
    ]);
    expect(new Set(sortIndex.values()).size).toBe(sortIndex.size);
  });
});

describe("events stamped before the session started", () => {
  const early = () =>
    buildTrace(
      timeline({
        actions: [],
        requests: [
          // started 400 ms before the session, finished 100 ms after it began
          {
            ts_ms: START + 100,
            domain: "d.test",
            status: 200,
            bytes: 1,
            duration_ms: 500,
            resource_type: "document",
          },
          // finished before the session began: nothing of it is inside the session
          {
            ts_ms: START - 50,
            domain: "e.test",
            status: 200,
            bytes: 1,
            duration_ms: 100,
            resource_type: "image",
          },
        ],
        issues: [{ ts_ms: START - 200, kind: "captcha", message: "early" }],
        samples: [
          { ts_ms: START - 1000, origin: "container", cpu_pct: 5, mem_mb: 50, js_heap_mb: null },
          { ts_ms: START + 1000, origin: "container", cpu_pct: 6, mem_mb: 51, js_heap_mb: null },
        ],
      }),
    );

  it("never writes a negative timestamp (Perfetto drops those silently)", () => {
    const negatives = early().traceEvents.filter((e) => "ts" in e && e.ts < 0);
    expect(negatives).toEqual([]);
  });

  it("moves a slice that started early to 0, keeps its end, and records how early it was", () => {
    const slices = named(early().traceEvents, "X").filter((e) => e.cat === "network");
    expect(slices.map((e) => [e.name, e.ts, e.dur])).toEqual([
      ["document d.test", 0, 100_000], // ends at +100 ms as measured
      ["image e.test", 0, 0], // entirely before the session: a point at 0
    ]);
    expect(slices[0]?.args).toMatchObject({ duration_ms: 500, ms_before_session_start: 400 });
    expect(slices[1]?.args).toMatchObject({ ms_before_session_start: 150 });
  });

  it("moves an early issue and counter sample to 0 and says so", () => {
    const trace = early();
    const issue = named(trace.traceEvents, "i").find((e) => e.cat === "issue");
    expect(issue).toMatchObject({
      name: "captcha",
      ts: 0,
      args: { message: "early", ms_before_session_start: 200 },
    });
    const cpu = named(trace.traceEvents, "C").filter((e) => e.name === "CPU");
    expect(cpu.map((e) => e.ts)).toEqual([0, 1_000_000]);
  });

  it("counts the moved events in the metadata, and says 0 when there were none", () => {
    expect(early().metadata.before_session_start).toEqual({ events: 4, max_ms: 1000 });
    expect(buildTrace(timeline()).metadata.before_session_start).toEqual({ events: 0, max_ms: 0 });
  });

  it("leaves events at or after the start exactly as they were", () => {
    const trace = buildTrace(timeline());
    for (const e of named(trace.traceEvents, "X"))
      expect(e.args).not.toHaveProperty("ms_before_session_start");
  });
});
