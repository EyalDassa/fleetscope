import { describe, expect, it } from "vitest";
import {
  ActionEvent,
  ENGINES,
  EVENT_TYPES,
  EventBatch,
  FleetEvent,
  IssueEvent,
  NetworkRequestEvent,
  ResourceSampleEvent,
  SCHEMA_VERSION,
  ScreenshotEvent,
  SessionEndedEvent,
  SessionStartedEvent,
} from "./index";

const envelope = {
  v: 1,
  event_id: "6f1c2f0e-8f0a-4c1e-9d55-0d2a7e3c1b11",
  ts: 1_760_000_000_000,
  session_id: "sess-1",
  source: "sim",
  agent_id: "agent-1",
  engine: "lightpanda",
  provider: "local-docker",
} as const;

const valid = {
  "session.started": {
    ...envelope,
    type: "session.started",
    engine_version: "0.2.5",
    scenario: "checkout",
    region: "eu-west",
    startup_ms: 420,
    connect_ms: 35,
  },
  "session.ended": {
    ...envelope,
    type: "session.ended",
    status: "success",
    reason: null,
    duration_ms: 12_000,
  },
  action: {
    ...envelope,
    type: "action",
    seq: 0,
    action_type: "goto",
    target: "example.com",
    duration_ms: 250,
    ok: true,
    error_code: null,
  },
  "resource.sample": {
    ...envelope,
    type: "resource.sample",
    cpu_pct: 12.5,
    mem_mb: 180.25,
    net_rx_bytes: 1024,
    net_tx_bytes: 512,
    origin: "container",
  },
  "network.request": {
    ...envelope,
    type: "network.request",
    domain: "example.com",
    status: 200,
    bytes: 5120,
    duration_ms: 90,
    resource_type: "document",
  },
  issue: { ...envelope, type: "issue", kind: "blocked", message: "403 from bot protection" },
  screenshot: { ...envelope, type: "screenshot", action_seq: 3, url: "s3://bucket/shot.png" },
} as const;

// One clearly broken variant per type.
const invalid = {
  "session.started": { ...valid["session.started"], startup_ms: -1 },
  "session.ended": { ...valid["session.ended"], status: "exploded" },
  action: { ...valid.action, action_type: "teleport" },
  "resource.sample": { ...valid["resource.sample"], origin: "magic" },
  "network.request": { ...valid["network.request"], status: 99 },
  issue: { ...valid.issue, kind: "gremlins" },
  screenshot: { ...valid.screenshot, action_seq: "three" },
} as const;

describe("schema constants", () => {
  it("is version 1 with the three engine slugs", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(ENGINES).toEqual(["chromium", "chrome-headless-shell", "lightpanda"]);
  });

  it("has a valid example for every event type", () => {
    expect(Object.keys(valid).sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe("FleetEvent", () => {
  for (const type of EVENT_TYPES) {
    it(`accepts a valid ${type}`, () => {
      expect(FleetEvent.safeParse(valid[type]).success).toBe(true);
    });

    it(`rejects an invalid ${type}`, () => {
      expect(FleetEvent.safeParse(invalid[type]).success).toBe(false);
    });
  }

  it("rejects an unknown type", () => {
    expect(FleetEvent.safeParse({ ...envelope, type: "session.paused" }).success).toBe(false);
  });

  it("rejects a wrong source", () => {
    expect(FleetEvent.safeParse({ ...valid.issue, source: "fake" }).success).toBe(false);
    expect(FleetEvent.safeParse({ ...valid.issue, source: "REAL" }).success).toBe(false);
  });

  it("rejects an unknown engine, a bad schema version and a non-uuid event_id", () => {
    expect(FleetEvent.safeParse({ ...valid.issue, engine: "firefox" }).success).toBe(false);
    expect(FleetEvent.safeParse({ ...valid.issue, v: 2 }).success).toBe(false);
    expect(FleetEvent.safeParse({ ...valid.issue, event_id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a missing envelope field", () => {
    const { session_id: _omitted, ...rest } = valid.issue;
    expect(FleetEvent.safeParse(rest).success).toBe(false);
  });

  it("narrows on the type discriminator", () => {
    const event = FleetEvent.parse(valid.action);
    if (event.type === "action") {
      expect(event.action_type).toBe("goto");
    } else {
      expect.unreachable("expected an action event");
    }
  });
});

describe("nullable metrics", () => {
  it("accepts js_heap_mb as null, as a number, or absent", () => {
    expect(
      ResourceSampleEvent.parse({ ...valid["resource.sample"], js_heap_mb: null }),
    ).toMatchObject({
      js_heap_mb: null,
    });
    expect(
      ResourceSampleEvent.parse({ ...valid["resource.sample"], js_heap_mb: 42 }),
    ).toMatchObject({
      js_heap_mb: 42,
    });
    expect(ResourceSampleEvent.parse(valid["resource.sample"])).not.toHaveProperty("js_heap_mb");
  });

  it("does not coerce a missing metric to a number", () => {
    const { cpu_pct: _omitted, ...rest } = valid["resource.sample"];
    expect(ResourceSampleEvent.safeParse(rest).success).toBe(false);
  });

  it("accepts null for metrics an engine may not report", () => {
    expect(
      NetworkRequestEvent.safeParse({ ...valid["network.request"], status: null, bytes: null })
        .success,
    ).toBe(true);
    expect(
      SessionStartedEvent.safeParse({ ...valid["session.started"], engine_version: null }).success,
    ).toBe(true);
    expect(SessionEndedEvent.safeParse({ ...valid["session.ended"], reason: null }).success).toBe(
      true,
    );
    expect(
      ActionEvent.safeParse({ ...valid.action, ok: false, error_code: "timeout" }).success,
    ).toBe(true);
  });

  it("allows a screenshot without a url", () => {
    const { url: _omitted, ...rest } = valid.screenshot;
    expect(ScreenshotEvent.safeParse(rest).success).toBe(true);
  });

  it("requires a message on issues", () => {
    const { message: _omitted, ...rest } = valid.issue;
    expect(IssueEvent.safeParse(rest).success).toBe(false);
  });
});

describe("EventBatch", () => {
  const batchOf = (n: number) => Array.from({ length: n }, () => valid.issue);

  it("rejects an empty batch", () => {
    expect(EventBatch.safeParse([]).success).toBe(false);
  });

  it("accepts 1 and 1000 events", () => {
    expect(EventBatch.safeParse(batchOf(1)).success).toBe(true);
    expect(EventBatch.safeParse(batchOf(1000)).success).toBe(true);
  });

  it("rejects 1001 events", () => {
    expect(EventBatch.safeParse(batchOf(1001)).success).toBe(false);
  });

  it("rejects a batch containing one bad event", () => {
    expect(EventBatch.safeParse([valid.issue, invalid.issue]).success).toBe(false);
  });

  it("accepts a mixed batch", () => {
    expect(EventBatch.safeParse(Object.values(valid)).success).toBe(true);
  });
});
