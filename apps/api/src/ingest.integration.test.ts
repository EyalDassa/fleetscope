import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClickHouseClient, insertEvents, ping } from "@fleetscope/db";
import { createTestDatabase, type TestDatabase } from "@fleetscope/db/testing";
import { type EventEnvelope, INGEST_PATH, MAX_BATCH_SIZE, newEvent } from "@fleetscope/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AppDeps, buildApp } from "./app";
import { fileDeadLetter } from "./ingest/dead-letter";
import { oldestAcceptedTs } from "./ingest/validate";

/**
 * POST /v1/events end to end: HTTP -> validation -> buffer -> insertEvents -> real ClickHouse
 * (needs `pnpm infra:up`). Every test uses its own session ids and the file has its own database.
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
const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-ingest",
  engine: "chromium",
  provider: "local-docker",
});

const started = (id: string, ts = Date.now()) =>
  newEvent(
    "session.started",
    ctx(id),
    { engine_version: "1.0", scenario: "s", region: "local", startup_ms: 10, connect_ms: 5 },
    ts,
  );
const ended = (id: string, ts = Date.now()) =>
  newEvent("session.ended", ctx(id), { status: "success", reason: null, duration_ms: 100 }, ts);
const action = (id: string, seq: number, ts = Date.now()) =>
  newEvent(
    "action",
    ctx(id),
    { seq, action_type: "goto", target: "example.com", duration_ms: 5, ok: true, error_code: null },
    ts,
  );
const issue = (id: string, ts = Date.now()) =>
  newEvent("issue", ctx(id), { kind: "blocked", message: "m" }, ts);
const sample = (id: string, ts = Date.now()) =>
  newEvent(
    "resource.sample",
    ctx(id),
    { origin: "container", cpu_pct: 1, mem_mb: 2, net_rx_bytes: 3, net_tx_bytes: 4 },
    ts,
  );
const request = (id: string, ts = Date.now()) =>
  newEvent(
    "network.request",
    ctx(id),
    { domain: "example.com", status: 200, bytes: 10, duration_ms: 3, resource_type: "document" },
    ts,
  );

async function count(table: string, session_id: string): Promise<number> {
  const result = await db.client.query({
    query: `SELECT count() AS n FROM ${table} WHERE session_id = {id:String}`,
    query_params: { id: session_id },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ n: string }>();
  return Number(row?.n);
}
async function sessionStatus(session_id: string): Promise<string | undefined> {
  const result = await db.client.query({
    query: "SELECT status FROM sessions FINAL WHERE session_id = {id:String}",
    query_params: { id: session_id },
    format: "JSONEachRow",
  });
  return (await result.json<{ status: string }>())[0]?.status;
}

/** An app wired like server.ts, on the test database. `wrapClient` lets a test break inserts. */
function start(
  deps: Partial<AppDeps> = {},
  wrapClient: (client: ClickHouseClient) => ClickHouseClient = (client) => client,
) {
  const logs: Array<Record<string, unknown>> = [];
  const client = wrapClient(db.client);
  const app = buildApp({
    ping: () => ping(db.client, 1000),
    insert: (events, dedupTokens) => insertEvents(client, events, { dedupTokens }),
    logLevel: "info",
    logStream: { write: (line) => logs.push(JSON.parse(line)) },
    ...deps,
    ingest: { flushIntervalMs: 50, retryBaseMs: 20, retryMaxMs: 40, ...deps.ingest },
  });
  closers.push(() => app.close());
  const post = (events: unknown) =>
    app.inject({
      method: "POST",
      url: INGEST_PATH,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(events),
    });
  return { app, post, logs };
}

/** A client whose first INSERT into `table` throws, like a ClickHouse outage mid-flush. */
function failOnceOn(table: string): (client: ClickHouseClient) => ClickHouseClient {
  return (client) => {
    let failed = false;
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "insert") return Reflect.get(target, property, receiver);
        return (params: { table: string }) => {
          if (params.table === table && !failed) {
            failed = true;
            return Promise.reject(new Error(`simulated outage on ${table}`));
          }
          return target.insert(params as never);
        };
      },
    });
  };
}

describe("an accepted batch", () => {
  it("is answered right away and lands in ClickHouse within about 2 seconds, with the default flush interval", async () => {
    const id = sid("lands");
    const { post } = start({ ingest: { flushIntervalMs: 1000 } });

    const t0 = Date.now();
    const res = await post([
      started(id),
      action(id, 0),
      action(id, 1),
      sample(id),
      request(id),
      issue(id),
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 6, duplicates: 0 });
    expect(Date.now() - t0).toBeLessThan(500);

    // issues is the last table of a flush: once it has its row, all of them do
    await expect.poll(() => count("issues", id), { timeout: 3000, interval: 100 }).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(await count("actions", id)).toBe(2);
    expect(await count("resource_samples", id)).toBe(1);
    expect(await count("network_requests", id)).toBe(1);
    expect(await sessionStatus(id)).toBe("running");
  });

  it("completes the session when the end arrives in a later request", async () => {
    const id = sid("lifecycle");
    const { post } = start();
    await post([started(id)]);
    await expect.poll(() => sessionStatus(id), { timeout: 3000 }).toBe("running");
    await post([ended(id)]);
    await expect.poll(() => sessionStatus(id), { timeout: 3000 }).toBe("success");
  });

  it("keeps the order of events across requests", async () => {
    const id = sid("order");
    const { post, app } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    for (let seq = 0; seq < 5; seq++) await post([action(id, seq)]);
    await app.close();
    const result = await db.client.query({
      query: "SELECT seq FROM actions WHERE session_id = {id:String} ORDER BY ts, seq",
      query_params: { id },
      format: "JSONEachRow",
    });
    expect((await result.json<{ seq: number }>()).map((row) => row.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("duplicates", () => {
  it("stores a resent batch once and reports the repeats", async () => {
    const id = sid("dups");
    const { post, app } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    const batch = [action(id, 0), action(id, 1), issue(id)];

    expect((await post(batch)).json()).toEqual({ accepted: 3, duplicates: 0 });
    expect((await post(batch)).json()).toEqual({ accepted: 0, duplicates: 3 });
    expect((await post([...batch, action(id, 2)])).json()).toEqual({ accepted: 1, duplicates: 3 });

    await app.close();
    expect(await count("actions", id)).toBe(3);
    expect(await count("issues", id)).toBe(1);
  });

  it("treats an id written in upper case as the same event", async () => {
    const id = sid("dups-case");
    const { post, app } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    const event = action(id, 0);
    await post([event]);
    const res = await post([{ ...event, event_id: event.event_id.toUpperCase() }]);
    expect(res.json()).toEqual({ accepted: 0, duplicates: 1 });
    await app.close();
    expect(await count("actions", id)).toBe(1);
  });
});

describe("refusals", () => {
  it("answers 413 for 1001 events and stores nothing", async () => {
    const id = sid("too-many");
    const { post, app } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    const res = await post(Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, seq) => action(id, seq)));
    expect(res.statusCode).toBe(413);
    await app.close();
    expect(await count("actions", id)).toBe(0);
  });

  it("answers 400 for a ts too far in the future and stores none of the batch", async () => {
    const id = sid("skew");
    const { post, app } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    const res = await post([action(id, 0), action(id, 1, Date.now() + 10 * 60_000)]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("indexes 1");
    await app.close();
    expect(await count("actions", id)).toBe(0);
  });

  it("answers 503 with Retry-After when the buffer is full, and the refused events can be sent again", async () => {
    const id = sid("full");
    const { post, app } = start({ ingest: { capacity: 3, flushIntervalMs: 3_600_000 } });
    const first = [action(id, 0), action(id, 1)];
    const second = [action(id, 2), action(id, 3)];

    expect((await post(first)).statusCode).toBe(202);
    const refused = await post(second);
    expect(refused.statusCode).toBe(503);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);

    await app.close(); // flushes the first two
    expect(await count("actions", id)).toBe(2);

    const { post: postLater, app: later } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    expect((await postLater(second)).json()).toEqual({ accepted: 2, duplicates: 0 });
    await later.close();
    expect(await count("actions", id)).toBe(4);
  });
});

describe("a flush that fails halfway (QA-M0-03)", () => {
  it("is retried and does not duplicate the rows that were already written", async () => {
    const id = sid("retry");
    const { post, logs } = start({}, failOnceOn("issues"));
    await post([
      started(id),
      action(id, 0),
      action(id, 1),
      sample(id),
      request(id),
      issue(id),
      ended(id),
    ]);

    // sessions, actions, resource_samples and network_requests are written before issues fails;
    // the retry must write issues only.
    await expect.poll(() => count("issues", id), { timeout: 5000, interval: 50 }).toBe(1);
    expect(await sessionStatus(id)).toBe("success");
    expect(await count("actions", id)).toBe(2);
    expect(await count("resource_samples", id)).toBe(1);
    expect(await count("network_requests", id)).toBe(1);
    expect(logs.some((line) => String(line.msg).includes("will retry the same batch"))).toBe(true);

    const sessionRows = await db.client.query({
      query: "SELECT version FROM sessions WHERE session_id = {id:String} ORDER BY version",
      query_params: { id },
      format: "JSONEachRow",
    });
    expect(await sessionRows.json()).toEqual([{ version: 2 }]);
  });

  it("keeps accepting events during the retry and stores them too", async () => {
    const first = sid("retry-a");
    const second = sid("retry-b");
    const { post, app } = start(
      { ingest: { retryBaseMs: 200, retryMaxMs: 200 } },
      failOnceOn("actions"),
    );
    await post([action(first, 0), issue(first)]);
    await expect
      .poll(
        async () => (await app.inject({ method: "GET", url: "/healthz" })).json().ingest.retrying,
        {
          timeout: 3000,
          interval: 20,
        },
      )
      .toBe(true);

    expect((await post([action(second, 0)])).statusCode).toBe(202);
    await expect.poll(() => count("actions", second), { timeout: 5000 }).toBe(1);
    expect(await count("actions", first)).toBe(1);
    expect(await count("issues", first)).toBe(1);
  });
});

describe("session.ended before its session.started (QA-M0-06)", () => {
  it("is stored once the start arrives in a later request", async () => {
    const id = sid("orphan-late");
    const { post, app } = start();
    await post([ended(id)]);
    await expect
      .poll(
        async () =>
          (await app.inject({ method: "GET", url: "/healthz" })).json().ingest.orphansHeld,
        {
          timeout: 3000,
        },
      )
      .toBe(1);
    expect(await sessionStatus(id)).toBeUndefined();

    await post([started(id)]);
    await expect.poll(() => sessionStatus(id), { timeout: 5000 }).toBe("success");
    await expect
      .poll(
        async () =>
          (await app.inject({ method: "GET", url: "/healthz" })).json().ingest.orphansHeld,
      )
      .toBe(0);
  });

  it("is dropped with a warning that names the session when no start ever comes", async () => {
    const id = sid("orphan-gone");
    const { post, app, logs } = start({ ingest: { orphanGraceMs: 300 } });
    await post([ended(id)]);

    await expect
      .poll(
        async () =>
          (await app.inject({ method: "GET", url: "/healthz" })).json().ingest.orphansDropped,
        {
          timeout: 5000,
          interval: 50,
        },
      )
      .toBe(1);
    const warning = logs.find((line) => line.level === 40 && Array.isArray(line.sessionIds));
    expect(warning).toMatchObject({ count: 1, sessionIds: [id] });
    expect(await sessionStatus(id)).toBeUndefined();
  });
});

describe("shutdown", () => {
  it("flushes the buffer before the app closes", async () => {
    const id = sid("shutdown");
    const { post, app } = start({ ingest: { flushIntervalMs: 3_600_000 } });
    await post([started(id), action(id, 0), action(id, 1), ended(id)]);
    expect(await count("actions", id)).toBe(0); // still only in memory

    await app.close();
    expect(await count("actions", id)).toBe(2);
    expect(await sessionStatus(id)).toBe("success");
  });

  it("flushes retries that are in progress, and gives up after the timeout when ClickHouse is down", async () => {
    const id = sid("shutdown-down");
    const failing = (client: ClickHouseClient) =>
      new Proxy(client, {
        get(target, property, receiver) {
          if (property === "insert") return () => Promise.reject(new Error("down"));
          return Reflect.get(target, property, receiver);
        },
      });
    const { post, app, logs } = start(
      { ingest: { flushIntervalMs: 3_600_000, shutdownTimeoutMs: 300 } },
      failing,
    );
    await post([action(id, 0), action(id, 1)]);

    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(logs.some((line) => line.lost === 2)).toBe(true);
    expect(await count("actions", id)).toBe(0);
  });
});

describe("GET /healthz", () => {
  it("reports the buffer next to ClickHouse's status", async () => {
    const { app, post } = start({ ingest: { flushIntervalMs: 3_600_000, capacity: 10 } });
    await post([action(sid("health"), 0)]);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      clickhouse: "ok",
      ingest: { queued: 1, capacity: 10, retrying: false, lastFlushError: null },
    });
  });
});

const DAY = 86_400_000;

describe("events that used to make ClickHouse refuse the flush forever (R-M1-01, QA-M1-01)", () => {
  it("stores a lone UTF-16 surrogate in free text as U+FFFD, and the rest of the batch with it", async () => {
    const id = sid("surrogate");
    const { post } = start();
    // JSON.stringify writes the lone surrogates as escapes, which is what a collector sends
    const res = await post([
      started(id),
      newEvent("issue", ctx(id), { kind: "crash", message: "boom \ud83d half an emoji" }),
      newEvent(
        "action",
        ctx(id),
        {
          seq: 0,
          action_type: "click",
          target: "button\ude00",
          duration_ms: 3,
          ok: false,
          error_code: "bad\ud800code",
        },
        Date.now(),
      ),
      newEvent("session.ended", ctx(id), {
        status: "failed",
        reason: "page said \udbff",
        duration_ms: 10,
      }),
    ]);
    expect(res.statusCode).toBe(202);

    // issues is the last table of a flush: once it has its row, all of them do
    await expect.poll(() => count("issues", id), { timeout: 5000 }).toBe(1);
    expect(await sessionStatus(id)).toBe("failed");
    const read = async (query: string) => {
      const result = await db.client.query({
        query,
        query_params: { id },
        format: "JSONEachRow",
      });
      return result.json<Record<string, string>>();
    };
    expect(await read("SELECT message FROM issues WHERE session_id = {id:String}")).toEqual([
      { message: "boom \uFFFD half an emoji" },
    ]);
    expect(
      await read("SELECT target, error_code FROM actions WHERE session_id = {id:String}"),
    ).toEqual([{ target: "button\uFFFD", error_code: "bad\uFFFDcode" }]);
    expect(await read("SELECT reason FROM sessions FINAL WHERE session_id = {id:String}")).toEqual([
      { reason: "page said \uFFFD" },
    ]);
  });

  it("refuses a lone surrogate in an id instead of renaming the session", async () => {
    const { post } = start();
    const res = await post([action("bad-id-\ud83d", 0)]);
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual([0, "session_id"]);
  });

  it("stores a batch that spans the whole retention window: 31 days of partitions in one flush", async () => {
    const id = sid("31-days");
    const { post } = start();
    const now = Date.now();
    const oldest = oldestAcceptedTs(now);
    const events = [];
    // one event on every day from the oldest accepted day to today, plus one just inside the
    // future limit (tomorrow, when the test runs close to midnight UTC)
    for (let day = oldest, seq = 0; day <= now; day += DAY, seq++) {
      events.push(action(id, seq, day));
    }
    events.push(action(id, events.length, now + 4 * 60_000));
    const days = new Set(events.map((e) => new Date(e.ts).toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(30);

    expect((await post(events)).statusCode).toBe(202);
    await expect
      .poll(() => count("actions", id), { timeout: 5000, interval: 100 })
      .toBe(events.length);
  });

  it("answers 400 to a batch over 101 days, stores nothing of it, and keeps ingesting for everybody else", async () => {
    const bad = sid("101-days");
    const good = sid("innocent");
    const { post, app } = start();
    const now = Date.now();
    const poison = Array.from({ length: 101 }, (_, i) => action(bad, i, now - i * DAY));
    const refused = await post(poison);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain("retention window");

    expect((await post([started(good), action(good, 0), ended(good)])).statusCode).toBe(202);
    await expect.poll(() => sessionStatus(good), { timeout: 5000 }).toBe("success");
    expect(await count("actions", bad)).toBe(0);
    const health = (await app.inject({ method: "GET", url: "/healthz" })).json();
    expect(health.ingest).toMatchObject({ retrying: false, deadLettered: 0, lastFlushError: null });
  });

  it("accepts the oldest day the retention window allows, and ClickHouse keeps it", async () => {
    const id = sid("oldest-day");
    const { post } = start();
    const oldest = oldestAcceptedTs(Date.now());
    expect((await post([action(id, 0, oldest)])).statusCode).toBe(202);
    await expect.poll(() => count("actions", id), { timeout: 5000 }).toBe(1);

    // force the TTL merge: the row must survive it (an event from a day further back would not)
    await db.client.command({ query: "OPTIMIZE TABLE actions FINAL" });
    expect(await count("actions", id)).toBe(1);
  });
});

describe("a flush that ClickHouse refuses for its data, whatever the cause (dead letter)", () => {
  /**
   * The edge now repairs lone surrogates, so to get a refusal that slips through, the test puts
   * one back in the rows of the `issues` table just before they go to ClickHouse. ClickHouse then
   * answers with its real error 25, which is a data error. `sessions` and `actions` are written
   * first, as in a real partial write.
   */
  function corruptIssues(client: ClickHouseClient): ClickHouseClient {
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "insert") return Reflect.get(target, property, receiver);
        return (params: { table: string; values: Array<Record<string, unknown>> }) =>
          target.insert(
            (params.table === "issues"
              ? {
                  ...params,
                  values: params.values.map((row) => ({ ...row, message: `${row.message}\ud83d` })),
                }
              : params) as never,
          );
      },
    });
  }

  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("moves the flush to a JSONL file after 3 attempts, and the clients behind it carry on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleetscope-dead-"));
    dirs.push(dir);
    const bad = sid("dead");
    const good = sid("behind");
    const { post, app, logs } = start(
      { deadLetter: fileDeadLetter(dir), ingest: { flushIntervalMs: 20 } },
      corruptIssues,
    );
    const poisoned = [started(bad), action(bad, 0), issue(bad), ended(bad)];
    expect((await post(poisoned)).statusCode).toBe(202);

    await expect
      .poll(
        async () =>
          (await app.inject({ method: "GET", url: "/healthz" })).json().ingest.deadLettered,
        {
          timeout: 5000,
          interval: 20,
        },
      )
      .toBe(4);

    // the file has every event of the flush, one per line
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(dir, files[0] ?? ""), "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).event_id).sort()).toEqual(
      poisoned.map((event) => event.event_id).sort(),
    );

    // one error log: error name and code, flush id, event count
    const moved = logs.filter((line) => String(line.msg).includes("dead-letter file"));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      level: 50,
      events: 4,
      error: "ClickHouseError 25 CANNOT_PARSE_ESCAPE_SEQUENCE",
      attempts: 3,
    });
    expect(String(moved[0]?.file)).toContain(String(moved[0]?.flushId));

    // the tables written before the refusal have their rows once, not three times
    expect(await count("actions", bad)).toBe(1);
    expect(await count("issues", bad)).toBe(0);

    // ingest goes on
    const next = [started(good), action(good, 0), ended(good)];
    expect((await post(next)).statusCode).toBe(202);
    await expect.poll(() => sessionStatus(good), { timeout: 5000 }).toBe("success");
    const ingest = (await app.inject({ method: "GET", url: "/healthz" })).json().ingest;
    expect(ingest).toMatchObject({ retrying: false, queued: 0, deadLettered: 4 });
  });

  it("without a dead-letter directory the flush is retried and nothing is dropped", async () => {
    const id = sid("no-dead-letter");
    const { post, app } = start(
      { ingest: { flushIntervalMs: 20, shutdownTimeoutMs: 100 } },
      corruptIssues,
    );
    await post([action(id, 0), issue(id)]);
    await expect
      .poll(
        async () => (await app.inject({ method: "GET", url: "/healthz" })).json().ingest.retrying,
        {
          timeout: 5000,
        },
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ingest = (await app.inject({ method: "GET", url: "/healthz" })).json().ingest;
    expect(ingest).toMatchObject({ retrying: true, deadLettered: 0, queued: 2 });
    expect(ingest.lastFlushError.error).toBe("ClickHouseError 25 CANNOT_PARSE_ESCAPE_SEQUENCE");
  });
});
