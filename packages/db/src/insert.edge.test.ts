import { randomUUID } from "node:crypto";
import type { FleetEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { endedSessionRow, rawRow, runningSessionRow, toClickHouseDateTime } from "./insert";

/** QA edge cases for the pure row-mapping code (no ClickHouse needed). */

const base = {
  v: 1 as const,
  ts: 1_760_000_000_123,
  session_id: "s-1",
  source: "real" as const,
  agent_id: "agent-1",
  engine: "lightpanda" as const,
  provider: "local-docker",
};
const id = () => randomUUID();

describe("toClickHouseDateTime", () => {
  it("pads milliseconds to three digits", () => {
    expect(toClickHouseDateTime(1_760_000_000_000)).toBe("2025-10-09 08:53:20.000");
    expect(toClickHouseDateTime(1_760_000_000_007)).toBe("2025-10-09 08:53:20.007");
    expect(toClickHouseDateTime(1_760_000_000_070)).toBe("2025-10-09 08:53:20.070");
  });

  it("handles the epoch and the end of year 9999", () => {
    expect(toClickHouseDateTime(0)).toBe("1970-01-01 00:00:00.000");
    expect(toClickHouseDateTime(253_402_300_799_999)).toBe("9999-12-31 23:59:59.999");
  });

  it("is always UTC, whatever the machine's time zone", () => {
    // 2025-03-30 01:30 UTC is inside the European DST gap; UTC output must not shift.
    expect(toClickHouseDateTime(Date.UTC(2025, 2, 30, 1, 30, 0, 5))).toBe(
      "2025-03-30 01:30:00.005",
    );
  });

  it("throws on a ts Date cannot represent (the schema should stop it earlier, QA-M0-02)", () => {
    expect(() => toClickHouseDateTime(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => toClickHouseDateTime(Number.NaN)).toThrow(RangeError);
  });
});

describe("rawRow", () => {
  const sample = (extra: { js_heap_mb?: number | null }): FleetEvent => ({
    ...base,
    event_id: id(),
    type: "resource.sample",
    cpu_pct: 1,
    mem_mb: 2,
    net_rx_bytes: 3,
    net_tx_bytes: 4,
    origin: "cdp",
    ...extra,
  });

  it("writes an omitted js_heap_mb as null, never 0 and never undefined", () => {
    const mapped = rawRow(sample({}));
    expect(mapped?.table).toBe("resource_samples");
    expect(mapped?.row).toHaveProperty("js_heap_mb", null);
  });

  it("keeps js_heap_mb = 0 as 0 (a real measurement) and null as null", () => {
    expect(rawRow(sample({ js_heap_mb: 0 }))?.row).toHaveProperty("js_heap_mb", 0);
    expect(rawRow(sample({ js_heap_mb: null }))?.row).toHaveProperty("js_heap_mb", null);
  });

  it("keeps null status and bytes on a network request", () => {
    const event: FleetEvent = {
      ...base,
      event_id: id(),
      type: "network.request",
      domain: "example.com",
      status: null,
      bytes: null,
      duration_ms: 5,
      resource_type: "xhr",
    };
    expect(rawRow(event)?.row).toMatchObject({ status: null, bytes: null });
  });

  it("returns null for screenshot events (no raw table yet)", () => {
    const screenshot: FleetEvent = { ...base, event_id: id(), type: "screenshot", action_seq: 0 };
    expect(rawRow(screenshot)).toBeNull();
  });

  it("does not copy the discriminator or schema version into the row", () => {
    const event: FleetEvent = {
      ...base,
      event_id: id(),
      type: "issue",
      kind: "blocked",
      message: "x",
    };
    const row = rawRow(event)?.row as Record<string, unknown>;
    expect(row).not.toHaveProperty("type");
    expect(row).not.toHaveProperty("v");
  });
});

describe("session snapshots", () => {
  const started: FleetEvent = {
    ...base,
    event_id: id(),
    type: "session.started",
    engine_version: null,
    scenario: "checkout",
    region: "eu",
    startup_ms: 10,
    connect_ms: 5,
  };
  const ended: FleetEvent = {
    ...base,
    event_id: id(),
    ts: base.ts + 5_000,
    type: "session.ended",
    status: "crashed",
    reason: null,
    duration_ms: 5_000,
  };

  it("keeps engine_version null instead of inventing a value", () => {
    if (started.type !== "session.started") throw new Error("unreachable");
    expect(runningSessionRow(started).engine_version).toBeNull();
  });

  it("the ended snapshot has a higher version than the running one and keeps the start fields", () => {
    if (started.type !== "session.started" || ended.type !== "session.ended") {
      throw new Error("unreachable");
    }
    const running = runningSessionRow(started);
    const done = endedSessionRow(running, ended);
    expect(done.version).toBeGreaterThan(running.version);
    expect(done).toMatchObject({
      status: "crashed",
      scenario: "checkout",
      started_at: running.started_at,
      ended_at: "2025-10-09 08:53:25.123",
      duration_ms: 5_000,
      reason: null,
    });
  });
});
