import type { SessionTimeline } from "@fleetscope/db";
import { describe, expect, it } from "vitest";
import { buildTrace } from "./build-trace";

/**
 * QA M2: the trace of a heavy page and of events stamped before the session started. Both were also
 * loaded into Perfetto's trace_processor (pip `perfetto`) and into ui.perfetto.dev in Chrome; see
 * qa/m2-report.md for what they showed.
 */

const START = 1_000_000;
const session: SessionTimeline["session"] = {
  session_id: "qa-trace",
  agent_id: "a",
  source: "real",
  engine: "chromium",
  engine_version: "1.0",
  provider: "local-docker",
  scenario: "s",
  region: "local",
  startup_ms: 1,
  connect_ms: 1,
  status: "success",
  started_at_ms: START,
  ended_at_ms: START + 10_000,
  duration_ms: 10_000,
  reason: null,
};
const timeline = (extra: Partial<SessionTimeline>): SessionTimeline => ({
  session,
  actions: [],
  samples: [],
  requests: [],
  issues: [],
  truncated: [],
  ...extra,
});

describe("a heavy page", () => {
  // 30 requests in flight at once, like the demo site's /heavy page (112 sampled requests used 40 lanes).
  const requests = Array.from({ length: 30 }, (_, i) => ({
    ts_ms: START + 5000 + i,
    domain: "localhost",
    status: 200,
    bytes: 100,
    duration_ms: 4000,
    resource_type: "image",
  }));
  const trace = buildTrace(
    timeline({
      requests,
      issues: [{ ts_ms: START + 2000, kind: "captcha", message: "x" }],
    }),
  );
  const threads = trace.traceEvents.filter((e) => e.ph === "M" && e.name === "thread_name");
  const sortIndex = (name: string): number => {
    const tid = threads.find((e) => (e.args as { name: string }).name === name)?.tid;
    const meta = trace.traceEvents.find(
      (e) => e.ph === "M" && e.name === "thread_sort_index" && e.tid === tid,
    );
    return ((meta?.args ?? {}) as { sort_index: number }).sort_index;
  };

  it("gives every overlapping request its own track, as the design says", () => {
    expect(threads.filter((e) => /^network/.test((e.args as { name: string }).name))).toHaveLength(
      30,
    );
  });

  // part of QA-M2-08: 30 lanes use sort indexes 20..49, which run into issues (30) and session (40)
  it.fails("keeps every track's sort index unique", () => {
    const indexes = threads.map((e) => sortIndex((e.args as { name: string }).name));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  // QA-M2-08: network lane k sorts at 20 + k, but `issues` sorts at 30 and `session` at 40, so from
  // the 10th lane on the issues and session tracks sit in the middle of the network lanes
  // (seen in Perfetto: "network 21" below "session").
  it.fails("lists the issues and session tracks after every network lane", () => {
    const lastNetwork = Math.max(
      ...threads
        .map((e) => (e.args as { name: string }).name)
        .filter((n) => /^network/.test(n))
        .map(sortIndex),
    );
    expect(sortIndex("issues")).toBeGreaterThan(lastNetwork);
    expect(sortIndex("session")).toBeGreaterThan(sortIndex("issues"));
  });
});

describe("events stamped before the session started", () => {
  const trace = buildTrace(
    timeline({
      requests: [
        {
          ts_ms: START + 100,
          domain: "d",
          status: 200,
          bytes: 1,
          duration_ms: 500,
          resource_type: "document",
        },
      ],
      issues: [{ ts_ms: START - 200, kind: "captcha", message: "early" }],
      samples: [
        { ts_ms: START - 1000, origin: "container", cpu_pct: 5, mem_mb: 50, js_heap_mb: null },
      ],
    }),
  );

  // QA-M2-09: a negative `ts` is silently DROPPED by Perfetto's trace_processor
  // (stats trace_sorter_negative_timestamp_dropped = 4 for this timeline), so the request, the issue
  // and the sample vanish from the timeline without a word. Real sessions did not produce one in the
  // 54 sessions checked, but a request that began before session.started is possible.
  it.fails("never writes a negative timestamp", () => {
    const negative = trace.traceEvents.filter((e) => "ts" in e && (e.ts as number) < 0);
    expect(negative).toEqual([]);
  });
});
