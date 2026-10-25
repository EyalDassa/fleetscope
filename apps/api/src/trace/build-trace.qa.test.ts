import type { SessionTimeline } from "@fleetscope/db";
import { describe, expect, it } from "vitest";
import { buildTrace, MAX_NETWORK_LANES } from "./build-trace";

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
  routed_from: null,
  target: "demo",
  site: "demo-site",
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

describe("a heavy page (QA-M2-08 and QA-M2-10, fixed)", () => {
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
      samples: [
        { ts_ms: START + 1000, origin: "container", cpu_pct: 5, mem_mb: 50, js_heap_mb: null },
      ],
    }),
  );
  const threads = trace.traceEvents.filter((e) => e.ph === "M" && e.name === "thread_name");
  const nameOf = (e: { args?: unknown }) => (e.args as { name: string }).name;
  const networkThreads = threads.filter((e) => /^network/.test(nameOf(e)));
  const sortIndex = (name: string): number => {
    const tid = threads.find((e) => nameOf(e) === name)?.tid;
    const meta = trace.traceEvents.find(
      (e) => e.ph === "M" && e.name === "thread_sort_index" && e.tid === tid,
    );
    return ((meta?.args ?? {}) as { sort_index: number }).sort_index;
  };

  it("caps the network lanes at MAX_NETWORK_LANES instead of one track per overlapping request", () => {
    expect(MAX_NETWORK_LANES).toBeLessThanOrEqual(6);
    expect(networkThreads).toHaveLength(MAX_NETWORK_LANES);
    const drawn = trace.traceEvents.filter((e) => e.ph === "X" && e.cat === "network");
    expect(drawn).toHaveLength(MAX_NETWORK_LANES); // all 30 overlap, so only 6 fit
  });

  it("says what was left out: a note on the track, the metadata, and the real concurrency as a counter", () => {
    const note = trace.traceEvents.find((e) => e.ph === "i" && /not drawn/.test(e.name ?? ""));
    expect(note?.name).toBe("note: 24 of 30 requests not drawn");
    expect(trace.metadata?.network).toMatchObject({
      requests: 30,
      drawn: MAX_NETWORK_LANES,
      not_drawn: 24,
      max_in_flight: 30,
    });
    const inFlight = trace.traceEvents.filter((e) => e.ph === "C" && e.name === "network");
    expect(inFlight.length).toBeGreaterThan(0);
    expect(Math.max(...inFlight.map((e) => (e.args as { "in flight": number })["in flight"]))).toBe(
      30,
    );
  });

  it("keeps every track's sort index unique, and orders actions, network, issues, session", () => {
    const indexes = threads.map((e) => sortIndex(nameOf(e)));
    expect(new Set(indexes).size).toBe(indexes.length);
    const lastNetwork = Math.max(...networkThreads.map((e) => sortIndex(nameOf(e))));
    expect(sortIndex("actions")).toBeLessThan(
      Math.min(...networkThreads.map((e) => sortIndex(nameOf(e)))),
    );
    expect(sortIndex("issues")).toBeGreaterThan(lastNetwork);
    expect(sortIndex("session")).toBeGreaterThan(sortIndex("issues"));
  });

  it("does not note anything for a page whose requests all fit", () => {
    const light = buildTrace(timeline({ requests: requests.slice(0, MAX_NETWORK_LANES) }));
    expect(light.traceEvents.some((e) => /not drawn/.test(e.name ?? ""))).toBe(false);
    expect(light.traceEvents.some((e) => e.ph === "C" && e.name === "network")).toBe(false);
  });
});

describe("events stamped before the session started (QA-M2-09, fixed)", () => {
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

  it("never writes a negative timestamp", () => {
    const negative = trace.traceEvents.filter((e) => "ts" in e && (e.ts as number) < 0);
    expect(negative).toEqual([]);
  });

  it("keeps the early request, issue and sample (at 0) instead of losing them, and counts them", () => {
    const timed = trace.traceEvents as Array<{
      ph: string;
      name: string;
      cat?: string;
      ts?: number;
      dur?: number;
    }>;
    const request = timed.find((e) => e.ph === "X" && e.cat === "network");
    expect([request?.ts, request?.dur]).toEqual([0, 100_000]); // started 400 ms early, drawn from 0 to 100 ms
    expect(timed.find((e) => e.ph === "i" && e.name === "captcha")?.ts).toBe(0);
    expect(timed.find((e) => e.ph === "C" && e.name === "CPU")?.ts).toBe(0);
    expect(trace.metadata?.before_session_start).toMatchObject({ events: 3 });
  });
});
