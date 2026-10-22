import { describe, expect, it } from "vitest";
import {
  ActionEvent,
  FleetEvent,
  NetworkRequestEvent,
  ResourceSampleEvent,
  ScreenshotEvent,
  SESSION_STATES,
  SESSION_STATUSES,
  SessionEndedEvent,
  SessionStartedEvent,
  TS_MAX_EXCLUSIVE,
  TS_MIN,
} from "./index";

// Numeric bounds mirror the ClickHouse column types. See infra/clickhouse/*.sql.

const envelope = {
  v: 1,
  event_id: "6f1c2f0e-8f0a-4c1e-9d55-0d2a7e3c1b11",
  ts: 1_760_000_000_000,
  session_id: "sess-1",
  source: "sim",
  agent_id: "agent-1",
  engine: "chromium",
  provider: "local-docker",
} as const;

const action = {
  ...envelope,
  type: "action",
  seq: 0,
  action_type: "goto",
  target: "example.com",
  duration_ms: 1,
  ok: true,
  error_code: null,
} as const;

const container = {
  ...envelope,
  type: "resource.sample",
  origin: "container",
  cpu_pct: 12.5,
  mem_mb: 180,
  net_rx_bytes: 10,
  net_tx_bytes: 5,
} as const;

const cdp = {
  ...envelope,
  type: "resource.sample",
  origin: "cdp",
  cpu_pct: null,
  mem_mb: null,
  net_rx_bytes: null,
  net_tx_bytes: null,
  js_heap_mb: 30,
} as const;

const UINT32_MAX = 4_294_967_295;
const ok = (value: unknown) => FleetEvent.safeParse(value).success;

describe("ts window [2020-01-01, 2100-01-01)", () => {
  it("accepts the first and last millisecond of the window", () => {
    expect(ok({ ...action, ts: TS_MIN })).toBe(true);
    expect(ok({ ...action, ts: TS_MAX_EXCLUSIVE - 1 })).toBe(true);
  });

  it("rejects one millisecond outside the window", () => {
    expect(ok({ ...action, ts: TS_MIN - 1 })).toBe(false);
    expect(ok({ ...action, ts: TS_MAX_EXCLUSIVE })).toBe(false);
  });

  it("has the window on the expected dates", () => {
    expect(new Date(TS_MIN).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(new Date(TS_MAX_EXCLUSIVE).toISOString()).toBe("2100-01-01T00:00:00.000Z");
  });

  it("catches seconds sent instead of milliseconds", () => {
    expect(ok({ ...action, ts: 1_760_000_000 })).toBe(false);
  });

  it("rejects the epoch, negatives, huge values and fractions", () => {
    for (const ts of [0, -1, Number.MAX_SAFE_INTEGER, 253_402_300_800_000, 1_760_000_000_000.5]) {
      expect(ok({ ...action, ts }), String(ts)).toBe(false);
    }
  });
});

describe("UInt32 fields", () => {
  const cases: Array<[string, (n: number) => unknown]> = [
    ["action.seq", (n) => ({ ...action, seq: n })],
    ["action.duration_ms", (n) => ({ ...action, duration_ms: n })],
    [
      "session.started.startup_ms",
      (n) => ({
        ...envelope,
        type: "session.started",
        engine_version: null,
        scenario: "s",
        region: "r",
        startup_ms: n,
        connect_ms: 1,
      }),
    ],
    [
      "session.started.connect_ms",
      (n) => ({
        ...envelope,
        type: "session.started",
        engine_version: null,
        scenario: "s",
        region: "r",
        startup_ms: 1,
        connect_ms: n,
      }),
    ],
    [
      "session.ended.duration_ms",
      (n) => ({
        ...envelope,
        type: "session.ended",
        status: "success",
        reason: null,
        duration_ms: n,
      }),
    ],
    [
      "network.request.duration_ms",
      (n) => ({
        ...envelope,
        type: "network.request",
        domain: "d",
        status: 200,
        bytes: 1,
        duration_ms: n,
        resource_type: "xhr",
      }),
    ],
    ["screenshot.action_seq", (n) => ({ ...envelope, type: "screenshot", action_seq: n })],
  ];

  for (const [name, make] of cases) {
    it(`${name}: accepts 0 and 4294967295, rejects 4294967296 and -1`, () => {
      expect(ok(make(0))).toBe(true);
      expect(ok(make(UINT32_MAX))).toBe(true);
      expect(ok(make(UINT32_MAX + 1))).toBe(false);
      expect(ok(make(-1))).toBe(false);
    });
  }

  it("keeps the event schemas importable one by one", () => {
    for (const schema of [
      ActionEvent,
      SessionStartedEvent,
      SessionEndedEvent,
      NetworkRequestEvent,
      ScreenshotEvent,
    ]) {
      expect(schema).toBeDefined();
    }
  });
});

describe("float and 64-bit fields", () => {
  it("bounds cpu_pct, mem_mb and js_heap_mb below the Float32 maximum", () => {
    expect(ok({ ...container, cpu_pct: 100_000 })).toBe(true);
    expect(ok({ ...container, cpu_pct: 100_001 })).toBe(false);
    expect(ok({ ...container, cpu_pct: 1e39 })).toBe(false);
    expect(ok({ ...container, mem_mb: 16_777_216 })).toBe(true);
    expect(ok({ ...container, mem_mb: 16_777_217 })).toBe(false);
    expect(ok({ ...cdp, js_heap_mb: 16_777_216 })).toBe(true);
    expect(ok({ ...cdp, js_heap_mb: 16_777_217 })).toBe(false);
  });

  it("accepts byte counters up to 2^53 - 1 and rejects more", () => {
    expect(ok({ ...container, net_rx_bytes: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(ok({ ...container, net_rx_bytes: 2 ** 53 })).toBe(false);
    expect(ok({ ...container, net_rx_bytes: -1 })).toBe(false);
  });
});

describe("resource.sample by origin", () => {
  it("accepts a complete container sample, with js_heap_mb omitted or null", () => {
    expect(ok(container)).toBe(true);
    expect(ok({ ...container, js_heap_mb: null })).toBe(true);
  });

  it("rejects a container sample with any container metric null", () => {
    for (const field of ["cpu_pct", "mem_mb", "net_rx_bytes", "net_tx_bytes"]) {
      const result = ResourceSampleEvent.safeParse({ ...container, [field]: null });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path, field).toEqual([field]);
    }
  });

  it("rejects a container sample with a missing container metric", () => {
    const { cpu_pct: _omitted, ...rest } = container;
    expect(ok(rest)).toBe(false);
  });

  it("accepts a cdp sample with the container metrics null", () => {
    expect(ok(cdp)).toBe(true);
    expect(ok({ ...cdp, js_heap_mb: null })).toBe(true);
  });

  it("accepts a cdp sample that also carries container metrics", () => {
    expect(ok({ ...cdp, cpu_pct: 3, mem_mb: 50, net_rx_bytes: 1, net_tx_bytes: 1 })).toBe(true);
  });

  it("still requires the keys to be present on a cdp sample (null, not missing)", () => {
    const { cpu_pct: _omitted, ...rest } = cdp;
    expect(ok(rest)).toBe(false);
  });

  it("parses inside a mixed batch discriminated on type", () => {
    expect(FleetEvent.parse(cdp)).toMatchObject({ type: "resource.sample", origin: "cdp" });
  });
});

describe("session states", () => {
  it("are running plus the five final statuses", () => {
    expect(SESSION_STATES).toEqual(["running", ...SESSION_STATUSES]);
  });
});
