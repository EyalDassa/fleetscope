import { EventBatch } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { ConfigError, loadDbConfig } from "./config";
import { rawRow, runningSessionRow, toClickHouseDateTime } from "./insert";
import { splitStatements } from "./migrate";
import { buildSeedEvents } from "./seed-events";

const env = {
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "fleetscope",
  CLICKHOUSE_PASSWORD: "secret",
  CLICKHOUSE_DATABASE: "fleetscope",
};

describe("loadDbConfig", () => {
  it("maps env vars and defaults LOG_LEVEL to info", () => {
    expect(loadDbConfig(env)).toEqual({
      url: "http://localhost:8123",
      username: "fleetscope",
      password: "secret",
      database: "fleetscope",
      logLevel: "info",
    });
  });

  it("lists every problem in one readable message", () => {
    expect(() =>
      loadDbConfig({ CLICKHOUSE_URL: "nope", CLICKHOUSE_DATABASE: "drop table;" }),
    ).toThrow(ConfigError);
    try {
      loadDbConfig({ CLICKHOUSE_URL: "nope", CLICKHOUSE_DATABASE: "drop table;" });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("CLICKHOUSE_URL");
      expect(message).toContain("CLICKHOUSE_USER");
      expect(message).toContain("CLICKHOUSE_DATABASE");
    }
  });
});

describe("splitStatements", () => {
  it("splits on semicolons and drops comments and blanks", () => {
    const sql =
      "-- header; with semicolon\nCREATE TABLE a (x UInt8) ENGINE = Memory; -- tail\n\nINSERT INTO a VALUES (1);\n";
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE a (x UInt8) ENGINE = Memory",
      "INSERT INTO a VALUES (1)",
    ]);
  });
});

describe("toClickHouseDateTime", () => {
  it("formats epoch milliseconds in UTC with millisecond precision", () => {
    expect(toClickHouseDateTime(1_760_000_000_123)).toBe("2025-10-09 08:53:20.123");
  });
});

describe("seed events", () => {
  const events = buildSeedEvents(1_760_000_000_000);

  it("are valid, all simulated, and cover the tables", () => {
    expect(EventBatch.safeParse(events).success).toBe(true);
    expect(new Set(events.map((e) => e.source))).toEqual(new Set(["sim"]));
    const types = new Set(events.map((e) => e.type));
    for (const type of [
      "session.started",
      "session.ended",
      "action",
      "resource.sample",
      "network.request",
      "issue",
    ]) {
      expect(types.has(type as never)).toBe(true);
    }
  });

  it("keep unsupported metrics null instead of inventing them", () => {
    const lightpanda = events.filter(
      (e) => e.type === "resource.sample" && e.engine === "lightpanda",
    );
    expect(lightpanda.length).toBeGreaterThan(0);
    for (const sample of lightpanda) {
      expect(sample).toMatchObject({ js_heap_mb: null });
    }
  });
});

describe("row mapping", () => {
  const events = buildSeedEvents(1_760_000_000_000);

  it("maps a session.started to a running snapshot with version 1", () => {
    const started = events.find((e) => e.type === "session.started");
    if (started?.type !== "session.started") throw new Error("no started event");
    expect(runningSessionRow(started)).toMatchObject({
      status: "running",
      ended_at: null,
      duration_ms: null,
      version: 1,
    });
  });

  it("routes each raw event type to its table and skips the rest", () => {
    const tables = new Set(events.map((e) => rawRow(e)?.table ?? "none"));
    expect(tables).toEqual(
      new Set(["actions", "resource_samples", "network_requests", "issues", "none"]),
    );
  });
});
