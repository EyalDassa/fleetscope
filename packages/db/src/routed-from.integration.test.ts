import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";

/** `sessions.routed_from` (migration 0009): written on the running row, carried onto the ended row. */

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

const ctx = (session_id: string, engine: EventEnvelope["engine"]): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-routing",
  engine,
  provider: "local-docker",
});

const base = { engine_version: "1.0", scenario: "heavy-page-crawl", region: "local" } as const;
const start = (id: string, engine: EventEnvelope["engine"], extra: object = {}) =>
  newEvent("session.started", ctx(id, engine), {
    ...base,
    startup_ms: 10,
    connect_ms: 5,
    ...extra,
  });
const end = (id: string, engine: EventEnvelope["engine"]) =>
  newEvent("session.ended", ctx(id, engine), { status: "success", reason: null, duration_ms: 100 });

async function final(id: string) {
  const result = await db.client.query({
    query:
      "SELECT engine, routed_from, status, version FROM sessions FINAL WHERE session_id = {id:String}",
    query_params: { id },
    format: "JSONEachRow",
  });
  return result.json<{
    engine: string;
    routed_from: string | null;
    status: string;
    version: number;
  }>();
}

describe("sessions.routed_from", () => {
  it("is on the running row", async () => {
    await insertEvents(db.client, [
      start("rf-running", "chrome-headless-shell", { routed_from: "lightpanda" }),
    ]);
    expect(await final("rf-running")).toEqual([
      { engine: "chrome-headless-shell", routed_from: "lightpanda", status: "running", version: 1 },
    ]);
  });

  it("survives running -> ended when both are in one batch", async () => {
    await insertEvents(db.client, [
      start("rf-same-batch", "chrome-headless-shell", { routed_from: "lightpanda" }),
      end("rf-same-batch", "chrome-headless-shell"),
    ]);
    expect(await final("rf-same-batch")).toEqual([
      { engine: "chrome-headless-shell", routed_from: "lightpanda", status: "success", version: 2 },
    ]);
  });

  it("survives running -> ended when the end is read back from the table (separate batches)", async () => {
    await insertEvents(db.client, [start("rf-split", "chromium", { routed_from: "lightpanda" })]);
    await insertEvents(db.client, [end("rf-split", "chromium")]);
    expect(await final("rf-split")).toEqual([
      { engine: "chromium", routed_from: "lightpanda", status: "success", version: 2 },
    ]);
  });

  it("is NULL for a session that was not routed (absent or null)", async () => {
    await insertEvents(db.client, [
      start("rf-absent", "lightpanda"),
      end("rf-absent", "lightpanda"),
      start("rf-null", "lightpanda", { routed_from: null }),
      end("rf-null", "lightpanda"),
    ]);
    expect((await final("rf-absent"))[0]?.routed_from).toBeNull();
    expect((await final("rf-null"))[0]?.routed_from).toBeNull();
  });
});
