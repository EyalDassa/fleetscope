import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ActionEvent,
  EventBatch,
  FleetEvent,
  INGEST_PATH,
  IngestAcceptedResponse,
  IngestErrorResponse,
  newEvent,
} from "./index";

const ctx = {
  session_id: "sess-1",
  source: "real",
  agent_id: "agent-1",
  engine: "chromium",
  provider: "local-docker",
} as const;

const actionFields = {
  seq: 0,
  action_type: "goto",
  target: "example.com",
  duration_ms: 120,
  ok: true,
  error_code: null,
} as const;

describe("INGEST_PATH", () => {
  it("is the versioned events endpoint", () => {
    expect(INGEST_PATH).toBe("/v1/events");
  });
});

describe("IngestAcceptedResponse", () => {
  it("accepts non-negative integers", () => {
    expect(IngestAcceptedResponse.parse({ accepted: 3, duplicates: 0 })).toEqual({
      accepted: 3,
      duplicates: 0,
    });
  });

  it("rejects negative, fractional and missing counts", () => {
    expect(IngestAcceptedResponse.safeParse({ accepted: -1, duplicates: 0 }).success).toBe(false);
    expect(IngestAcceptedResponse.safeParse({ accepted: 1.5, duplicates: 0 }).success).toBe(false);
    expect(IngestAcceptedResponse.safeParse({ accepted: 1 }).success).toBe(false);
  });
});

describe("IngestErrorResponse", () => {
  it("accepts an error with and without issues", () => {
    expect(IngestErrorResponse.safeParse({ error: "buffer full" }).success).toBe(true);
    expect(
      IngestErrorResponse.safeParse({
        error: "invalid body",
        issues: [{ path: [0, "ts"], message: "too far in the future" }],
      }).success,
    ).toBe(true);
  });

  it("rejects an issue without a message", () => {
    expect(IngestErrorResponse.safeParse({ error: "x", issues: [{ path: ["a"] }] }).success).toBe(
      false,
    );
  });
});

describe("newEvent", () => {
  it("builds an event that passes FleetEvent validation", () => {
    const event = newEvent("action", ctx, actionFields);
    expect(FleetEvent.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ v: 1, type: "action", ...ctx, ...actionFields });
  });

  it("works for every event type", () => {
    const events = [
      newEvent("session.started", ctx, {
        engine_version: null,
        scenario: "login-and-search",
        region: "local",
        startup_ms: 900,
        connect_ms: 40,
      }),
      newEvent("session.ended", ctx, { status: "success", reason: null, duration_ms: 5000 }),
      newEvent("action", ctx, actionFields),
      newEvent("resource.sample", ctx, {
        origin: "container",
        cpu_pct: 3.5,
        mem_mb: 210,
        net_rx_bytes: 1000,
        net_tx_bytes: 500,
      }),
      newEvent("resource.sample", ctx, {
        origin: "cdp",
        cpu_pct: null,
        mem_mb: null,
        net_rx_bytes: null,
        net_tx_bytes: null,
        js_heap_mb: null,
      }),
      newEvent("network.request", ctx, {
        domain: "example.com",
        status: 200,
        bytes: 1234,
        duration_ms: 80,
        resource_type: "document",
      }),
      newEvent("issue", ctx, { kind: "blocked", message: "HTTP 403" }),
      newEvent("screenshot", ctx, { action_seq: 2 }),
    ];
    expect(EventBatch.safeParse(events).success).toBe(true);
  });

  it("generates a fresh event_id every time", () => {
    const a = newEvent("action", ctx, actionFields);
    const b = newEvent("action", ctx, actionFields);
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("uses Date.now() for ts unless one is given", () => {
    const before = Date.now();
    const event = newEvent("action", ctx, actionFields);
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(Date.now());
    expect(newEvent("action", ctx, actionFields, 1_760_000_000_000).ts).toBe(1_760_000_000_000);
  });

  it("copies only the envelope fields from a bigger context object", () => {
    const bigContext = { ...ctx, scenario: "checkout-form", extra: 1 };
    const event = newEvent("action", bigContext, actionFields);
    expect(event).not.toHaveProperty("scenario");
    expect(event).not.toHaveProperty("extra");
  });

  it("does not let fields overwrite generated values", () => {
    const sneaky = { ...actionFields, event_id: "x", ts: 1, v: 9, type: "issue" };
    const event = newEvent("action", ctx, sneaky as never);
    expect(event.type).toBe("action");
    expect(event.v).toBe(1);
    expect(event.event_id).not.toBe("x");
    expect(event.ts).not.toBe(1);
  });

  it("types the result and the fields after the event type", () => {
    const event = newEvent("action", ctx, actionFields);
    expectTypeOf(event).toEqualTypeOf<ActionEvent>();
    // @ts-expect-error `seq` belongs to action events, not to issues
    newEvent("issue", ctx, { kind: "blocked", message: "x", seq: 1 });
    // @ts-expect-error a required field (message) is missing
    newEvent("issue", ctx, { kind: "blocked" });
    // @ts-expect-error `kind` must be one of the issue kinds
    newEvent("issue", ctx, { kind: "oops", message: "x" });
  });
});
