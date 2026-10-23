import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventBatch, type FleetEvent } from "@fleetscope/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createCollector } from "./collector";
import { isMissingApiError } from "./errors";
import { FakePage, sessionOptions, silentLogger } from "./test-utils";
import { createHttpTransport } from "./transport";

/**
 * QA, M1: the collector against a REAL HTTP server (node:http) that misbehaves on purpose: it
 * rejects, throttles, hangs, drops the connection after processing, and goes away. The unit tests
 * use a fake transport; this file checks the retry contract on the wire.
 */

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  events: FleetEvent[],
  attempt: number,
) => void;

interface FakeApi {
  url: string;
  /** Every request, parsed, in order. */
  received: FleetEvent[][];
  /** Event ids the server has already processed (what a deduplicating API would remember). */
  processedIds: Set<string>;
  close(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

async function fakeApi(handler: Handler): Promise<FakeApi> {
  const received: FleetEvent[][] = [];
  const processedIds = new Set<string>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const events = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FleetEvent[];
      received.push(events);
      handler(request, response, events, received.length);
      for (const event of events) processedIds.add(event.event_id);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    processedIds,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const accept: Handler = (_req, res, events) => {
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ accepted: events.length, duplicates: 0 }));
};

function collectorFor(apiUrl: string, extra: { transportOptions?: object } = {}) {
  const transport = createHttpTransport({
    apiUrl,
    logger: silentLogger,
    baseDelayMs: 10,
    maxDelayMs: 40,
    requestTimeoutMs: 400,
    ...extra.transportOptions,
  });
  return createCollector({
    apiUrl,
    source: "real",
    agentId: "qa",
    provider: "local-docker",
    engine: "chromium",
    transport,
    logger: silentLogger,
    flushIntervalMs: 20,
    flushSize: 5,
    heapSampleIntervalMs: 0,
  });
}

/** One short session of `actions` goto actions on a fake page. */
async function runSession(collector: ReturnType<typeof collectorFor>, actions: number) {
  const session = collector.startSession(sessionOptions);
  const fake = new FakePage();
  const page = await session.collectPage(fake.asPage());
  for (let i = 0; i < actions; i++) await page.goto(`http://demo.test/${i}`);
  await session.endSession("success");
  return session;
}

describe("the collector on the wire", () => {
  it("delivers a whole session to a healthy API in order, valid against the schema", async () => {
    const api = await fakeApi(accept);
    const collector = collectorFor(api.url);
    await runSession(collector, 12);
    await collector.close();
    const all = api.received.flat();
    expect(EventBatch.safeParse(all).success).toBe(true);
    expect(all[0]?.type).toBe("session.started");
    expect(all.at(-1)?.type).toBe("session.ended");
    expect(all.filter((e) => e.type === "action").map((e) => (e as { seq: number }).seq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
    expect(collector.stats()).toMatchObject({ pushed: 14, sent: 14, dropped: 0, pending: 0 });
  });

  it("a 400 is not retried: that batch is dropped and counted, the session ids are logged, later batches still flow", async () => {
    let first = true;
    const api = await fakeApi((req, res, events) => {
      if (first) {
        first = false;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid event batch", issues: [] }));
        return;
      }
      accept(req, res, events, 0);
    });
    const collector = collectorFor(api.url);
    const session = collector.startSession(sessionOptions);
    const page = await session.collectPage(new FakePage().asPage());
    for (let i = 0; i < 5; i++) await page.goto(`http://demo.test/${i}`); // 6 events: one batch of 5
    await collector.flush();
    for (let i = 0; i < 5; i++) await page.goto(`http://demo.test/more-${i}`);
    await session.endSession("success");
    await collector.close();

    expect(api.received[0]).toHaveLength(5); // the rejected batch was sent exactly once
    const stats = collector.stats();
    expect(stats.dropped).toBe(5);
    expect(stats.sent).toBe(stats.pushed - 5);
    expect(api.received.at(-1)?.at(-1)?.type).toBe("session.ended");
  });

  it("a 503 with Retry-After is retried with the very same events (same event_id), after waiting", async () => {
    const api = await fakeApi((req, res, events, attempt) => {
      if (attempt <= 2) {
        res.writeHead(503, { "retry-after": "0.15", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "ingest buffer is full, retry later" }));
        return;
      }
      accept(req, res, events, attempt);
    });
    const collector = collectorFor(api.url);
    const t0 = Date.now();
    await runSession(collector, 3);
    await collector.close();

    expect(Date.now() - t0).toBeGreaterThanOrEqual(280); // two waits of 150 ms
    expect(api.received.length).toBeGreaterThanOrEqual(3);
    const ids = (batch: FleetEvent[] | undefined) => (batch ?? []).map((e) => e.event_id);
    expect(ids(api.received[1])).toEqual(ids(api.received[0]));
    expect(ids(api.received[2])).toEqual(ids(api.received[0]));
    expect(collector.stats()).toMatchObject({ sent: 5, dropped: 0 });
    // nothing after the retried batch overtook it
    const delivered = api.received.slice(2).flat();
    expect(delivered[0]?.type).toBe("session.started");
    expect(delivered.at(-1)?.type).toBe("session.ended");
  });

  it("a plain 500 is retried with backoff and succeeds when the API recovers", async () => {
    const api = await fakeApi((req, res, events, attempt) => {
      if (attempt <= 3) {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      accept(req, res, events, attempt);
    });
    const collector = collectorFor(api.url);
    await runSession(collector, 2);
    await collector.close();
    expect(collector.stats()).toMatchObject({ pushed: 4, sent: 4, dropped: 0 });
  });

  it("gives up after maxAttempts on a permanently failing API and counts every event as dropped, without throwing", async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(500);
      res.end("down for good");
    });
    const collector = collectorFor(api.url, { transportOptions: { maxAttempts: 3 } });
    await runSession(collector, 3);
    await collector.close(5000);
    expect(api.received.length).toBeGreaterThanOrEqual(3);
    expect(api.received.length % 3).toBe(0); // every batch was tried exactly 3 times
    expect(collector.stats()).toMatchObject({ pushed: 5, sent: 0, dropped: 5, pending: 0 });
  });

  it("a retried batch that the server had already processed (lost answer) carries the same ids, so a deduplicating API can recognise it", async () => {
    let attempt = 0;
    const api = await fakeApi((req, res, events) => {
      attempt++;
      if (attempt === 1) {
        // the server took the batch, then the connection died before the answer
        req.socket.destroy();
        return;
      }
      accept(req, res, events, attempt);
    });
    const collector = collectorFor(api.url);
    await runSession(collector, 1);
    await collector.close();
    const first = api.received[0]?.map((e) => e.event_id) ?? [];
    const second = api.received[1]?.map((e) => e.event_id) ?? [];
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it("close() with the API gone returns within its timeout, counts what was lost and leaves nothing pending", async () => {
    const api = await fakeApi(accept);
    const url = api.url;
    await api.close(); // nothing listens on this port any more
    const collector = collectorFor(url, {
      transportOptions: { baseDelayMs: 200, maxDelayMs: 400 },
    });
    await runSession(collector, 4);
    const t0 = Date.now();
    await collector.close(600);
    expect(Date.now() - t0).toBeLessThan(1500);
    const stats = collector.stats();
    expect(stats.pushed).toBe(6);
    expect(stats.sent).toBe(0);
    expect(stats.dropped).toBe(6);
    expect(stats.pending).toBe(0);
  });

  it("close() with an API that accepts the connection and never answers is bounded too", async () => {
    const api = await fakeApi(() => {
      // never respond
    });
    const collector = collectorFor(api.url, { transportOptions: { requestTimeoutMs: 5000 } });
    await runSession(collector, 2);
    const t0 = Date.now();
    await collector.close(500);
    expect(Date.now() - t0).toBeLessThan(1500);
    // a moment later every event is accounted for as lost
    await expect
      .poll(() => collector.stats(), { timeout: 2000 })
      .toMatchObject({
        sent: 0,
        dropped: 4,
        pending: 0,
      });
  });

  // QA-M1-04: close() resolves at its deadline, but the batch that was in flight is only counted
  // as dropped a moment later (when the aborted request settles). The runner reads stats() right
  // after close(), so its summary says "0 dropped" and the exit code stays 0 although events were
  // lost. (With the API refusing connections the abort settles first, so that case looks fine.)
  it.fails("QA-M1-04: stats() right after close() already counts the in-flight batch as dropped", async () => {
    const api = await fakeApi(() => {
      // never respond
    });
    const collector = collectorFor(api.url, { transportOptions: { requestTimeoutMs: 5000 } });
    await runSession(collector, 2);
    await collector.close(500);
    expect(collector.stats()).toMatchObject({ sent: 0, dropped: 4, pending: 0 });
  });

  it("a slow API does not slow the scenario: pushing events never waits for the network", async () => {
    const api = await fakeApi((req, res, events) => {
      setTimeout(() => accept(req, res, events, 0), 1500);
    });
    const collector = collectorFor(api.url, { transportOptions: { requestTimeoutMs: 5000 } });
    const session = collector.startSession(sessionOptions);
    const page = await session.collectPage(new FakePage().asPage());
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) await page.goto(`http://demo.test/${i}`);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // 100 actions while every request takes 1.5 s
    await session.endSession("success");
    await collector.close(10_000);
    expect(collector.stats()).toMatchObject({ pushed: 102, sent: 102, dropped: 0 });
  }, 20_000);

  it("a 202 whose body is not JSON still counts the batch as accepted", async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(202);
      res.end("ok");
    });
    const collector = collectorFor(api.url);
    await runSession(collector, 1);
    await collector.close();
    expect(collector.stats()).toMatchObject({ pushed: 3, sent: 3, dropped: 0 });
  });

  it("a 413 is never retried (the batch itself is the problem)", async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Request body is too large" }));
    });
    const collector = collectorFor(api.url);
    await runSession(collector, 1);
    await collector.close();
    // one try per batch: the 3 events leave in one or two batches, never retried
    expect(api.received.length).toBeLessThanOrEqual(2);
    expect(collector.stats().dropped).toBe(3);
  });
});

describe("what counts as a missing browser API", () => {
  // The demo site's /js-heavy page lets a missing API throw a real error, and its README lists
  // the messages. The collector turns a page error into an `unsupported_api` issue only when
  // isMissingApiError() says so.
  it("recognises 'X is not defined' (ReferenceError)", () => {
    expect(
      isMissingApiError({ name: "ReferenceError", message: "IntersectionObserver is not defined" }),
    ).toBe(true);
    expect(isMissingApiError({ name: "Error", message: "Worker is not defined" })).toBe(true);
  });

  it("does not call an ordinary page bug a missing API", () => {
    expect(isMissingApiError({ name: "TypeError", message: "x.map is not a function" })).toBe(
      false,
    );
    expect(isMissingApiError({ name: "Error", message: "Network request failed" })).toBe(false);
  });

  // QA-M1-03 (forward-looking, M3): the same page, on an engine without crypto.subtle, throws
  // "TypeError: Cannot read properties of undefined (reading 'digest')" (the README of the demo
  // site shows exactly this message). The collector ignores it, so the WebCrypto gap would not
  // show up in the compatibility matrix. The same goes for "X is not a constructor".
  it.fails("QA-M1-03: recognises a missing crypto.subtle (TypeError ... reading 'digest')", () => {
    expect(
      isMissingApiError({
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'digest')",
      }),
    ).toBe(true);
  });

  it.fails("QA-M1-03: recognises 'X is not a constructor' for a global that exists but is not usable", () => {
    expect(
      isMissingApiError({
        name: "TypeError",
        message: "IntersectionObserver is not a constructor",
      }),
    ).toBe(true);
  });
});
