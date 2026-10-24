import { describe, expect, it } from "vitest";
import { expandMacros, formatInterval, MacroError } from "./macros";

// 2024-01-01 00:00:00.123 UTC .. 06:30:15.456 UTC, 90 s interval. The expected strings were
// compared with the real plugin (Grafana 13.2.4 + ClickHouse plugin 4.23.2, executedQueryString).
const ctx = {
  from: new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 123)),
  to: new Date(Date.UTC(2024, 0, 1, 6, 30, 15, 456)),
  intervalMs: 90_000,
};
const FROM = 1704067200;
const TO = 1704090615;

describe("expandMacros", () => {
  it("expands the time filters", () => {
    expect(expandMacros("WHERE $__timeFilter(ts)", ctx)).toBe(
      `WHERE ts >= toDateTime(${FROM}) AND ts <= toDateTime(${TO})`,
    );
    expect(expandMacros("WHERE $__timeFilter_ms(ts)", ctx)).toBe(
      "WHERE ts >= fromUnixTimestamp64Milli(1704067200123) AND ts <= fromUnixTimestamp64Milli(1704090615456)",
    );
    expect(expandMacros("WHERE $__dateFilter(d)", ctx)).toBe(
      "WHERE d >= toDate('2024-01-01') AND d <= toDate('2024-01-01')",
    );
    expect(expandMacros("WHERE $__dateTimeFilter(d, t)", ctx)).toBe(
      `WHERE (d >= toDate('2024-01-01') AND d <= toDate('2024-01-01')) AND (t >= toDateTime(${FROM}) AND t <= toDateTime(${TO}))`,
    );
    expect(expandMacros("$__dt(d,t)", ctx)).toBe(expandMacros("$__dateTimeFilter(d, t)", ctx));
  });

  it("expands the range values", () => {
    expect(expandMacros("$__fromTime|$__toTime", ctx)).toBe(
      `toDateTime(${FROM})|toDateTime(${TO})`,
    );
    expect(expandMacros("$__fromTime_ms|$__toTime_ms", ctx)).toBe(
      "fromUnixTimestamp64Milli(1704067200123)|fromUnixTimestamp64Milli(1704090615456)",
    );
  });

  it("expands $__timeFrom and $__timeTo in value and filter form", () => {
    expect(expandMacros("$__timeFrom()", ctx)).toBe(`toDateTime(${FROM})`);
    expect(expandMacros("$__timeFrom(ts)", ctx)).toBe(`ts >= toDateTime(${FROM})`);
    expect(expandMacros("$__timeTo(ts)", ctx)).toBe(`ts <= toDateTime(${TO})`);
  });

  it("buckets by the panel interval", () => {
    expect(expandMacros("$__timeInterval(ts)", ctx)).toBe(
      "toStartOfInterval(toDateTime(ts), INTERVAL 90 second)",
    );
    expect(expandMacros("$__timeInterval_ms(ts)", ctx)).toBe(
      "toStartOfInterval(toDateTime64(ts, 3), INTERVAL 90000 millisecond)",
    );
    expect(expandMacros("$__interval_s", ctx)).toBe("90");
    expect(expandMacros("$__interval_s", { ...ctx, intervalMs: 200 })).toBe("1");
  });

  it("expands $__timeGroup, also with a nested macro as the interval", () => {
    expect(expandMacros("$__timeGroup(ts, 5m)", ctx)).toBe(
      "toStartOfInterval(toDateTime(ts), INTERVAL 300 second)",
    );
    expect(expandMacros("$__timeGroup(ts, $__interval)", ctx)).toBe(
      "toStartOfInterval(toDateTime(ts), INTERVAL 90 second)",
    );
    expect(() => expandMacros("$__timeGroup(ts, 1d)", ctx)).toThrow(MacroError);
  });

  it("converts Grafana intervals", () => {
    expect(expandMacros("$__fromGrafanaInterval(5m)", ctx)).toBe("5 minute");
    expect(expandMacros("$__fromGrafanaInterval('2h')", ctx)).toBe("2 hour");
    expect(() => expandMacros("$__fromGrafanaInterval(5x)", ctx)).toThrow(MacroError);
  });

  it("keeps nested parentheses and quotes inside arguments together", () => {
    expect(expandMacros("$__timeFilter(coalesce(a, b))", ctx)).toBe(
      `coalesce(a, b) >= toDateTime(${FROM}) AND coalesce(a, b) <= toDateTime(${TO})`,
    );
    expect(expandMacros("$__timeFilter(toDateTime('x,y'))", ctx)).toContain("toDateTime('x,y') >=");
  });

  it("ignores macros in comments but not in strings (like the plugin)", () => {
    const sql = "SELECT 1 -- $__timeFilter(ts)\nWHERE $__timeFilter(ts) /* $__fromTime */";
    const out = expandMacros(sql, ctx);
    expect(out).not.toContain("$__");
    expect(out.match(/toDateTime/g)).toHaveLength(2);
    expect(expandMacros("SELECT '$__fromTime'", ctx)).toBe(`SELECT 'toDateTime(${FROM})'`);
  });

  it("leaves unknown macros alone and rejects unsupported ones", () => {
    expect(expandMacros("SELECT $__whatever(1)", ctx)).toBe("SELECT $__whatever(1)");
    expect(() => expandMacros("$__columns(a, b, c) FROM t", ctx)).toThrow(/not supported/);
    expect(() => expandMacros("$__table", ctx)).toThrow(/not supported/);
  });

  it("reports a wrong argument count with the usage", () => {
    expect(() => expandMacros("$__timeFilter()", ctx)).toThrow(/expects 1 argument.*timeColumn/);
    expect(() => expandMacros("$__dateTimeFilter(a)", ctx)).toThrow(MacroError);
    expect(() => expandMacros("$__timeFilter(a", ctx)).toThrow(/closing parenthesis/);
  });
});

describe("formatInterval", () => {
  it("uses the largest exact unit", () => {
    expect(formatInterval(3_600_000)).toBe("1h");
    expect(formatInterval(90_000)).toBe("90s");
    expect(formatInterval(120_000)).toBe("2m");
    expect(formatInterval(1500)).toBe("1500ms");
  });
});
