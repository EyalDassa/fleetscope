import { describe, expect, it } from "vitest";
import { loadApiEnv } from "./env";

const base = {
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "u",
  CLICKHOUSE_PASSWORD: "p",
  CLICKHOUSE_DATABASE: "db",
};

describe("INGEST_DEADLETTER_DIR", () => {
  it("defaults to ./.data/deadletter, relative to the API's working directory", () => {
    expect(loadApiEnv(base).INGEST_DEADLETTER_DIR).toBe("./.data/deadletter");
  });

  it("can be set", () => {
    expect(
      loadApiEnv({ ...base, INGEST_DEADLETTER_DIR: "/var/lib/fleetscope/deadletter" })
        .INGEST_DEADLETTER_DIR,
    ).toBe("/var/lib/fleetscope/deadletter");
  });

  it("must not be empty", () => {
    expect(() => loadApiEnv({ ...base, INGEST_DEADLETTER_DIR: "" })).toThrow(
      /INGEST_DEADLETTER_DIR/,
    );
  });
});
