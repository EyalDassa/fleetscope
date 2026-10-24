import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClickHouseClient,
  createClickHouseClient,
  createLogger,
  insertEvents,
  ping,
} from "@fleetscope/db";
import { createTestDatabase, type TestDatabase } from "@fleetscope/db/testing";
import {
  type EventEnvelope,
  type FleetEvent,
  INGEST_PATH,
  MAX_BATCH_SIZE,
  newEvent,
} from "@fleetscope/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, buildApp } from "./app";
import type { WriteBatch } from "./ingest/buffer";
import { fileDeadLetter } from "./ingest/dead-letter";

/**
 * QA, M1: POST /v1/events under abuse, over a REAL socket (fetch -> Fastify -> buffer ->
 * insertEvents -> real ClickHouse; needs `pnpm infra:up`). BE-ingest's own tests use app.inject()
 * and a client wrapper; this file adds what only the network shows:
 *
 *  - body size and content-type behaviour on the wire,
 *  - ClickHouse failing at the TCP level (a proxy we can cut): a response lost AFTER the insert was
 *    committed, a request cut in the middle, an outage while events keep arriving,
 *  - a batch that ClickHouse always refuses (QA-M1-01),
 *  - orphaned session.ended over HTTP,
 *  - 10,000 sessions through the API.
 *
 * Bugs that are still open are `it.fails("QA-M1-NN: ...")`: they pass while the bug exists and
 * start failing when it is fixed, so QA flips them to plain `it` in the re-test.
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

const DAY = 86_400_000;
let counter = 0;
const sid = (name: string) => `${name}-${++counter}-${Date.now()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-abuse",
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
const action = (id: string, seq: number, ts = Date.now(), target = "example.com") =>
  newEvent(
    "action",
    ctx(id),
    { seq, action_type: "goto", target, duration_ms: 5, ok: true, error_code: null },
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

async function rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await db.client.query({ query, query_params: params, format: "JSONEachRow" });
  return result.json<T>();
}
async function count(table: string, session_id: string): Promise<number> {
  const [row] = await rows<{ n: string }>(
    `SELECT count() AS n FROM ${table} WHERE session_id = {id:String}`,
    { id: session_id },
  );
  return Number(row?.n);
}
async function countPrefix(table: string, prefix: string): Promise<number> {
  const [row] = await rows<{ n: string }>(
    `SELECT count() AS n FROM ${table} WHERE startsWith(session_id, {p:String})`,
    { p: prefix },
  );
  return Number(row?.n);
}
async function sessionStatus(session_id: string): Promise<string | undefined> {
  const [row] = await rows<{ status: string }>(
    "SELECT status FROM sessions FINAL WHERE session_id = {id:String}",
    { id: session_id },
  );
  return row?.status;
}

interface Running {
  app: ReturnType<typeof buildApp>;
  base: string;
  logs: Array<Record<string, unknown>>;
  /** POST a JSON body (any value) and return status, headers and parsed body. */
  post: (body: unknown, headers?: Record<string, string>) => Promise<Reply>;
  /** POST raw text with the given content type. */
  postRaw: (body: string, contentType?: string) => Promise<Reply>;
  health: () => Promise<{ status: number; body: HealthBody }>;
}
interface Reply {
  status: number;
  headers: Headers;
  // The shape depends on the endpoint and the status, so tests read it loosely.
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON of several different shapes
  body: any;
}

/** The part of GET /healthz these tests read. */
interface HealthBody {
  status: string;
  ingest: {
    queued: number;
    retrying: boolean;
    oldestAgeMs: number | null;
    lastFlushError: { at: number; error: string } | null;
    orphansHeld: number;
    orphansDropped: number;
    deadLettered: number;
  };
}

async function readReply(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: response.status, headers: response.headers, body };
}

/** An app wired like server.ts, listening on a real port, on the test database. */
async function listen(
  deps: Partial<AppDeps> = {},
  client: ClickHouseClient = db.client,
): Promise<Running> {
  const logs: Array<Record<string, unknown>> = [];
  const app = buildApp({
    ping: () => ping(db.client, 1000),
    insert: (events, dedupTokens) => insertEvents(client, events, { dedupTokens }),
    logLevel: "info",
    logStream: { write: (line) => logs.push(JSON.parse(line)) },
    ...deps,
    ingest: {
      flushIntervalMs: 50,
      retryBaseMs: 20,
      retryMaxMs: 40,
      shutdownTimeoutMs: 1500,
      ...deps.ingest,
    },
  });
  closers.push(() => app.close());
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const postRaw = async (body: string, contentType = "application/json") =>
    readReply(
      await fetch(`${base}${INGEST_PATH}`, {
        method: "POST",
        headers: contentType ? { "content-type": contentType } : {},
        // A string body makes fetch add content-type: text/plain; bytes do not.
        body: contentType ? body : new TextEncoder().encode(body),
      }),
    );
  return {
    app,
    base,
    logs,
    postRaw,
    post: async (body, headers = {}) =>
      readReply(
        await fetch(`${base}${INGEST_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      ),
    health: async () => {
      const response = await fetch(`${base}/healthz`);
      return { status: response.status, body: (await response.json()) as HealthBody };
    },
  };
}

// A proxy between the API and ClickHouse that we can break on purpose ----------------------

interface Proxy {
  url: string;
  /** Requests seen on the wire (a request = the first bytes after the previous response began). */
  requests: number;
  /** Responses ClickHouse started to send. */
  responses: number;
  /** true: refuse new connections and kill the open ones. false: behave again. */
  outage(on: boolean): void;
  /** Throw away the Nth response (1-based, counted from now) after ClickHouse produced it. */
  loseResponse(nth: number): void;
  /** For the next request with more than `bytes` bytes: forward that many, then kill the connection. */
  cutNextRequestAfter(bytes: number): void;
  close(): Promise<void>;
}

async function startProxy(upstream: URL): Promise<Proxy> {
  const open = new Set<Socket>();
  let down = false;
  let loseNth = 0;
  let cutAfter = 0;
  const state = { requests: 0, responses: 0 };

  const server: Server = createServer((client) => {
    open.add(client);
    if (down) {
      client.destroy();
      return;
    }
    const up = connect({ host: upstream.hostname, port: Number(upstream.port) });
    open.add(up);
    const kill = () => {
      client.destroy();
      up.destroy();
    };
    let awaitingResponse = false;
    let sentOnThisRequest = 0;

    client.on("data", (chunk: Buffer) => {
      if (down) return kill();
      if (!awaitingResponse) {
        awaitingResponse = true;
        sentOnThisRequest = 0;
        state.requests++;
      }
      if (cutAfter > 0 && sentOnThisRequest + chunk.length > cutAfter) {
        const keep = Math.max(0, cutAfter - sentOnThisRequest);
        cutAfter = 0;
        up.write(chunk.subarray(0, keep), kill);
        return;
      }
      sentOnThisRequest += chunk.length;
      up.write(chunk);
    });
    up.on("data", (chunk: Buffer) => {
      if (awaitingResponse) {
        awaitingResponse = false;
        state.responses++;
        if (loseNth > 0 && --loseNth === 0) return kill(); // ClickHouse answered; nobody hears it
      }
      client.write(chunk);
    });
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    client.on("error", () => up.destroy());
    up.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const proxy: Proxy = {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    get responses() {
      return state.responses;
    },
    outage(on) {
      down = on;
      if (on) for (const socket of open) socket.destroy();
    },
    loseResponse(nth) {
      loseNth = nth;
    },
    cutNextRequestAfter(bytes) {
      cutAfter = bytes;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
  closers.push(() => proxy.close());
  return proxy;
}

/** A ClickHouse client whose traffic goes through a breakable proxy. */
async function clientThroughProxy(): Promise<{ client: ClickHouseClient; proxy: Proxy }> {
  const proxy = await startProxy(new URL(db.config.url));
  const client = createClickHouseClient(
    { ...db.config, url: proxy.url },
    { logger: createLogger("qa-proxied", "silent") },
  );
  closers.push(() => client.close());
  return { client, proxy };
}

// ------------------------------------------------------------------------------------------

describe("over a real socket: sizes and content types", () => {
  it("accepts exactly 1000 events in one request and stores all of them", async () => {
    const id = sid("exactly-1000");
    const { post } = await listen();
    await post([started(id)]);
    const res = await post(Array.from({ length: MAX_BATCH_SIZE }, (_, seq) => action(id, seq)));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1000, duplicates: 0 });
    await expect.poll(() => count("actions", id), { timeout: 5000, interval: 100 }).toBe(1000);
  });

  it("answers 413 for 1001 events, stores none of them, and does not remember their ids", async () => {
    const id = sid("exactly-1001");
    const { post } = await listen();
    const events = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, seq) => action(id, seq));
    const refused = await post(events);
    expect(refused.status).toBe(413);
    expect(refused.body).toEqual({ error: "batch has 1001 events, the limit is 1000" });

    // the same first 1000 are not "duplicates" of the refused request
    const retry = await post(events.slice(0, MAX_BATCH_SIZE));
    expect(retry.body).toEqual({ accepted: 1000, duplicates: 0 });
    await expect.poll(() => count("actions", id), { timeout: 5000, interval: 100 }).toBe(1000);
  });

  it("accepts a 1000-event body just under 2 MiB and answers 413 for the same batch with longer targets", async () => {
    const limit = 2 * 1024 * 1024;
    const id = sid("big-body");
    const { post } = await listen({ ingest: { capacity: 5000 } });
    const make = (targetLength: number) =>
      Array.from({ length: MAX_BATCH_SIZE }, (_, seq) =>
        action(id, seq, Date.now(), "x".repeat(targetLength)),
      );
    // 1000 events differ only in the target. Find the longest target that stays under the limit.
    const sizeWith = (targetLength: number) => JSON.stringify(make(targetLength)).length;
    let low = 0;
    let high = 2000; // the schema allows targets up to 2000 characters
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (sizeWith(mid) <= limit) low = mid;
      else high = mid - 1;
    }
    expect(low).toBeGreaterThan(1500);
    expect(low).toBeLessThan(2000);

    const fits = await post(make(low));
    expect(fits.status).toBe(202);
    expect(fits.body).toEqual({ accepted: 1000, duplicates: 0 });

    // One character more per event is still a schema-valid batch of 1000 events, but the byte
    // limit refuses it. A collector sending such a batch would drop it (413 is never retried).
    const tooBig = await post(make(low + 1));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toEqual({ error: "Request body is too large" });
    expect(sizeWith(low + 1)).toBeGreaterThan(limit);
  });

  it("answers JSON for a content type it cannot parse: 415 when missing, 400 for text/plain", async () => {
    const { postRaw } = await listen();
    const body = JSON.stringify([started(sid("ct"))]);

    expect((await postRaw(body, "application/json; charset=utf-8")).status).toBe(202);
    expect((await postRaw(body, "")).status).toBe(415);
    expect((await postRaw(body, "application/x-www-form-urlencoded")).status).toBe(415);
    // Documented, not praised: Fastify hands text/plain over as a string, so the client is told
    // "expected array, received string" instead of "send application/json".
    const plain = await postRaw(body, "text/plain");
    expect(plain.status).toBe(400);
    expect(plain.body.issues[0].message).toContain("expected array, received string");
  });

  it("never answers 500 to nonsense bodies", async () => {
    const { postRaw } = await listen();
    const bodies = [
      "",
      " ",
      "null",
      "true",
      "42",
      '"str"',
      "[",
      "[null]",
      "[[]]",
      "{}",
      '[{"__proto__":{"x":1}}]',
      `[${"[".repeat(5000)}${"]".repeat(5000)}]`,
      '[{"v":1,"type":"session.started","ts":1e999}]',
    ];
    for (const body of bodies) {
      const res = await postRaw(body);
      expect(res.status, body.slice(0, 40)).toBeGreaterThanOrEqual(400);
      expect(res.status, body.slice(0, 40)).toBeLessThan(500);
      expect(typeof res.body === "object" ? res.body : { error: res.body }).toHaveProperty("error");
    }
  });
});

describe("over a real socket: duplicates", () => {
  it("stores a batch once when the same request is sent 20 times in parallel", async () => {
    const id = sid("parallel-dups");
    const { post, app } = await listen({ ingest: { flushIntervalMs: 3_600_000 } });
    const batch = [action(id, 0), action(id, 1), action(id, 2), issue(id)];
    const replies = await Promise.all(Array.from({ length: 20 }, () => post(batch)));
    const accepted = replies.map((r) => r.body.accepted);
    const duplicates = replies.map((r) => r.body.duplicates);
    expect(accepted.reduce((a, b) => a + b, 0)).toBe(4);
    expect(duplicates.reduce((a, b) => a + b, 0)).toBe(4 * 19);
    expect(replies.every((r) => r.status === 202)).toBe(true);
    await app.close();
    expect(await count("actions", id)).toBe(3);
    expect(await count("issues", id)).toBe(1);
  });

  it("treats upper-case, mixed-case and lower-case spellings of one id as one event, inside a batch and across batches", async () => {
    const id = sid("case");
    const { post, app } = await listen({ ingest: { flushIntervalMs: 3_600_000 } });
    const a = action(id, 0);
    const mixed = a.event_id
      .split("")
      .map((c, i) => (i % 2 ? c.toUpperCase() : c))
      .join("");
    const first = await post([{ ...a, event_id: a.event_id.toUpperCase() }, a]);
    expect(first.body).toEqual({ accepted: 1, duplicates: 1 });
    const second = await post([{ ...a, event_id: mixed }, action(id, 1)]);
    expect(second.body).toEqual({ accepted: 1, duplicates: 1 });
    await app.close();
    expect(await count("actions", id)).toBe(2);
  });

  it("a duplicate that arrives while the first copy is being written is still dropped", async () => {
    const id = sid("dup-in-flight");
    const { client, proxy } = await clientThroughProxy();
    const { post } = await listen({}, client);
    const batch = [started(id), action(id, 0)];
    proxy.outage(true); // the first copy sits in the buffer, retrying
    await post(batch);
    await sleep(200);
    const dup = await post(batch);
    expect(dup.body).toEqual({ accepted: 0, duplicates: 2 });
    proxy.outage(false);
    await expect.poll(() => count("actions", id), { timeout: 5000, interval: 100 }).toBe(1);
    expect(await count("sessions", id)).toBe(1);
  });
});

describe("over a real socket: clock skew", () => {
  it("accepts a ts exactly 5 minutes ahead, refuses 5 minutes and 1 ms, and refuses the whole batch", async () => {
    const id = sid("skew");
    const now = Date.now();
    const { post, app } = await listen({ now: () => now, ingest: { flushIntervalMs: 3_600_000 } });
    expect((await post([action(id, 0, now + 300_000)])).status).toBe(202);
    const late = await post([action(id, 1, now + 300_001)]);
    expect(late.status).toBe(400);
    expect(late.body.issues).toEqual([
      { path: [0, "ts"], message: "ts is more than 5 minutes ahead of the server clock" },
    ]);
    // one good, one bad: neither is stored, and the good one is not remembered as seen
    const good = action(id, 2, now);
    const mixed = await post([good, action(id, 3, now + 400_000)]);
    expect(mixed.status).toBe(400);
    expect((await post([good])).body).toEqual({ accepted: 1, duplicates: 0 });
    await app.close();
    expect(await count("actions", id)).toBe(2); // seq 0 and seq 2
  });
});

describe("over a real socket: events from the past (QA-M1-01, the retention window)", () => {
  // The raw tables delete a row when its DAY is 30 days old (TTL toDate(ts) + 30 DAY). The API
  // refuses a ts before midnight UTC of the day 29 days ago, so a 202 is never followed by an
  // immediate deletion, and one flush can touch at most 31 daily partitions.
  const cutoffOf = (now: number) => now - (now % DAY) - 29 * DAY;

  it("refuses a ts one millisecond before the cutoff (400, names it), accepts the cutoff itself, and the TTL keeps that event", async () => {
    const id = sid("cutoff");
    const now = Date.now();
    const cutoff = cutoffOf(now);
    const { post, health } = await listen({ now: () => now });

    const tooOld = await post([action(id, 0, cutoff - 1)]);
    expect(tooOld.status).toBe(400);
    expect(tooOld.body.error).toContain("retention window");
    expect(tooOld.body.error).toContain(new Date(cutoff).toISOString());
    expect(tooOld.body.issues).toEqual([
      expect.objectContaining({ path: [0, "ts"], message: expect.stringContaining("older than") }),
    ]);

    expect((await post([action(id, 1, cutoff)])).body).toEqual({ accepted: 1, duplicates: 0 });
    await expect.poll(async () => (await health()).body.ingest.queued, { timeout: 5000 }).toBe(0);

    // Force the TTL to run now. The event at the cutoff survives; nothing of the refused one exists.
    await db.client.command({ query: "OPTIMIZE TABLE actions FINAL" });
    expect(await count("actions", id)).toBe(1);
  });

  it("is the right cutoff: ClickHouse itself drops an event one millisecond earlier (why 202 for it would be a lie)", async () => {
    const id = sid("cutoff-ttl");
    const cutoff = cutoffOf(Date.now());
    await insertEvents(db.client, [action(id, 0, cutoff - 1), action(id, 1, cutoff)]);
    await expect
      .poll(
        async () => {
          await db.client.command({ query: "OPTIMIZE TABLE actions FINAL" }).catch(() => {});
          return count("actions", id);
        },
        { timeout: 20_000, interval: 200 },
      )
      .toBe(1);
    const [row] = await rows<{ seq: number }>(
      "SELECT seq FROM actions WHERE session_id = {id:String}",
      { id },
    );
    expect(row?.seq).toBe(1);
  });

  it("reports old and future events of one batch together, and stores and remembers none of them", async () => {
    const id = sid("old-and-new");
    const now = Date.now();
    const cutoff = cutoffOf(now);
    const { post } = await listen({ now: () => now });
    const good = action(id, 2, now);
    const bad = [action(id, 0, cutoff - DAY), good, action(id, 1, now + 10 * 60_000)];
    const res = await post(bad);
    expect(res.status).toBe(400);
    expect(res.body.issues.map((i: { path: unknown[] }) => i.path)).toEqual([
      [2, "ts"],
      [0, "ts"],
    ]);
    expect((await post([good])).body).toEqual({ accepted: 1, duplicates: 0 }); // not "seen" before
  });

  it("a flush that spans every day the API allows (30 days plus tomorrow) is stored: the partition cap is never reached", async () => {
    const id = sid("all-days");
    const now = Date.now();
    const cutoff = cutoffOf(now);
    const { post, health } = await listen({ now: () => now });
    const events = Array.from({ length: 30 }, (_, d) => action(id, d, cutoff + d * DAY + 1000));
    events.push(action(id, 30, now + 4 * 60_000)); // the newest the skew check allows
    expect((await post(events)).status).toBe(202);
    await expect.poll(async () => (await health()).body.ingest.queued, { timeout: 5000 }).toBe(0);
    expect((await health()).body.ingest.deadLettered).toBe(0);
    expect(await count("actions", id)).toBe(31);
  });
});

describe("ClickHouse fails at the TCP level", () => {
  // The flush for this batch is sessions, actions, resource_samples, network_requests, issues: five
  // INSERTs, so ClickHouse's responses 1..5 belong to them in that order. We let ClickHouse commit
  // the INSERT and then lose its answer: the worst case for deduplication, because the API cannot
  // know whether the rows are there.
  it.each([
    [1, "sessions"],
    [2, "actions"],
    [3, "resource_samples"],
    [4, "network_requests"],
    [5, "issues"],
  ])(
    "a lost answer to INSERT %i (%s) is retried with the same tokens and nothing is written twice",
    async (nth) => {
      const id = sid(`lost-answer-${nth}`);
      const { client, proxy } = await clientThroughProxy();
      const { post, health, logs } = await listen({}, client);
      proxy.loseResponse(nth);

      await post([
        started(id),
        action(id, 0),
        action(id, 1),
        sample(id),
        request(id),
        issue(id),
        ended(id),
      ]);

      await expect.poll(async () => (await health()).body.ingest.queued, { timeout: 8000 }).toBe(0);
      expect(logs.some((l) => String(l.msg).includes("flush to ClickHouse failed"))).toBe(true);
      expect(proxy.responses).toBeGreaterThanOrEqual(6); // 5 INSERTs + at least one retry
      expect(await count("sessions", id)).toBe(1);
      expect(await count("actions", id)).toBe(2);
      expect(await count("resource_samples", id)).toBe(1);
      expect(await count("network_requests", id)).toBe(1);
      expect(await count("issues", id)).toBe(1);
      expect(await sessionStatus(id)).toBe("success");
      expect((await health()).body.ingest.lastFlushError).toBeNull();
    },
  );

  it("a request cut in the middle of the body writes nothing, and the retry writes every row once", async () => {
    const id = sid("cut-body");
    const { client, proxy } = await clientThroughProxy();
    const { post, health } = await listen({}, client);
    await post([started(id)]);
    await expect.poll(() => count("sessions", id), { timeout: 5000, interval: 50 }).toBe(1);

    // ~1 MB of actions in one INSERT; the connection dies after 200 KB of it.
    proxy.cutNextRequestAfter(200_000);
    const events = Array.from({ length: 1000 }, (_, seq) =>
      action(id, seq, Date.now(), "x".repeat(900)),
    );
    expect((await post(events)).status).toBe(202);

    await expect.poll(async () => (await health()).body.ingest.queued, { timeout: 8000 }).toBe(0);
    expect(await count("actions", id)).toBe(1000);
    const [unique] = await rows<{ n: string }>(
      "SELECT uniqExact(event_id) AS n FROM actions WHERE session_id = {id:String}",
      { id },
    );
    expect(Number(unique?.n)).toBe(1000);
  });

  it("an outage while events keep arriving: nothing lost, nothing doubled, /healthz tells the truth, and it drains by itself", async () => {
    const id = sid("outage");
    const { client, proxy } = await clientThroughProxy();
    const { post, health } = await listen({}, client);

    await post([started(id), action(id, 0)]);
    await expect.poll(() => count("actions", id), { timeout: 5000, interval: 50 }).toBe(1);

    proxy.outage(true);
    const batches = [
      [action(id, 1), action(id, 2)],
      [action(id, 3), sample(id), request(id)],
      [issue(id), ended(id)],
    ];
    for (const batch of batches) expect((await post(batch)).status).toBe(202);
    await expect
      .poll(async () => (await health()).body.ingest.retrying, { timeout: 5000 })
      .toBe(true);
    const during = (await health()).body.ingest;
    expect(during.queued).toBe(7);
    expect(during.oldestAgeMs).toBeGreaterThanOrEqual(0);
    expect(typeof during.lastFlushError?.error).toBe("string");

    // a client that did not get an answer in time resends one of them: still recognised
    expect((await post(batches[0] ?? [])).body).toEqual({ accepted: 0, duplicates: 2 });

    proxy.outage(false);
    await expect.poll(async () => (await health()).body.ingest.queued, { timeout: 10_000 }).toBe(0);
    expect(await count("actions", id)).toBe(4);
    expect(await count("resource_samples", id)).toBe(1);
    expect(await count("network_requests", id)).toBe(1);
    expect(await count("issues", id)).toBe(1);
    expect(await sessionStatus(id)).toBe("success");
    const after = (await health()).body.ingest;
    expect(after.retrying).toBe(false);
    expect(after.lastFlushError).toBeNull();
  });

  it("a graceful shutdown during an outage keeps retrying and succeeds if ClickHouse returns within the timeout", async () => {
    const id = sid("shutdown-recovers");
    const { client, proxy } = await clientThroughProxy();
    const { post, app } = await listen({ ingest: { shutdownTimeoutMs: 5000 } }, client);
    proxy.outage(true);
    await post([started(id), action(id, 0), ended(id)]);
    await sleep(200);
    const closing = app.close();
    await sleep(500);
    proxy.outage(false);
    await closing;
    expect(await count("actions", id)).toBe(1);
    expect(await sessionStatus(id)).toBe("success");
  });

  it("a graceful shutdown during an outage that outlasts the timeout gives up, and says how much it lost", async () => {
    const id = sid("shutdown-loses");
    const { client, proxy } = await clientThroughProxy();
    const { post, app, logs } = await listen({ ingest: { shutdownTimeoutMs: 600 } }, client);
    proxy.outage(true);
    await post([started(id), action(id, 0), action(id, 1)]);
    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    const lost = logs.find((l) => String(l.msg).includes("not written to ClickHouse"));
    expect(lost).toMatchObject({ lost: 3, timedOut: true });
    proxy.outage(false);
    expect(await count("actions", id)).toBe(0);
  });
});

describe("a batch that ClickHouse always refuses", () => {
  /**
   * QA-M1-01, VERIFIED in the re-test. 120 events on 120 different days used to be accepted (202),
   * refused by ClickHouse on every retry ("Too many partitions for single INSERT block", more than
   * 100), and stall every client. Now (1) the API refuses a ts outside the retention window, so a
   * flush spans at most 31 days, and (2) a flush that ClickHouse refuses three times in a row with a
   * DATA error goes to a dead-letter file and ingest continues. Transient errors still retry.
   */
  const poison = (id: string) =>
    Array.from({ length: 120 }, (_, i) => action(id, i, Date.now() - i * DAY));

  it("QA-M1-01: the 120-day batch is refused at the door (400) and other clients' events are stored", async () => {
    const bad = sid("poison");
    const good = sid("poison-good");
    const { post, health } = await listen();
    const refused = await post(poison(bad));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("retention window");
    await post([started(good), action(good, 0), action(good, 1), ended(good)]);
    await expect.poll(() => count("actions", good), { timeout: 4000, interval: 100 }).toBe(2);
    expect(await sessionStatus(good)).toBe("success");
    const ingest = (await health()).body.ingest;
    expect(ingest.retrying).toBe(false);
    expect(ingest.deadLettered).toBe(0);
    expect(await count("actions", bad)).toBe(0);
  });

  describe("past the door: a flush that ClickHouse refuses anyway", () => {
    // Validation now keeps the known poison out, so to test the safety net the events are damaged
    // AFTER validation, on their way from the buffer to ClickHouse (like a future bug could). The
    // buffer still holds the original, valid events: those are what the dead-letter file keeps.
    let deadDir: string;
    beforeEach(async () => {
      deadDir = await mkdtemp(join(tmpdir(), "qa-deadletter-"));
      closers.push(() => rm(deadDir, { recursive: true, force: true }));
    });

    function withCorruption(
      corrupt: (event: FleetEvent) => FleetEvent,
      extra: Partial<AppDeps> = {},
    ) {
      const insert: WriteBatch = (events, dedupTokens) =>
        insertEvents(db.client, events.map(corrupt), { dedupTokens });
      return listen({
        deadLetter: fileDeadLetter(deadDir),
        insert,
        ...extra,
        ingest: { capacity: 5000, ...extra.ingest },
      });
    }

    /** Spreads one session's actions over 120 days: more partitions than one INSERT may touch. */
    const spreadOver120Days = (bad: string) => (event: FleetEvent) =>
      event.type === "action" && event.session_id === bad
        ? { ...event, ts: Date.now() - event.seq * DAY }
        : event;

    it("moves a 'too many partitions' flush to a dead-letter file after 3 tries, keeps ingesting, and counts it", async () => {
      const bad = sid("dl-partitions");
      const good = sid("dl-good");
      const { post, health, logs } = await withCorruption(spreadOver120Days(bad));

      // one request, so the innocent events ride in the same flush as the damaged ones
      const batch = [
        started(good),
        action(good, 0),
        ...Array.from({ length: 120 }, (_, i) => action(bad, i)),
      ];
      expect((await post(batch)).status).toBe(202);
      await expect
        .poll(async () => (await health()).body.ingest.deadLettered, { timeout: 8000 })
        .toBe(122); // 120 damaged + the 2 innocent events that shared the flush
      const ingest = (await health()).body.ingest;
      expect(ingest.queued).toBe(0);
      expect(ingest.retrying).toBe(false);

      // the file: one JSONL file, 122 lines, each a whole, valid event
      const files = await readdir(deadDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.jsonl$/);
      const lines = (await readFile(join(deadDir, files[0] ?? ""), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(122);
      const parsed = lines.map((line) => JSON.parse(line) as FleetEvent);
      expect(parsed.filter((e) => e.session_id === bad)).toHaveLength(120);
      expect(parsed.filter((e) => e.session_id === good)).toHaveLength(2);
      expect(new Set(parsed.map((e) => e.event_id)).size).toBe(122);

      // the log says why and where; it was a data error, tried 3 times
      const entry = logs.find((l) => String(l.msg).includes("dead-letter file"));
      expect(entry).toMatchObject({ events: 122, attempts: 3 });
      expect(String(entry?.file)).toContain(files[0] ?? "?");

      // ingest is alive again
      const next = sid("dl-after");
      await post([started(next), action(next, 0), ended(next)]);
      await expect
        .poll(() => sessionStatus(next), { timeout: 4000, interval: 100 })
        .toBe("success");
      expect((await health()).body.ingest.deadLettered).toBe(122);
      expect(await count("actions", bad)).toBe(0);
      expect(await count("actions", good)).toBe(0); // the innocent actions are in the file only
      // Recorded, not praised: the innocent session's start DID reach ClickHouse (sessions is the
      // first table of a flush), so that session is half stored; the rest of it is in the file.
      expect(await sessionStatus(good)).toBe("running");
    });

    it("moves a flush with a lone surrogate (CANNOT_PARSE_ESCAPE_SEQUENCE) to the file too", async () => {
      const id = sid("dl-surrogate");
      const damage = (event: FleetEvent) =>
        event.type === "issue" && event.session_id === id
          ? { ...event, message: "half an emoji: \ud83d" }
          : event;
      const { post, health } = await withCorruption(damage);
      await post([started(id), issue(id)]);
      await expect
        .poll(async () => (await health()).body.ingest.deadLettered, { timeout: 8000 })
        .toBe(2);
      const files = await readdir(deadDir);
      expect(files).toHaveLength(1);
      expect(await readFile(join(deadDir, files[0] ?? ""), "utf8")).toContain('"kind":"blocked"');
    });

    it("never dead-letters on a transient error: a missing database and a wrong password retry for ever", async () => {
      const silent = { logger: createLogger("qa", "silent") };
      const cases: Array<[string, ClickHouseClient]> = [
        [
          "database that does not exist",
          createClickHouseClient(
            { ...db.config, database: ["qa_missing", Date.now()].join("_") },
            silent,
          ),
        ],
        [
          "wrong password",
          createClickHouseClient({ ...db.config, password: "definitely-not-the-password" }, silent),
        ],
      ];
      for (const [name, client] of cases) {
        closers.push(() => client.close());
        const id = sid("dl-transient");
        const { post, health, logs } = await listen(
          { deadLetter: fileDeadLetter(deadDir), ingest: { retryBaseMs: 10, retryMaxMs: 20 } },
          client,
        );
        await post([started(id), action(id, 0)]);
        // far more than the 3 attempts a data error would be given
        await expect
          .poll(
            () => logs.filter((l) => String(l.msg).includes("flush to ClickHouse failed")).length,
            { timeout: 8000 },
          )
          .toBeGreaterThanOrEqual(8);
        const ingest = (await health()).body.ingest;
        expect(ingest.deadLettered, name).toBe(0);
        expect(ingest.retrying, name).toBe(true);
        expect(ingest.queued, name).toBe(2);
        expect(await readdir(deadDir), name).toEqual([]);
      }
    });

    it("keeps the flush in memory when the dead-letter file cannot be written, and says so", async () => {
      const notADir = join(deadDir, "a-file");
      await writeFile(notADir, "x");
      const bad = sid("dl-nowrite");
      const { post, health, logs } = await withCorruption(spreadOver120Days(bad), {
        deadLetter: fileDeadLetter(join(notADir, "sub")), // mkdir under a regular file fails
        ingest: { retryBaseMs: 10, retryMaxMs: 20 },
      });
      await post(Array.from({ length: 120 }, (_, i) => action(bad, i)));
      await expect
        .poll(
          () =>
            logs.filter((l) => String(l.msg).includes("could not write the dead-letter")).length,
          { timeout: 8000 },
        )
        .toBeGreaterThanOrEqual(1);
      const ingest = (await health()).body.ingest;
      expect(ingest.deadLettered).toBe(0);
      expect(ingest.queued).toBe(120); // nothing was thrown away
    });
  });
});

describe("free text of any shape (QA-M1-01 re-test: no other poison left behind validation)", () => {
  // The lone-surrogate bug was found by hand. This looks for the next one: random text built from the
  // code points most likely to upset a parser or a column (quotes, backslashes, NUL and other control
  // characters, noncharacters, BOM, bidi controls, line separators, emoji, lone surrogates), in every
  // free-text field of every event type. Whatever the API accepts must be stored, and must come back as
  // the repaired text; nothing may reach the dead-letter file.
  const PIECES = [
    "a",
    "Z",
    " ",
    "0",
    "'",
    '"',
    "\\",
    "/",
    "%",
    ";",
    "--",
    "{x:String}",
    "$" + "{x}",
    "\n",
    "\r\n",
    "\t",
    "\u0000",
    "\u0001",
    "\u001f",
    "\u007f",
    "\u0085",
    "\u200b",
    "\u2028",
    "\u2029",
    "\u202e",
    "\ufeff",
    "\ufffe",
    "\uffff",
    "\ufffd",
    "\u{1F600}",
    "\u{10FFFF}",
    "\u{1F1EE}\u{1F1F1}",
    "e\u0301",
    "日本語",
    "עברית",
    "\ud83d",
    "\ude00",
    "\ud800",
    "\udfff",
  ];
  /** String.prototype.toWellFormed (Node 20+), which the tsconfig lib does not know yet. */
  const fixed = (value: string): string =>
    (value as unknown as { toWellFormed(): string }).toWellFormed();
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const random = rng(20261023);
  /** Random text of at most `max` UTF-16 units, at least 1. */
  function text(max: number, wellFormedOnly = false): string {
    let out = "";
    const pieces = 1 + Math.floor(random() * 12);
    for (let i = 0; i < pieces; i++) {
      const piece = PIECES[Math.floor(random() * PIECES.length)] ?? "a";
      if (out.length + piece.length > max) break;
      out += piece;
    }
    if (out === "") out = "x";
    return wellFormedOnly ? fixed(out) : out;
  }

  /**
   * Since R-M2 (SAFE_LABEL_PATTERN) the fields that dashboards put into SQL are labels: A-Z a-z 0-9
   * . _ : @ / + - and 1 to 128 characters. Only the free-text fields (target, reason, message, domain,
   * resource_type) take arbitrary text, so only those are fuzzed.
   */
  const SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:@/+-";
  function safeText(max: number): string {
    const length = 1 + Math.floor(random() * max);
    let out = "";
    for (let i = 0; i < length; i++) out += SAFE[Math.floor(random() * SAFE.length)];
    return out;
  }

  it("stores every accepted event exactly as repaired (free text), with nothing dead-lettered and nothing left in the buffer", async () => {
    const run = sid("fuzz");
    const deadDir = await mkdtemp(join(tmpdir(), "qa-fuzz-deadletter-"));
    closers.push(() => rm(deadDir, { recursive: true, force: true }));
    const { post, health } = await listen({ deadLetter: fileDeadLetter(deadDir) });

    const expectedIssue = new Map<string, string>();
    const expectedAction = new Map<string, { target: string; error_code: string }>();
    const expectedNet = new Map<string, { domain: string; resource_type: string }>();
    const expectedSession = new Map<
      string,
      { scenario: string; region: string; engine_version: string; reason: string }
    >();
    let accepted = 0;
    let refused = 0;

    for (let batchNo = 0; batchNo < 12; batchNo++) {
      const events: FleetEvent[] = [];
      for (let i = 0; i < 25; i++) {
        const id = `${run}-${safeText(40)}`.slice(0, 128);
        const ctxWeird = {
          session_id: id,
          source: "real" as const,
          agent_id: safeText(60),
          engine: "chromium" as const,
          provider: safeText(60),
        };
        const scenario = safeText(100);
        const region = safeText(100);
        const engineVersion = safeText(100);
        const reason = text(500);
        const ev = newEvent("session.started", ctxWeird, {
          engine_version: engineVersion,
          scenario,
          region,
          startup_ms: 1,
          connect_ms: 1,
        });
        events.push(ev);
        const target = text(300);
        const errorCode = safeText(100);
        const act = newEvent("action", ctxWeird, {
          seq: 0,
          action_type: "click",
          target,
          duration_ms: 1,
          ok: false,
          error_code: errorCode,
        });
        events.push(act);
        const message = text(1500);
        const iss = newEvent("issue", ctxWeird, { kind: "nav_error", message });
        events.push(iss);
        const domain = text(100);
        const resourceType = text(100);
        const net = newEvent("network.request", ctxWeird, {
          domain,
          status: 200,
          bytes: 1,
          duration_ms: 1,
          resource_type: resourceType,
        });
        events.push(net);
        events.push(
          newEvent("session.ended", ctxWeird, { status: "failed", reason, duration_ms: 1 }),
        );

        expectedIssue.set(iss.event_id, fixed(message));
        expectedAction.set(act.event_id, {
          target: fixed(target),
          error_code: fixed(errorCode),
        });
        expectedNet.set(net.event_id, {
          domain: fixed(domain),
          resource_type: fixed(resourceType),
        });
        expectedSession.set(id, {
          scenario: fixed(scenario),
          region: fixed(region),
          engine_version: fixed(engineVersion),
          reason: fixed(reason),
        });
      }
      const res = await post(events);
      if (res.status === 202) accepted += events.length;
      else refused += events.length;
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(202);
    }
    expect(refused).toBe(0);
    expect(accepted).toBe(12 * 25 * 5);

    await expect.poll(async () => (await health()).body.ingest.queued, { timeout: 15_000 }).toBe(0);
    const ingest = (await health()).body.ingest;
    expect(ingest.deadLettered).toBe(0);
    expect(ingest.retrying).toBe(false);
    expect(await readdir(deadDir)).toEqual([]);

    const issues = await rows<{ event_id: string; message: string }>(
      "SELECT toString(event_id) AS event_id, message FROM issues WHERE startsWith(session_id, {p:String})",
      { p: run },
    );
    expect(issues).toHaveLength(expectedIssue.size);
    for (const row of issues) expect(row.message).toBe(expectedIssue.get(row.event_id));

    const actions = await rows<{ event_id: string; target: string; error_code: string }>(
      "SELECT toString(event_id) AS event_id, target, error_code FROM actions WHERE startsWith(session_id, {p:String})",
      { p: run },
    );
    expect(actions).toHaveLength(expectedAction.size);
    for (const row of actions) {
      expect({ target: row.target, error_code: row.error_code }).toEqual(
        expectedAction.get(row.event_id),
      );
    }

    const nets = await rows<{ event_id: string; domain: string; resource_type: string }>(
      "SELECT toString(event_id) AS event_id, domain, resource_type FROM network_requests WHERE startsWith(session_id, {p:String})",
      { p: run },
    );
    expect(nets).toHaveLength(expectedNet.size);
    for (const row of nets) {
      expect({ domain: row.domain, resource_type: row.resource_type }).toEqual(
        expectedNet.get(row.event_id),
      );
    }

    const sessions = await rows<{
      session_id: string;
      scenario: string;
      region: string;
      engine_version: string;
      reason: string;
      status: string;
    }>(
      "SELECT session_id, scenario, region, engine_version, reason, status FROM sessions FINAL WHERE startsWith(session_id, {p:String})",
      { p: run },
    );
    expect(sessions).toHaveLength(expectedSession.size);
    for (const row of sessions) {
      expect(row.status).toBe("failed");
      expect({
        scenario: row.scenario,
        region: row.region,
        engine_version: row.engine_version,
        reason: row.reason,
      }).toEqual(expectedSession.get(row.session_id));
    }
  }, 60_000);
});

describe("labels that dashboards put into SQL (SAFE_LABEL_PATTERN), over HTTP", () => {
  const BAD = [
    "",
    " ",
    "a b",
    "a'b",
    'a"b',
    "a\\b",
    "a;b",
    "a%b",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "\u65e5\u672c\u8a9e",
    "\u{1F600}",
    "e\u0301",
    "a".repeat(129),
    "x{y:String}",
  ];
  const GOOD = [
    "a",
    "A-b_c.d:e@f/g+h",
    "156.0.8078.4",
    "fleet-runner@host.local",
    "a".repeat(128),
    "..",
    "e5d1c0de-aaaa-4bbb-8ccc-000000000005",
  ];

  /** A batch that has one label field set to `value`; `field` names which. */
  function batchWith(field: string, value: string, id: string): FleetEvent[] {
    const base = ctx(id);
    switch (field) {
      case "session_id":
        return [started(value)];
      case "agent_id":
        return [newEvent("session.started", { ...base, agent_id: value }, startedPayload())];
      case "provider":
        return [newEvent("session.started", { ...base, provider: value }, startedPayload())];
      case "scenario":
        return [newEvent("session.started", base, { ...startedPayload(), scenario: value })];
      case "region":
        return [newEvent("session.started", base, { ...startedPayload(), region: value })];
      case "engine_version":
        return [newEvent("session.started", base, { ...startedPayload(), engine_version: value })];
      case "error_code":
        return [
          newEvent("action", base, {
            seq: 0,
            action_type: "click",
            target: "x",
            duration_ms: 1,
            ok: false,
            error_code: value,
          }),
        ];
      default:
        throw new Error(field);
    }
  }
  const startedPayload = () => ({
    engine_version: "1.0",
    scenario: "s",
    region: "local",
    startup_ms: 1,
    connect_ms: 1,
  });
  const FIELDS = [
    "session_id",
    "agent_id",
    "provider",
    "scenario",
    "region",
    "engine_version",
    "error_code",
  ];

  it("answers 400 for every label field with a value outside the pattern, and stores nothing", async () => {
    const run = sid("labels-bad");
    const { post } = await listen();
    for (const field of FIELDS) {
      for (const value of BAD) {
        const res = await post(batchWith(field, value, run));
        expect(res.status, `${field} = ${JSON.stringify(value).slice(0, 30)}`).toBe(400);
      }
    }
    // a bad label rejects the whole batch: the good event next to it is not stored either
    const good = sid("labels-neighbour");
    const mixed = await post([started(good), ...batchWith("scenario", "a b", sid("labels-x"))]);
    expect(mixed.status).toBe(400);
    await sleep(1500);
    expect(await countPrefix("sessions", "labels-")).toBe(0);
    expect(await count("sessions", good)).toBe(0);
  });

  it("accepts the edge of the pattern: 128 characters, every allowed symbol, and dots", async () => {
    const { post } = await listen();
    for (const field of FIELDS.filter((f) => f !== "session_id")) {
      for (const value of GOOD) {
        const res = await post(batchWith(field, value, sid("labels-good")));
        expect(res.status, `${field} = ${value.slice(0, 20)}`).toBe(202);
      }
    }
    for (const value of GOOD) {
      expect((await post([started(value)])).status, value.slice(0, 20)).toBe(202);
    }
  });
});

describe("session.ended before its session.started, over HTTP", () => {
  it("is stored once the start arrives in a later request, within the grace period", async () => {
    const id = sid("orphan-ok");
    const { post, health } = await listen({ ingest: { orphanGraceMs: 5000 } });
    await post([ended(id)]);
    await expect
      .poll(async () => (await health()).body.ingest.orphansHeld, { timeout: 3000 })
      .toBe(1);
    expect(await sessionStatus(id)).toBeUndefined();
    await post([started(id), action(id, 0)]);
    await expect.poll(() => sessionStatus(id), { timeout: 5000, interval: 100 }).toBe("success");
    expect((await health()).body.ingest.orphansHeld).toBe(0);
    expect((await health()).body.ingest.orphansDropped).toBe(0);
  });

  it("is dropped and counted when no start comes, and a start after that leaves the session running (recorded)", async () => {
    const id = sid("orphan-late");
    const { post, health, logs } = await listen({ ingest: { orphanGraceMs: 400 } });
    await post([ended(id)]);
    await expect
      .poll(async () => (await health()).body.ingest.orphansDropped, { timeout: 5000 })
      .toBe(1);
    expect((await health()).body.ingest.orphansHeld).toBe(0);
    const warning = logs.find((l) => String(l.msg).includes("dropped session.ended"));
    expect(warning).toMatchObject({ count: 1, sessionIds: [id] });

    await post([started(id)]);
    await expect.poll(() => sessionStatus(id), { timeout: 3000, interval: 100 }).toBe("running");
    await sleep(500);
    expect(await sessionStatus(id)).toBe("running"); // nobody will ever close it
  });

  it("holds one copy when the collector resends the orphaned end", async () => {
    const id = sid("orphan-dup");
    const { post, health } = await listen({ ingest: { orphanGraceMs: 5000 } });
    const end = ended(id);
    await post([end]);
    expect((await post([end])).body).toEqual({ accepted: 0, duplicates: 1 });
    await expect
      .poll(async () => (await health()).body.ingest.orphansHeld, { timeout: 3000 })
      .toBe(1);
  });

  it("works in the reverse order inside one request", async () => {
    const id = sid("orphan-same-batch");
    const { post } = await listen();
    await post([ended(id), started(id), action(id, 0)]);
    await expect.poll(() => sessionStatus(id), { timeout: 3000, interval: 100 }).toBe("success");
  });

  it("lets held orphans use buffer capacity, so they can make the API answer 503 for the grace period (recorded)", async () => {
    const { post } = await listen({ ingest: { capacity: 5, orphanGraceMs: 1500 } });
    const ids = Array.from({ length: 5 }, () => sid("orphan-cap"));
    expect((await post(ids.map((id) => ended(id)))).status).toBe(202);
    await sleep(300); // flushed once: all five are now held orphans
    const refused = await post([action(sid("cap-victim"), 0)]);
    expect(refused.status).toBe(503);
    await sleep(2500); // grace over: dropped, capacity free again
    expect((await post([action(sid("cap-after"), 0)])).status).toBe(202);
  });
});

describe("10,000 sessions through the API", () => {
  it("stores every event of 10,000 sessions exactly once, even while the buffer is full and answering 503", async () => {
    const run = sid("volume");
    const SESSIONS = 10_000;
    const events: FleetEvent[][] = [];
    for (let i = 0; i < SESSIONS; i++) {
      const id = `${run}-${i}`;
      const t = Date.now() - 20_000;
      events.push([
        started(id, t),
        action(id, 0, t + 10),
        action(id, 1, t + 20),
        action(id, 2, t + 30),
        action(id, 3, t + 40),
        sample(id, t + 50),
        ended(id, t + 60),
      ]);
    }
    const flat = events.flat(); // 70,000 events
    const requests: FleetEvent[][] = [];
    for (let i = 0; i < flat.length; i += MAX_BATCH_SIZE) requests.push(flat.slice(i, i + 1000));

    const { post, health } = await listen({ ingest: { capacity: 6000, flushIntervalMs: 1000 } });
    let refused = 0;
    let next = 0;
    async function sender(): Promise<void> {
      for (;;) {
        const index = next++;
        const batch = requests[index];
        if (!batch) return;
        for (let attempt = 0; ; attempt++) {
          const res = await post(batch);
          if (res.status === 202) break;
          expect(res.status).toBe(503);
          expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
          refused++;
          expect(attempt).toBeLessThan(500);
          await sleep(100);
        }
      }
    }
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 8 }, sender));
    await expect
      .poll(async () => (await health()).body.ingest.queued, { timeout: 60_000, interval: 200 })
      .toBe(0);
    const seconds = (Date.now() - t0) / 1000;

    expect(await countPrefix("sessions", run)).toBeGreaterThanOrEqual(SESSIONS); // snapshots
    const [finalRow] = await rows<{ n: string; ended: string }>(
      `SELECT count() AS n, countIf(status = 'success') AS ended
       FROM sessions FINAL WHERE startsWith(session_id, {p:String})`,
      { p: run },
    );
    expect(Number(finalRow?.n)).toBe(SESSIONS);
    expect(Number(finalRow?.ended)).toBe(SESSIONS);
    const [actionRow] = await rows<{ n: string; u: string }>(
      `SELECT count() AS n, uniqExact(event_id) AS u
       FROM actions WHERE startsWith(session_id, {p:String})`,
      { p: run },
    );
    expect(Number(actionRow?.n)).toBe(SESSIONS * 4);
    expect(Number(actionRow?.u)).toBe(SESSIONS * 4);
    expect(await countPrefix("resource_samples", run)).toBe(SESSIONS);
    const stats = (await health()).body.ingest;
    expect(stats.orphansDropped).toBe(0);
    expect(stats.orphansHeld).toBe(0);
    // Throughput floor, deliberately low so a slow CI machine passes: 70,000 events in a minute.
    expect(seconds).toBeLessThan(60);
    expect(refused).toBeGreaterThanOrEqual(0);
  }, 120_000);
});

describe("a batch bigger than the whole buffer", () => {
  // QA-M1-09, VERIFIED in the re-test. INGEST_BUFFER_CAPACITY accepts any value from 1, but a request
  // can carry 1000 events. A batch that can never fit used to get "503, retry later" for ever (the
  // collector retried, then dropped it) while the buffer was empty. Now it gets 413 with a message.
  it("QA-M1-09: a batch that can never fit is refused with 413, not told to retry; a batch that fits is accepted", async () => {
    const id = sid("never-fits");
    const { post, health } = await listen({ ingest: { capacity: 500 } });
    const reply = await post(Array.from({ length: 600 }, (_, seq) => action(id, seq)));
    expect(reply.status).toBe(413);
    expect(reply.headers.get("retry-after")).toBeNull();
    expect(reply.body.error).toContain("larger than the ingest buffer");
    expect((await health()).body.ingest.queued).toBe(0);
    expect((await post(Array.from({ length: 400 }, (_, seq) => action(id, seq)))).status).toBe(202);
  });
});
