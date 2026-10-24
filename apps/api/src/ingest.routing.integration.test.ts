import { insertEvents, ping } from "@fleetscope/db";
import { createTestDatabase, type TestDatabase } from "@fleetscope/db/testing";
import { type EventEnvelope, INGEST_PATH, newEvent } from "@fleetscope/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * QA routing (ADR 0005): `session.started.routed_from` over POST /v1/events, end to end into real
 * ClickHouse. A bad value is a 400 and nothing of the batch is stored; absent and null both end as
 * NULL; the value survives the session.ended that arrives in a later request.
 */

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

let counter = 0;
const sid = (name: string) => `${name}-${++counter}-${Date.now()}`;

const ctx = (session_id: string, engine: EventEnvelope["engine"]): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-routing",
  engine,
  provider: "local-docker",
});
const started = (id: string, engine: EventEnvelope["engine"], extra: object = {}) =>
  newEvent("session.started", ctx(id, engine), {
    engine_version: "1.0",
    scenario: "heavy-page-crawl",
    region: "local",
    startup_ms: 10,
    connect_ms: 5,
    ...extra,
  });
const ended = (id: string, engine: EventEnvelope["engine"]) =>
  newEvent("session.ended", ctx(id, engine), { status: "success", reason: null, duration_ms: 100 });

function start() {
  const app = buildApp({
    ping: () => ping(db.client, 1000),
    insert: (events, dedupTokens) => insertEvents(db.client, events, { dedupTokens }),
    logLevel: false,
    ingest: { flushIntervalMs: 50, retryBaseMs: 20, retryMaxMs: 40 },
  });
  closers.push(() => app.close());
  const post = (events: unknown) =>
    app.inject({
      method: "POST",
      url: INGEST_PATH,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(events),
    });
  return { post };
}

async function routedFrom(id: string): Promise<{ routed_from: string | null; status: string }[]> {
  const result = await db.client.query({
    query: "SELECT routed_from, status FROM sessions FINAL WHERE session_id = {id:String}",
    query_params: { id },
    format: "JSONEachRow",
  });
  return result.json();
}
async function rowCount(id: string): Promise<number> {
  const result = await db.client.query({
    query: "SELECT count() AS n FROM sessions WHERE session_id = {id:String}",
    query_params: { id },
    format: "JSONEachRow",
  });
  return Number((await result.json<{ n: string }>())[0]?.n);
}

describe("routed_from over the API", () => {
  it.each(["lightpanda", "chrome-headless-shell", "chromium"])("accepts %s", async (engine) => {
    const id = sid("ok");
    const { post } = start();
    // routed_from must differ from engine (routed means moved), so run on another engine
    const ran = engine === "chromium" ? "lightpanda" : "chromium";
    const res = await post([started(id, ran, { routed_from: engine })]);
    expect(res.statusCode).toBe(202);
    await expect
      .poll(() => routedFrom(id), { timeout: 3000 })
      .toEqual([{ routed_from: engine, status: "running" }]);
  });

  it.each([
    ["an unknown engine", "firefox"],
    ["an empty string", ""],
    ["a different case", "Lightpanda"],
    ["a padded name", " lightpanda"],
    ["a number", 3],
    ["a boolean", true],
    ["an array", ["lightpanda"]],
    ["an object", { engine: "lightpanda" }],
    ["the engine that ran the session (routed means moved)", "chromium"],
  ])("answers 400 for %s and stores nothing of the batch", async (_name, value) => {
    const bad = sid("bad");
    const good = sid("good");
    const { post } = start();
    const res = await post([
      started(good, "chromium"),
      started(bad, "chromium", { routed_from: value }),
    ]);
    expect(res.statusCode).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await rowCount(bad)).toBe(0);
    expect(await rowCount(good)).toBe(0);
  });

  it("absent and null both give NULL", async () => {
    const absent = sid("absent");
    const isNull = sid("null");
    const { post } = start();
    const res = await post([
      started(absent, "lightpanda"),
      started(isNull, "lightpanda", { routed_from: null }),
    ]);
    expect(res.statusCode).toBe(202);
    await expect
      .poll(async () => [await routedFrom(absent), await routedFrom(isNull)], { timeout: 3000 })
      .toEqual([
        [{ routed_from: null, status: "running" }],
        [{ routed_from: null, status: "running" }],
      ]);
  });

  it("keeps routed_from when session.ended arrives in a later request", async () => {
    const id = sid("later");
    const { post } = start();
    expect(
      (await post([started(id, "chrome-headless-shell", { routed_from: "lightpanda" })]))
        .statusCode,
    ).toBe(202);
    await expect
      .poll(() => routedFrom(id), { timeout: 3000 })
      .toEqual([{ routed_from: "lightpanda", status: "running" }]);
    expect((await post([ended(id, "chrome-headless-shell")])).statusCode).toBe(202);
    await expect
      .poll(() => routedFrom(id), { timeout: 3000 })
      .toEqual([{ routed_from: "lightpanda", status: "success" }]);
  });

  it("keeps routed_from when the end arrives after a pause, past a flush", async () => {
    const id = sid("pause");
    const { post } = start();
    await post([started(id, "chromium", { routed_from: "lightpanda" })]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await post([ended(id, "chromium")]);
    await expect
      .poll(() => routedFrom(id), { timeout: 3000 })
      .toEqual([{ routed_from: "lightpanda", status: "success" }]);
  });

  it("a duplicate session.started (same event_id) changes nothing", async () => {
    const id = sid("dup");
    const { post } = start();
    const event = started(id, "chromium", { routed_from: "lightpanda" });
    await post([event]);
    await post([event]);
    await expect
      .poll(() => routedFrom(id), { timeout: 3000 })
      .toEqual([{ routed_from: "lightpanda", status: "running" }]);
  });
});
