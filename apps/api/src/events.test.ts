import {
  type EventEnvelope,
  type FleetEvent,
  INGEST_PATH,
  IngestAcceptedResponse,
  IngestErrorResponse,
  MAX_BATCH_SIZE,
  newEvent,
} from "@fleetscope/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, buildApp } from "./app";
import type { WriteBatch } from "./ingest/buffer";
import { MAX_FUTURE_SKEW_MS, oldestAcceptedTs } from "./ingest/validate";
import { INGEST_BODY_LIMIT_BYTES, RETRY_AFTER_SECONDS } from "./routes/events";

// POST /v1/events through the real Fastify app, with a fake `insert` and a fake clock.
// The flush interval is long, so each test decides when the buffer flushes (app.close() flushes).

const NOW = 1_760_000_000_000;
const ctx: EventEnvelope = {
  session_id: "s1",
  source: "real",
  agent_id: "agent-1",
  engine: "chromium",
  provider: "local-docker",
};
const issue = (ts = NOW) => newEvent("issue", ctx, { kind: "blocked", message: "m" }, ts);

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(deps: Partial<AppDeps> = {}) {
  const writes: FleetEvent[][] = [];
  const insert: WriteBatch = async (events) => {
    writes.push([...events]);
    return { orphans: [] };
  };
  const app = buildApp({
    logLevel: false,
    ping: async () => true,
    insert,
    now: () => NOW,
    ...deps,
    ingest: { flushIntervalMs: 3_600_000, shutdownTimeoutMs: 200, ...deps.ingest },
  });
  apps.push(app);
  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: INGEST_PATH,
      headers: { "content-type": "application/json", ...headers },
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  return { app, writes, post };
}

describe("POST /v1/events", () => {
  it("answers 202 with the counts and does not wait for ClickHouse", async () => {
    const { post, writes } = setup({ insert: () => new Promise(() => {}) });
    const res = await post([issue(), issue()]);
    expect(res.statusCode).toBe(202);
    expect(IngestAcceptedResponse.parse(res.json())).toEqual({ accepted: 2, duplicates: 0 });
    expect(writes).toEqual([]);
  });

  it("writes the events when the buffer flushes (here: on shutdown), in order", async () => {
    const { app, post, writes } = setup();
    const events = [issue(), issue(), issue()];
    await post(events.slice(0, 2));
    await post(events.slice(2));
    expect(writes).toEqual([]);

    await app.close();
    expect(writes).toEqual([events]);
  });

  it("flushes on its own timer", async () => {
    const { app, post, writes } = setup({ ingest: { flushIntervalMs: 20 } });
    await app.ready();
    await post([issue()]);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
  });

  it("counts a resent batch as duplicates and queues nothing twice", async () => {
    const { app, post, writes } = setup();
    const events = [issue(), issue()];
    expect((await post(events)).json()).toEqual({ accepted: 2, duplicates: 0 });
    expect((await post([...events, issue()])).json()).toEqual({ accepted: 1, duplicates: 2 });
    await app.close();
    expect(writes.flat()).toHaveLength(3);
  });

  describe("400", () => {
    it("for malformed JSON", async () => {
      const { post } = setup();
      const res = await post("[{not json");
      expect(res.statusCode).toBe(400);
      expect(IngestErrorResponse.parse(res.json()).error).toContain("not valid JSON");
    });

    it("for an empty body and for a body that is not an array", async () => {
      const { post } = setup();
      expect((await post("")).statusCode).toBe(400);
      expect((await post({ events: [] })).statusCode).toBe(400);
      expect((await post([])).statusCode).toBe(400);
      expect((await post("null")).statusCode).toBe(400);
    });

    it("for an event that breaks the schema, with the zod issues", async () => {
      const { post } = setup();
      const res = await post([issue(), { ...issue(), kind: "nope" }]);
      expect(res.statusCode).toBe(400);
      const body = IngestErrorResponse.parse(res.json());
      expect(body.issues?.some((i) => i.path[0] === 1)).toBe(true);
    });

    it("for a ts more than 5 minutes in the future, naming the indexes", async () => {
      const { post, writes, app } = setup();
      const res = await post([
        issue(),
        issue(NOW + MAX_FUTURE_SKEW_MS + 1),
        issue(NOW + 3_600_000),
      ]);
      expect(res.statusCode).toBe(400);
      const body = IngestErrorResponse.parse(res.json());
      expect(body.error).toContain("indexes 1, 2");
      expect(body.issues?.map((i) => i.path)).toEqual([
        [1, "ts"],
        [2, "ts"],
      ]);
      await app.close();
      expect(writes).toEqual([]); // the good event in the same batch is not accepted either
    });

    it("for a ts older than the retention window, naming the indexes (R-M1-01)", async () => {
      const { post, writes, app } = setup();
      const cutoff = oldestAcceptedTs(NOW);
      const res = await post([issue(), issue(cutoff - 1), issue(NOW - 40 * 86_400_000)]);
      expect(res.statusCode).toBe(400);
      const body = IngestErrorResponse.parse(res.json());
      expect(body.error).toContain("retention window");
      expect(body.error).toContain("indexes 1, 2");
      expect(body.issues?.map((i) => i.path)).toEqual([
        [1, "ts"],
        [2, "ts"],
      ]);
      await app.close();
      expect(writes).toEqual([]);
    });

    it("for a batch spread over 101 days, the one that used to stall ClickHouse", async () => {
      const { post } = setup();
      const res = await post(Array.from({ length: 101 }, (_, i) => issue(NOW - i * 86_400_000)));
      expect(res.statusCode).toBe(400);
    });

    it("accepts a ts exactly 5 minutes ahead", async () => {
      const { post } = setup();
      expect((await post([issue(NOW + MAX_FUTURE_SKEW_MS)])).statusCode).toBe(202);
    });

    it("answers in JSON for a wrong content type too (415 from Fastify, our error shape)", async () => {
      const { post } = setup();
      const res = await post("[]", { "content-type": "application/xml" });
      expect(res.statusCode).toBe(415);
      expect(IngestErrorResponse.safeParse(res.json()).success).toBe(true);
    });
  });

  describe("413", () => {
    it("for more than 1000 events", async () => {
      const { post } = setup();
      const res = await post(Array.from({ length: MAX_BATCH_SIZE + 1 }, () => issue()));
      expect(res.statusCode).toBe(413);
      expect(IngestErrorResponse.parse(res.json()).error).toContain("1001");
    });

    it("accepts exactly 1000", async () => {
      const { post } = setup();
      const res = await post(Array.from({ length: MAX_BATCH_SIZE }, () => issue()));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: MAX_BATCH_SIZE, duplicates: 0 });
    });

    it("for a batch bigger than the whole ingest buffer: it could never fit, so not a retryable 503 (QA-M1-09)", async () => {
      const { post, app } = setup({ ingest: { capacity: 3 } });
      const res = await post([issue(), issue(), issue(), issue()]);
      expect(res.statusCode).toBe(413);
      expect(res.headers["retry-after"]).toBeUndefined();
      expect(IngestErrorResponse.parse(res.json()).error).toContain(
        "larger than the ingest buffer",
      );
      // the same events in two smaller batches go through
      expect((await post([issue(), issue()])).statusCode).toBe(202);
      await app.close();
    });

    it("for a body over the size limit", async () => {
      const { post } = setup();
      const res = await post(`[${" ".repeat(INGEST_BODY_LIMIT_BYTES + 1)}]`);
      expect(res.statusCode).toBe(413);
      expect(IngestErrorResponse.safeParse(res.json()).success).toBe(true);
    });
  });

  describe("503", () => {
    it("with Retry-After when the buffer is full, and queues nothing from that request", async () => {
      const { post, app, writes } = setup({ ingest: { capacity: 3 } });
      expect((await post([issue(), issue()])).statusCode).toBe(202);

      const refused = [issue(), issue()];
      const res = await post(refused);
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe(String(RETRY_AFTER_SECONDS));
      expect(IngestErrorResponse.parse(res.json()).error).toContain("full");

      // Retrying the same events later works: they were not mistaken for duplicates.
      await app.close();
      expect(writes.flat()).toHaveLength(2);
    });

    it("keeps accepting a resent batch of duplicates while full", async () => {
      const { post } = setup({ ingest: { capacity: 2 } });
      const events = [issue(), issue()];
      await post(events);
      const res = await post(events);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: 0, duplicates: 2 });
    });

    it("recovers once the buffer has flushed", async () => {
      const { post, app } = setup({ ingest: { capacity: 2, flushIntervalMs: 20 } });
      await app.ready();
      await post([issue(), issue()]);
      await vi.waitFor(async () => expect((await post([issue()])).statusCode).toBe(202));
    });
  });

  it("is not part of the app when no insert function is given", async () => {
    const { app } = setup({ insert: undefined });
    const res = await app.inject({ method: "POST", url: INGEST_PATH, payload: "[]" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /healthz with the ingest buffer", () => {
  it("adds the buffer numbers and keeps the liveness status", async () => {
    const { app, post } = setup({ ingest: { capacity: 100 } });
    await post([issue(), issue()]);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      clickhouse: "ok",
      schemaVersion: 1,
      ingest: {
        queued: 2,
        capacity: 100,
        oldestAgeMs: 0,
        retrying: false,
        lastFlushAt: null,
        lastFlushError: null,
        orphansHeld: 0,
        orphansDropped: 0,
        deadLettered: 0,
      },
    });
  });

  it("is still 503 only when ClickHouse is down, and still shows the queue", async () => {
    const { app, post } = setup({ ping: async () => false });
    await post([issue()]);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "degraded",
      clickhouse: "down",
      ingest: { queued: 1 },
    });
  });

  it("shows why the last flush failed, but only the error's name", async () => {
    const { app, post } = setup({
      insert: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:8123"), {
          code: "ECONNREFUSED",
        });
      },
      ingest: { flushIntervalMs: 20, retryBaseMs: 5, retryMaxMs: 5 },
    });
    await app.ready();
    await post([issue()]);
    await vi.waitFor(async () => {
      const body = (await app.inject({ method: "GET", url: "/healthz" })).json();
      expect(body.ingest).toMatchObject({
        retrying: true,
        queued: 1,
        lastFlushError: { error: "Error ECONNREFUSED" },
      });
    });
    const text = (await app.inject({ method: "GET", url: "/healthz" })).body;
    expect(text).not.toContain("10.1.2.3");
  });
});

describe("shutdown", () => {
  it("flushes what was accepted before it closes", async () => {
    const { app, post, writes } = setup();
    await post([issue(), issue()]);
    await app.close();
    expect(writes.flat()).toHaveLength(2);
  });

  it("stops listening before it flushes, so nothing can arrive after the last flush", async () => {
    const order: string[] = [];
    const { app, post } = setup({
      insert: async (events) => {
        order.push(`flush ${events.length}`);
        return { orphans: [] };
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    app.server.on("close", () => order.push("server closed"));
    await post([issue(), issue()]);

    await app.close();
    expect(order).toEqual(["server closed", "flush 2"]);
  });

  it("finishes in-flight requests first, so a request that was answered 202 is never lost", async () => {
    const { app, writes } = setup();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const events = [issue(), issue()];
    const sent = fetch(`http://127.0.0.1:${port}${INGEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(events),
    });
    const response = await sent;
    expect(response.status).toBe(202);
    await app.close();
    expect(writes.flat()).toEqual(events);
  });
});
