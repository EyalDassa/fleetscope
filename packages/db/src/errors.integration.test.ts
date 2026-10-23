import { type FleetEvent, newEvent, RETENTION_DAYS } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "./client";
import { classifyInsertError } from "./errors";
import { INSERT_TABLES, insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";

/**
 * The classifier against the real errors of the real server (ClickHouse 26.8), and the facts the
 * API's age check relies on: the TTL, and how many days one INSERT may span.
 */

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

const DAY = 86_400_000;
const ctx = (session_id: string) =>
  ({
    session_id,
    source: "real",
    agent_id: "agent-errors",
    engine: "chromium",
    provider: "local-docker",
  }) as const;
let counter = 0;
const sid = (name: string) => `${name}-${++counter}-${Date.now()}`;
const action = (id: string, seq: number, ts: number): FleetEvent =>
  newEvent(
    "action",
    ctx(id),
    { seq, action_type: "goto", target: "example.com", duration_ms: 1, ok: true, error_code: null },
    ts,
  );

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("what ClickHouse really answers", () => {
  it("a lone surrogate in a JSON string: data error 25", async () => {
    const error = await failure(() =>
      db.client.insert({
        table: "issues",
        format: "JSONEachRow",
        values: [
          {
            event_id: crypto.randomUUID(),
            ts: "2026-01-01 00:00:00.000",
            session_id: "s",
            agent_id: "a",
            source: "real",
            engine: "chromium",
            provider: "p",
            kind: "crash",
            message: "boom \ud83d",
          },
        ],
      }),
    );
    expect(error).toMatchObject({ code: "25" });
    expect(classifyInsertError(error)).toBe("data");
  });

  it("more than 100 days in one INSERT: data error 252", async () => {
    const id = sid("too-many-days");
    const now = Date.now();
    const events = Array.from({ length: 101 }, (_, i) => action(id, i, now - i * DAY));
    const error = await failure(() => insertEvents(db.client, events));
    expect(error).toMatchObject({ code: "252" });
    expect(classifyInsertError(error)).toBe("data");
  });

  it("a server that is not there: transient", async () => {
    const lonely = createClickHouseClient({ ...db.config, url: "http://127.0.0.1:1" });
    try {
      const error = await failure(() => insertEvents(lonely, [action(sid("down"), 0, Date.now())]));
      expect(classifyInsertError(error)).toBe("transient");
    } finally {
      await lonely.close();
    }
  });

  it("a table that does not exist (migrations not run): transient, the operator fixes it", async () => {
    const error = await failure(() =>
      db.client.insert({ table: "no_such_table", format: "JSONEachRow", values: [{ a: 1 }] }),
    );
    expect(error).toMatchObject({ code: "60" });
    expect(classifyInsertError(error)).toBe("transient");
  });

  it("a wrong password: transient", async () => {
    const stranger = createClickHouseClient({ ...db.config, password: "wrong" });
    try {
      const error = await failure(() =>
        insertEvents(stranger, [action(sid("auth"), 0, Date.now())]),
      );
      expect(classifyInsertError(error)).toBe("transient");
    } finally {
      await stranger.close();
    }
  });
});

describe("how many days one INSERT may span", () => {
  it("31 distinct days are fine: the most the API lets through in one flush", async () => {
    const id = sid("31-days");
    const now = Date.now();
    // 30 days back plus today: the raw tables keep RETENTION_DAYS days
    const events = Array.from({ length: RETENTION_DAYS + 1 }, (_, i) =>
      action(id, i, now - i * DAY),
    );
    const result = await insertEvents(db.client, events);
    expect(result.actions).toBe(RETENTION_DAYS + 1);
  });

  it("100 days are still fine, the 101st is refused (max_partitions_per_insert_block)", async () => {
    const now = Date.now();
    const hundred = Array.from({ length: 100 }, (_, i) =>
      action(sid("100-days"), i, now - i * DAY),
    );
    await expect(insertEvents(db.client, hundred)).resolves.toMatchObject({ actions: 100 });
    const more = [...hundred, action(sid("101st"), 100, now - 100 * DAY)];
    await expect(insertEvents(db.client, more)).rejects.toMatchObject({ code: "252" });
  });
});

describe("RETENTION_DAYS", () => {
  it("is the TTL of every table", async () => {
    const result = await db.client.query({
      query: "SELECT name, engine_full FROM system.tables WHERE database = currentDatabase()",
      format: "JSONEachRow",
    });
    const tables = new Map(
      (await result.json<{ name: string; engine_full: string }>()).map((t) => [
        t.name,
        t.engine_full,
      ]),
    );
    for (const table of INSERT_TABLES) {
      expect(tables.get(table), table).toContain(`toIntervalDay(${RETENTION_DAYS})`);
    }
  });
});

describe("the retention window works on whole days (why the API's cutoff is midnight, 29 days back)", () => {
  it("keeps an event from the start of day today-29 and drops one from the last moment of day today-30", async () => {
    const id = sid("whole-days");
    const startOfToday = Date.now() - (Date.now() % DAY);
    const keep = startOfToday - (RETENTION_DAYS - 1) * DAY; // 00:00 UTC, 29 days ago
    const drop = keep - 1; // 23:59:59.999 UTC, 30 days ago
    await insertEvents(db.client, [action(id, 0, keep), action(id, 1, drop)]);

    await db.client.command({ query: "OPTIMIZE TABLE actions FINAL" }).catch(() => {});
    const count = async () => {
      const result = await db.client.query({
        query: "SELECT seq FROM actions WHERE session_id = {id:String} ORDER BY seq",
        query_params: { id },
        format: "JSONEachRow",
      });
      return (await result.json<{ seq: number }>()).map((row) => row.seq);
    };
    await expect.poll(count, { timeout: 20_000, interval: 100 }).not.toContain(1);
    // If the test crossed midnight UTC, the day-29 event is legitimately gone too.
    if (Date.now() - (Date.now() % DAY) === startOfToday) {
      expect(await count()).toEqual([0]);
    }
  });
});
