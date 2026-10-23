import { type EventEnvelope, type FleetEvent, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { dedupTokensFor, INSERT_TABLES, insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase } from "./testing";

/**
 * Layer 2 of the ingest dedupe (docs/adr/0002-ingest-dedupe.md): ClickHouse skips an INSERT whose
 * `insert_deduplication_token` it has already seen. These tests pin down what we rely on, against
 * the real server version from `pnpm infra:up`.
 */

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

const DAY = 86_400_000;
let counter = 0;
/** A session id nobody else uses, so tests do not see each other's rows. */
const sid = (name: string) => `${name}-${++counter}-${Date.now()}`;

const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-dedupe",
  engine: "chromium",
  provider: "local-docker",
});

function started(session_id: string, ts = Date.now()) {
  return newEvent(
    "session.started",
    ctx(session_id),
    { engine_version: "1.0", scenario: "s", region: "local", startup_ms: 10, connect_ms: 5 },
    ts,
  );
}
function ended(session_id: string, ts = Date.now()) {
  return newEvent(
    "session.ended",
    ctx(session_id),
    { status: "success", reason: null, duration_ms: 100 },
    ts,
  );
}
function action(session_id: string, seq: number, ts = Date.now()) {
  return newEvent(
    "action",
    ctx(session_id),
    { seq, action_type: "goto", target: "example.com", duration_ms: 5, ok: true, error_code: null },
    ts,
  );
}
function issue(session_id: string, ts = Date.now()) {
  return newEvent("issue", ctx(session_id), { kind: "blocked", message: "m" }, ts);
}
function sample(session_id: string, ts = Date.now()) {
  return newEvent(
    "resource.sample",
    ctx(session_id),
    { origin: "container", cpu_pct: 1, mem_mb: 2, net_rx_bytes: 3, net_tx_bytes: 4 },
    ts,
  );
}
function request(session_id: string, ts = Date.now()) {
  return newEvent(
    "network.request",
    ctx(session_id),
    { domain: "example.com", status: 200, bytes: 10, duration_ms: 3, resource_type: "document" },
    ts,
  );
}

async function rows<T>(query: string): Promise<T[]> {
  const result = await db.client.query({ query, format: "JSONEachRow" });
  return result.json<T>();
}
async function count(table: string, session_id: string): Promise<number> {
  const [row] = await rows<{ n: string }>(
    `SELECT count() AS n FROM ${table} WHERE session_id = '${session_id}'`,
  );
  return Number(row?.n);
}

/** A client whose INSERT into `failOn` throws, like a ClickHouse outage in the middle of a flush. */
function clientFailingOn(failOn: string): ClickHouseClient {
  return new Proxy(db.client, {
    get(target, property, receiver) {
      if (property === "insert") {
        return (params: { table: string }) =>
          params.table === failOn
            ? Promise.reject(new Error(`simulated outage while inserting into ${failOn}`))
            : target.insert(params as never);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("migration 0006 and the client settings", () => {
  it("sets the deduplication window on every table that insertEvents writes to", async () => {
    const tables = await rows<{ name: string; engine_full: string }>(
      "SELECT name, engine_full FROM system.tables WHERE database = currentDatabase()",
    );
    const byName = new Map(tables.map((t) => [t.name, t.engine_full]));
    for (const table of INSERT_TABLES) {
      expect(byName.get(table), table).toContain("non_replicated_deduplication_window = 10000");
    }
  });

  it("runs every statement on the client with async_insert = 0", async () => {
    const [row] = await rows<{ value: string }>(
      "SELECT value FROM system.settings WHERE name = 'async_insert'",
    );
    expect(row?.value).toBe("0");
  });
});

describe("insert_deduplication_token on a non-replicated MergeTree (ClickHouse 26.x, async_insert = 0)", () => {
  it("skips a repeated flush: same events, same tokens", async () => {
    const id = sid("same-token");
    const batch: FleetEvent[] = [
      started(id),
      action(id, 0),
      sample(id),
      request(id),
      issue(id),
      ended(id),
    ];
    const tokens = dedupTokensFor("flush-a");

    await insertEvents(db.client, batch, { dedupTokens: tokens });
    await insertEvents(db.client, batch, { dedupTokens: tokens });

    for (const table of ["actions", "resource_samples", "network_requests", "issues"]) {
      expect(await count(table, id), table).toBe(1);
    }
    // sessions is a ReplacingMergeTree: count the raw rows before any background merge.
    expect(await count("sessions", id)).toBe(1);
  });

  it("stores the rows again under a new token: the token, not the content, identifies a flush", async () => {
    const id = sid("new-token");
    const batch = [action(id, 0)];
    await insertEvents(db.client, batch, { dedupTokens: dedupTokensFor("flush-b1") });
    await insertEvents(db.client, batch, { dedupTokens: dedupTokensFor("flush-b2") });
    expect(await count("actions", id)).toBe(2);
  });

  it("does not deduplicate at all without a token, even for identical content", async () => {
    const id = sid("no-token");
    const batch = [action(id, 0), issue(id)];
    await insertEvents(db.client, batch);
    await insertEvents(db.client, batch);
    expect(await count("actions", id)).toBe(2);
    expect(await count("issues", id)).toBe(2);
  });

  it("deduplicates a batch that spans two daily partitions", async () => {
    const id = sid("two-days");
    const batch = [action(id, 0, Date.now()), action(id, 1, Date.now() - DAY)];
    const tokens = dedupTokensFor("flush-c");
    await insertEvents(db.client, batch, { dedupTokens: tokens });
    await insertEvents(db.client, batch, { dedupTokens: tokens });
    expect(await count("actions", id)).toBe(2);
  });
});

describe("a flush that fails halfway (QA-M0-03)", () => {
  it("writes each row once when the same flush is retried with the same tokens", async () => {
    const id = sid("partial");
    const batch: FleetEvent[] = [
      started(id),
      action(id, 0),
      action(id, 1),
      sample(id),
      request(id),
      issue(id),
      ended(id),
    ];
    const tokens = dedupTokensFor("flush-d");

    // sessions, actions and resource_samples are written, then the outage hits network_requests.
    await expect(
      insertEvents(clientFailingOn("network_requests"), batch, { dedupTokens: tokens }),
    ).rejects.toThrow("simulated outage");
    expect(await count("actions", id)).toBe(2);
    expect(await count("network_requests", id)).toBe(0);

    // The retry repeats everything. The tables that were written are skipped, the rest is written.
    const result = await insertEvents(db.client, batch, { dedupTokens: tokens });

    expect(result).toMatchObject({ sessions: 1, actions: 2, network_requests: 1, issues: 1 });
    expect(await count("sessions", id)).toBe(1);
    expect(await count("actions", id)).toBe(2);
    expect(await count("resource_samples", id)).toBe(1);
    expect(await count("network_requests", id)).toBe(1);
    expect(await count("issues", id)).toBe(1);

    const [session] = await rows<{ status: string }>(
      `SELECT status FROM sessions FINAL WHERE session_id = '${id}'`,
    );
    expect(session?.status).toBe("success");
  });

  it("duplicates the earlier tables when the retry has no tokens (why the buffer always passes them)", async () => {
    const id = sid("partial-no-tokens");
    const batch: FleetEvent[] = [action(id, 0), issue(id)];
    await expect(insertEvents(clientFailingOn("issues"), batch)).rejects.toThrow();
    await insertEvents(db.client, batch);
    expect(await count("actions", id)).toBe(2);
    expect(await count("issues", id)).toBe(1);
  });

  it("retries a session.ended that was merged with a stored start without writing a second version", async () => {
    const id = sid("partial-stored-start");
    await insertEvents(db.client, [started(id)]);
    const batch: FleetEvent[] = [ended(id), action(id, 0), issue(id)];
    const tokens = dedupTokensFor("flush-e");

    await expect(
      insertEvents(clientFailingOn("issues"), batch, { dedupTokens: tokens }),
    ).rejects.toThrow();
    await insertEvents(db.client, batch, { dedupTokens: tokens });

    // one running row (version 1) plus one ended row (version 2), not two ended rows
    const versions = await rows<{ version: number }>(
      `SELECT version FROM sessions WHERE session_id = '${id}' ORDER BY version`,
    );
    expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await count("actions", id)).toBe(1);
  });
});

describe("orphaned session.ended", () => {
  it("returns the end events it could not store, and writes nothing for them", async () => {
    const lost = sid("orphan");
    const found = sid("orphan-found");
    const orphan = ended(lost);
    const result = await insertEvents(db.client, [orphan, started(found), ended(found)]);

    expect(result.orphanedEnds).toBe(1);
    expect(result.orphans).toEqual([orphan]);
    expect(result.sessions).toBe(1);
    expect(await count("sessions", lost)).toBe(0);
  });

  it("stores the end once its start has arrived, when the same event is offered again", async () => {
    const id = sid("orphan-late");
    const end = ended(id);
    expect((await insertEvents(db.client, [end])).orphans).toHaveLength(1);

    await insertEvents(db.client, [started(id)]);
    const again = await insertEvents(db.client, [end]);

    expect(again.orphans).toEqual([]);
    const [session] = await rows<{ status: string; version: number }>(
      `SELECT status, version FROM sessions FINAL WHERE session_id = '${id}'`,
    );
    expect(session).toEqual({ status: "success", version: 2 });
  });
});
