import { describe, expect, it } from "vitest";
import { loadApiEnv } from "./env";

/** QA, M1: the new INGEST_BUFFER_CAPACITY variable at its boundaries. */

const base = {
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "u",
  CLICKHOUSE_PASSWORD: "",
  CLICKHOUSE_DATABASE: "d",
};

describe("INGEST_BUFFER_CAPACITY", () => {
  it("defaults to 50,000 when it is not set", () => {
    expect(loadApiEnv(base).INGEST_BUFFER_CAPACITY).toBe(50_000);
  });

  it.each([
    ["1", 1],
    ["50000", 50_000],
    ["5000000", 5_000_000],
    [" 7 ", 7],
  ])("accepts %j", (value, expected) => {
    expect(loadApiEnv({ ...base, INGEST_BUFFER_CAPACITY: value }).INGEST_BUFFER_CAPACITY).toBe(
      expected,
    );
  });

  it.each(["0", "-1", "1.5", "abc", "5000001", "1e9", "Infinity", "NaN"])(
    "refuses %j with a message that names the variable",
    (value) => {
      expect(() => loadApiEnv({ ...base, INGEST_BUFFER_CAPACITY: value })).toThrow(
        /INGEST_BUFFER_CAPACITY/,
      );
    },
  );

  // `INGEST_BUFFER_CAPACITY=` in a .env file gives an empty string. Number("") is 0, so it fails
  // the minimum with a clear message instead of silently meaning "unlimited" or "default".
  it("refuses an empty value rather than guessing", () => {
    expect(() => loadApiEnv({ ...base, INGEST_BUFFER_CAPACITY: "" })).toThrow(
      /INGEST_BUFFER_CAPACITY/,
    );
  });
});
