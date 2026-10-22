import { describe, expect, it } from "vitest";
import {
  ActionEvent,
  EventBatch,
  FleetEvent,
  ResourceSampleEvent,
  SessionEndedEvent,
  SessionStartedEvent,
  TS_MAX_EXCLUSIVE,
  TS_MIN,
} from "./index";

/**
 * QA edge cases for the v1 event schema (M0). The happy paths live in events.test.ts.
 *
 * Bugs found in the first pass (QA-M0-02, QA-M0-04) were fixed in the schema; their tests are now
 * ordinary tests at the end of this file (see qa/m0-report.md).
 */

const envelope = {
  v: 1,
  event_id: "6f1c2f0e-8f0a-4c1e-9d55-0d2a7e3c1b11",
  ts: 1_760_000_000_000,
  session_id: "sess-1",
  source: "real",
  agent_id: "agent-1",
  engine: "chromium",
  provider: "local-docker",
} as const;

const issue = { ...envelope, type: "issue", kind: "blocked", message: "403" } as const;
const action = {
  ...envelope,
  type: "action",
  seq: 0,
  action_type: "goto",
  target: "example.com",
  duration_ms: 10,
  ok: true,
  error_code: null,
} as const;
const sample = {
  ...envelope,
  type: "resource.sample",
  cpu_pct: 1,
  mem_mb: 1,
  net_rx_bytes: 1,
  net_tx_bytes: 1,
  origin: "cdp",
} as const;
const started = {
  ...envelope,
  type: "session.started",
  engine_version: null,
  scenario: "s",
  region: "r",
  startup_ms: 1,
  connect_ms: 1,
} as const;
const ended = {
  ...envelope,
  type: "session.ended",
  status: "success",
  reason: null,
  duration_ms: 1,
} as const;

const ok = (value: unknown) => FleetEvent.safeParse(value).success;

describe("envelope: invalid values", () => {
  it.each([
    ["v is 2", { v: 2 }],
    ["v is the string '1'", { v: "1" }],
    ["v is 0", { v: 0 }],
    ["v is missing", { v: undefined }],
    ["event_id is not a uuid", { event_id: "not-a-uuid" }],
    ["event_id has no dashes", { event_id: "6f1c2f0e8f0a4c1e9d550d2a7e3c1b11" }],
    ["event_id is empty", { event_id: "" }],
    ["event_id is null", { event_id: null }],
    ["ts is negative", { ts: -1 }],
    ["ts is a float", { ts: 1_760_000_000_000.5 }],
    ["ts is a numeric string", { ts: "1760000000000" }],
    ["ts is NaN", { ts: Number.NaN }],
    ["ts is Infinity", { ts: Number.POSITIVE_INFINITY }],
    ["ts is beyond 2^53", { ts: 1e20 }],
    ["session_id is empty", { session_id: "" }],
    ["session_id is 129 chars", { session_id: "x".repeat(129) }],
    ["agent_id is empty", { agent_id: "" }],
    ["agent_id is 129 chars", { agent_id: "x".repeat(129) }],
    ["provider is empty", { provider: "" }],
    ["provider is 129 chars", { provider: "x".repeat(129) }],
    ["engine is unknown", { engine: "firefox" }],
    ["engine has the wrong case", { engine: "Chromium" }],
    ["engine is empty", { engine: "" }],
    ["source is unknown", { source: "test" }],
    ["source has the wrong case", { source: "Real" }],
  ])("rejects an event when %s", (_name, patch) => {
    expect(ok({ ...issue, ...patch })).toBe(false);
  });

  it("accepts the boundary values", () => {
    expect(ok({ ...issue, session_id: "x".repeat(128) })).toBe(true);
    expect(ok({ ...issue, ts: TS_MIN })).toBe(true);
    expect(ok({ ...issue, ts: TS_MAX_EXCLUSIVE - 1 })).toBe(true);
    expect(ok({ ...issue, message: "x".repeat(2000) })).toBe(true);
    expect(ok({ ...issue, message: "x".repeat(2001) })).toBe(false);
  });

  it("rejects things that are not objects", () => {
    for (const value of [null, undefined, 42, "issue", [], true]) {
      expect(ok(value)).toBe(false);
    }
  });

  it("rejects an event whose discriminator is missing, empty or has the wrong case", () => {
    const { type: _type, ...noType } = issue;
    expect(ok(noType)).toBe(false);
    expect(ok({ ...issue, type: "" })).toBe(false);
    expect(ok({ ...issue, type: "Issue" })).toBe(false);
    expect(ok({ ...issue, type: "session.start" })).toBe(false);
  });

  it("is not fooled by a __proto__ key", () => {
    const evil = JSON.parse('{"__proto__": {"type": "issue"}, "v": 1}');
    expect(ok(evil)).toBe(false);
  });
});

describe("extra fields", () => {
  // Behaviour to record: zod objects are non-strict, so unknown fields are STRIPPED, not rejected.
  // That is forward compatible (a v1 server tolerates a collector that sends a new optional
  // field), but a typo such as `durration_ms` is silently dropped instead of reported.
  it("are stripped, not rejected", () => {
    const parsed = FleetEvent.parse({ ...issue, extra: "boom", durration_ms: 5 });
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed).not.toHaveProperty("durration_ms");
    expect(parsed).toEqual(issue);
  });

  it("do not let a field from another event type leak through", () => {
    const parsed = FleetEvent.parse({ ...issue, cpu_pct: 99 });
    expect(parsed).not.toHaveProperty("cpu_pct");
  });
});

describe("per-type invalid values", () => {
  it("rejects an action with a missing or wrong field", () => {
    const { seq: _seq, ...noSeq } = action;
    expect(ActionEvent.safeParse(noSeq).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, seq: -1 }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, seq: 1.5 }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, ok: "true" }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, ok: 1 }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, target: null }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, action_type: "type" }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, duration_ms: -5 }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, duration_ms: 0.5 }).success).toBe(false);
    expect(ActionEvent.safeParse({ ...action, error_code: "" }).success).toBe(false);
  });

  it("rejects negative, NaN and infinite resource metrics", () => {
    for (const patch of [
      { cpu_pct: -0.1 },
      { cpu_pct: Number.NaN },
      { cpu_pct: Number.POSITIVE_INFINITY },
      { mem_mb: -1 },
      { net_rx_bytes: -1 },
      { net_tx_bytes: 1.5 },
      { origin: "docker" },
    ]) {
      expect(ResourceSampleEvent.safeParse({ ...sample, ...patch }).success).toBe(false);
    }
  });

  it("rejects a session.ended with an unknown status (including 'running')", () => {
    expect(SessionEndedEvent.safeParse({ ...ended, status: "running" }).success).toBe(false);
    expect(SessionEndedEvent.safeParse({ ...ended, status: "SUCCESS" }).success).toBe(false);
    expect(SessionEndedEvent.safeParse({ ...ended, duration_ms: -1 }).success).toBe(false);
  });

  it("rejects an empty scenario or region on session.started", () => {
    expect(SessionStartedEvent.safeParse({ ...started, scenario: "" }).success).toBe(false);
    expect(SessionStartedEvent.safeParse({ ...started, region: "" }).success).toBe(false);
    expect(SessionStartedEvent.safeParse({ ...started, engine_version: "" }).success).toBe(false);
  });

  it("rejects an invalid network status", () => {
    const request = {
      ...envelope,
      type: "network.request",
      domain: "d",
      status: 200,
      bytes: 1,
      duration_ms: 1,
      resource_type: "xhr",
    };
    for (const status of [0, 99, 600, 200.5, "200"]) {
      expect(ok({ ...request, status })).toBe(false);
    }
    expect(ok({ ...request, status: 100 })).toBe(true);
    expect(ok({ ...request, status: 599 })).toBe(true);
    expect(ok({ ...request, status: null, bytes: null })).toBe(true);
  });
});

describe("js_heap_mb: null vs omitted", () => {
  it("keeps null as null and leaves an omitted field absent (the db layer turns both into NULL)", () => {
    const withNull = ResourceSampleEvent.parse({ ...sample, js_heap_mb: null });
    expect(withNull.js_heap_mb).toBeNull();
    const omitted = ResourceSampleEvent.parse(sample);
    expect(omitted.js_heap_mb).toBeUndefined();
    expect("js_heap_mb" in omitted).toBe(false);
  });

  it("treats explicit undefined like omitted and rejects strings and negatives", () => {
    expect(ResourceSampleEvent.safeParse({ ...sample, js_heap_mb: undefined }).success).toBe(true);
    expect(ResourceSampleEvent.safeParse({ ...sample, js_heap_mb: "12" }).success).toBe(false);
    expect(ResourceSampleEvent.safeParse({ ...sample, js_heap_mb: -1 }).success).toBe(false);
    expect(ResourceSampleEvent.safeParse({ ...sample, js_heap_mb: 0 }).success).toBe(true);
  });
});

describe("EventBatch: edge cases", () => {
  it("rejects non-arrays", () => {
    expect(EventBatch.safeParse(issue).success).toBe(false);
    expect(EventBatch.safeParse(null).success).toBe(false);
    expect(EventBatch.safeParse({ events: [issue] }).success).toBe(false);
  });

  it("rejects 1001 events even when every event is valid", () => {
    expect(EventBatch.safeParse(Array.from({ length: 1001 }, () => issue)).success).toBe(false);
  });

  it("reports the index of the bad event in a mixed batch", () => {
    const result = EventBatch.safeParse([
      issue,
      { ...issue, ts: -1 },
      action,
      { ...action, ok: 5 },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.slice(0, 2).join("."));
      expect(paths).toContain("1.ts");
      expect(paths).toContain("3.ok");
      expect(paths.some((p) => p.startsWith("0"))).toBe(false);
      expect(paths.some((p) => p.startsWith("2"))).toBe(false);
    }
  });

  it("does not deduplicate event_id (that is M1's job)", () => {
    const parsed = EventBatch.parse([issue, issue]);
    expect(parsed).toHaveLength(2);
  });
});

describe("observations (accepted by the schema; see report)", () => {
  it("accepts an upper-case or nil uuid; the M1 dedupe must normalise event_id", () => {
    expect(ok({ ...issue, event_id: issue.event_id.toUpperCase() })).toBe(true);
    expect(ok({ ...issue, event_id: "00000000-0000-0000-0000-000000000000" })).toBe(true);
  });

  it("accepts ok=true together with an error_code, and ok=false without one", () => {
    expect(ok({ ...action, ok: true, error_code: "timeout" })).toBe(true);
    expect(ok({ ...action, ok: false, error_code: null })).toBe(true);
  });

  it("accepts a whitespace-only session_id", () => {
    expect(ok({ ...issue, session_id: "   " })).toBe(true);
  });
});

// Fixed in round 1 (QA-M0-02, QA-M0-04): the schema now mirrors the ClickHouse column types.
describe("bounds that match the ClickHouse columns (QA-M0-02, QA-M0-04)", () => {
  const UINT32_MAX = 4_294_967_295;

  it("rejects a ts outside [2020-01-01, 2100-01-01), including epoch, seconds and year 10000", () => {
    expect(ok({ ...issue, ts: TS_MIN - 1 })).toBe(false);
    expect(ok({ ...issue, ts: TS_MAX_EXCLUSIVE })).toBe(false);
    expect(ok({ ...issue, ts: 0 })).toBe(false);
    expect(ok({ ...issue, ts: 1_760_000_000 })).toBe(false); // seconds instead of ms
    expect(ok({ ...issue, ts: 253_402_300_800_000 })).toBe(false); // year 10000
    expect(ok({ ...issue, ts: Number.MAX_SAFE_INTEGER })).toBe(false);
  });

  it("rejects millisecond counts that do not fit a UInt32 column, accepts the maximum", () => {
    for (const patch of [{ duration_ms: UINT32_MAX + 1 }, { seq: UINT32_MAX + 1 }]) {
      expect(ok({ ...action, ...patch })).toBe(false);
    }
    expect(ok({ ...action, duration_ms: UINT32_MAX, seq: UINT32_MAX })).toBe(true);
    expect(ok({ ...started, startup_ms: UINT32_MAX + 1 })).toBe(false);
    expect(ok({ ...started, connect_ms: UINT32_MAX + 1 })).toBe(false);
    expect(ok({ ...ended, duration_ms: UINT32_MAX + 1 })).toBe(false);
  });

  it("rejects a cpu_pct / mem_mb / js_heap_mb that does not fit a Float32 column", () => {
    expect(ok({ ...sample, cpu_pct: 1e39 })).toBe(false);
    expect(ok({ ...sample, mem_mb: 1e39 })).toBe(false);
    expect(ok({ ...sample, js_heap_mb: 1e39 })).toBe(false);
    expect(ok({ ...sample, cpu_pct: 100_000, mem_mb: 16_777_216 })).toBe(true);
  });
});

describe("resource.sample by origin", () => {
  const container = { ...sample, origin: "container" } as const;
  const containerMetrics = ["cpu_pct", "mem_mb", "net_rx_bytes", "net_tx_bytes"] as const;

  it.each(containerMetrics)("rejects a container sample whose %s is null", (field) => {
    const result = ResourceSampleEvent.safeParse({ ...container, [field]: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([field]);
  });

  it("rejects a container sample with all four container metrics null", () => {
    const nulls = Object.fromEntries(containerMetrics.map((field) => [field, null]));
    expect(ok({ ...container, ...nulls })).toBe(false);
  });

  it("accepts a cdp sample with every container metric null and a heap value", () => {
    const nulls = Object.fromEntries(containerMetrics.map((field) => [field, null]));
    expect(ok({ ...sample, origin: "cdp", ...nulls, js_heap_mb: 12.5 })).toBe(true);
  });

  it("accepts a cdp sample with null container metrics AND a null heap (nothing measurable)", () => {
    const nulls = Object.fromEntries(containerMetrics.map((field) => [field, null]));
    expect(ok({ ...sample, origin: "cdp", ...nulls, js_heap_mb: null })).toBe(true);
  });

  it("does not turn a null into 0 when parsing", () => {
    const parsed = ResourceSampleEvent.parse({ ...sample, origin: "cdp", cpu_pct: null });
    expect(parsed.cpu_pct).toBeNull();
  });

  it("still rejects a missing (not null) container metric on a cdp sample", () => {
    const { cpu_pct: _cpu, ...rest } = sample;
    expect(ok({ ...rest, origin: "cdp" })).toBe(false);
  });
});
