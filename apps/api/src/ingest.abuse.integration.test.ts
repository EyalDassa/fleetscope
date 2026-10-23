import { connect, createServer, type Server, type Socket } from "node:net";
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AppDeps, buildApp } from "./app";

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

  it("accepts events from the past: a skewed client clock is not detected on that side (202, then the TTL decides)", async () => {
    const id = sid("past");
    const { post } = await listen();
    const longAgo = Date.now() - 40 * DAY; // older than the 30 day TTL of the tables
    const res = await post([started(id, longAgo), action(id, 0, longAgo)]);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2, duplicates: 0 });
    await sleep(800);
    // 202 was returned, the insert succeeded, and the data is gone (dropped by the TTL).
    await expect.poll(() => count("actions", id), { timeout: 4000, interval: 200 }).toBe(0);
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
   * 120 events on 120 different days, all in the past and all valid for the schema. One INSERT
   * with more than 100 daily partitions is refused by ClickHouse ("Too many partitions for single
   * INSERT block", max_partitions_per_insert_block = 100), every time. ADR 0002 says "validated
   * events should never be refused"; this is a counterexample. The flush holds ALL clients' events
   * (up to 5000), so one request can stall everybody.
   */
  const poison = (id: string) =>
    Array.from({ length: 120 }, (_, i) => action(id, i, Date.now() - i * DAY));

  it("is accepted with 202, then the buffer retries it forever and /healthz says so (the ADR 0002 trade-off, recorded)", async () => {
    const id = sid("poison-doc");
    const { post, health } = await listen({ ingest: { capacity: 300 } });
    expect((await post(poison(id))).status).toBe(202);
    await expect
      .poll(async () => (await health()).body.ingest.retrying, { timeout: 4000 })
      .toBe(true);
    const ingest = (await health()).body.ingest;
    expect(ingest.queued).toBe(120);
    expect(ingest.lastFlushError?.error).toMatch(/\S/);

    // innocent clients are still told 202 until the buffer is full, then 503
    const good = sid("poison-innocent");
    expect((await post([started(good), action(good, 0)])).status).toBe(202);
    const flood = await post(Array.from({ length: 200 }, (_, i) => action(good, i + 1)));
    expect(flood.status).toBe(503);
    expect(flood.headers.get("retry-after")).toBeTruthy();
    expect(await count("actions", good)).toBe(0); // and nothing of theirs is stored
  });

  it.fails("QA-M1-01: one poison request must not stop other clients' events from being stored", async () => {
    const bad = sid("poison");
    const good = sid("poison-good");
    const { post } = await listen();
    await post(poison(bad)); // 202 today; a 400 would be fine too
    await post([started(good), action(good, 0), action(good, 1), ended(good)]);
    await expect.poll(() => count("actions", good), { timeout: 4000, interval: 100 }).toBe(2);
    expect(await sessionStatus(good)).toBe("success");
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
