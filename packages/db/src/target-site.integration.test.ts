import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";
import { getTimelineSession } from "./timeline";

/** `sessions.target` and `sessions.site` (migration 0010, docs/adr/0007). */

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-target-site",
  engine: "chromium",
  provider: "local-docker",
});
const start = (id: string, extra: object = {}) =>
  newEvent("session.started", ctx(id), {
    engine_version: "1.0",
    scenario: "wiki-read",
    region: "local",
    startup_ms: 10,
    connect_ms: 5,
    ...extra,
  });
const end = (id: string) =>
  newEvent("session.ended", ctx(id), { status: "success", reason: null, duration_ms: 100 });

async function final(id: string) {
  const result = await db.client.query({
    query:
      "SELECT target, site, status, version FROM sessions FINAL WHERE session_id = {id:String}",
    query_params: { id },
    format: "JSONEachRow",
  });
  return result.json<{ target: string; site: string; status: string; version: number }>();
}

describe("sessions.target and sessions.site", () => {
  it("are on the running row", async () => {
    await insertEvents(db.client, [start("ts-running", { target: "public", site: "wikipedia" })]);
    expect(await final("ts-running")).toEqual([
      { target: "public", site: "wikipedia", status: "running", version: 1 },
    ]);
  });

  it("survive running -> ended in one batch and across batches", async () => {
    await insertEvents(db.client, [
      start("ts-same", { target: "public", site: "mdn" }),
      end("ts-same"),
    ]);
    await insertEvents(db.client, [start("ts-split", { target: "public", site: "govuk" })]);
    await insertEvents(db.client, [end("ts-split")]);
    expect(await final("ts-same")).toEqual([
      { target: "public", site: "mdn", status: "success", version: 2 },
    ]);
    expect(await final("ts-split")).toEqual([
      { target: "public", site: "govuk", status: "success", version: 2 },
    ]);
  });

  it("an event without them is a demo-site session", async () => {
    await insertEvents(db.client, [start("ts-plain"), end("ts-plain")]);
    expect(await final("ts-plain")).toEqual([
      { target: "demo", site: "demo-site", status: "success", version: 2 },
    ]);
  });

  it("the timeline's session row carries them", async () => {
    await insertEvents(db.client, [start("ts-tl", { target: "public", site: "hackernews" })]);
    const session = await getTimelineSession(db.client, "ts-tl");
    expect(session).toMatchObject({ target: "public", site: "hackernews" });
  });
});
