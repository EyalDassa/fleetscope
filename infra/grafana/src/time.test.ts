import { describe, expect, it } from "vitest";
import { panelIntervalMs, parseIntervalMs, parseTimeExpression, resolveTimeRange } from "./time";

const now = new Date(Date.UTC(2024, 4, 15, 13, 47, 21, 500)); // a Wednesday

describe("parseTimeExpression", () => {
  it("reads now and offsets", () => {
    expect(parseTimeExpression("now", now, false)).toEqual(now);
    expect(parseTimeExpression("now-1h", now, false).toISOString()).toBe(
      "2024-05-15T12:47:21.500Z",
    );
    expect(parseTimeExpression("now-1d-2h", now, false).toISOString()).toBe(
      "2024-05-14T11:47:21.500Z",
    );
    expect(parseTimeExpression("now+30m", now, false).toISOString()).toBe(
      "2024-05-15T14:17:21.500Z",
    );
    expect(parseTimeExpression("now-1M", now, false).toISOString()).toBe(
      "2024-04-15T13:47:21.500Z",
    );
  });

  it("rounds down for from and up for to", () => {
    expect(parseTimeExpression("now/d", now, false).toISOString()).toBe("2024-05-15T00:00:00.000Z");
    expect(parseTimeExpression("now/d", now, true).toISOString()).toBe("2024-05-15T23:59:59.999Z");
    expect(parseTimeExpression("now/w", now, false).toISOString()).toBe("2024-05-13T00:00:00.000Z");
    expect(parseTimeExpression("now-1d/d", now, false).toISOString()).toBe(
      "2024-05-14T00:00:00.000Z",
    );
  });

  it("reads absolute times and rejects nonsense", () => {
    expect(parseTimeExpression("1704067200000", now, false).toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(parseTimeExpression("2024-01-01T00:00:00Z", now, false).toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(() => parseTimeExpression("yesterday", now, false)).toThrow();
    expect(() => parseTimeExpression("now-1x", now, false)).toThrow();
  });
});

describe("resolveTimeRange", () => {
  it("defaults to the last 6 hours", () => {
    const range = resolveTimeRange(undefined, now);
    expect(range.to.getTime() - range.from.getTime()).toBe(6 * 3_600_000);
  });

  it("uses the dashboard's time", () => {
    const range = resolveTimeRange({ from: "now-1h", to: "now" }, now);
    expect(range.to.getTime() - range.from.getTime()).toBe(3_600_000);
  });
});

describe("intervals", () => {
  it("parses interval strings", () => {
    expect(parseIntervalMs("1m")).toBe(60_000);
    expect(parseIntervalMs("30s")).toBe(30_000);
    expect(parseIntervalMs("500ms")).toBe(500);
    expect(parseIntervalMs("auto")).toBeUndefined();
    expect(parseIntervalMs(undefined)).toBeUndefined();
  });

  it("snaps the panel interval to a nice value, never below the minimum", () => {
    const hour = { from: new Date(0), to: new Date(3_600_000) };
    expect(panelIntervalMs(hour, 1000, 1000)).toBe(5000); // 3.6 s -> 5 s
    expect(panelIntervalMs(hour, 1000, 60_000)).toBe(60_000);
    expect(panelIntervalMs({ from: new Date(0), to: new Date(10_000) }, 1000, 1000)).toBe(1000);
  });
});
