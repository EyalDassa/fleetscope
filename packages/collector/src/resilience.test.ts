import type { FleetEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { createCollector } from "./collector";
import { EventQueue } from "./queue";
import { recordingTransport, sessionOptions, silentLogger } from "./test-utils";
import { createHttpTransport, type SendResult, type Transport } from "./transport";

/**
 * A pretend network with a pretend clock: `sleep` moves the clock instead of waiting, so a
 * ten-minute outage takes a few milliseconds. `answer(clock)` decides what the API says at that time.
 */
function virtualNetwork(answer: (clockMs: number) => "down" | number) {
  let clock = 0;
  const bodies: string[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    const result = answer(clock);
    if (result === "down") throw new TypeError("fetch failed");
    if (result === 202) {
      const events = JSON.parse(String(init?.body ?? "[]")) as unknown[];
      return new Response(JSON.stringify({ accepted: events.length, duplicates: 0 }), {
        status: 202,
      });
    }
    return new Response(JSON.stringify({ error: "buffer full" }), {
      status: result,
      headers: result === 503 ? { "retry-after": "2" } : {},
    });
  }) as unknown as typeof fetch;
  const transport = createHttpTransport({
    apiUrl: "http://api.test",
    logger: silentLogger,
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
  });
  return {
    transport,
    bodies,
    sleeps,
    get clock() {
      return clock;
    },
  };
}

function collectorOver(transport: Transport) {
  return createCollector({
    apiUrl: "http://api.test",
    source: "real",
    agentId: "test",
    provider: "local-docker",
    engine: "chromium",
    transport,
    logger: silentLogger,
    flushIntervalMs: 5,
    flushSize: 3,
    heapSampleIntervalMs: 0,
  });
}

async function oneSession(collector: ReturnType<typeof collectorOver>, actions: number) {
  const session = collector.startSession(sessionOptions);
  for (let i = 0; i < actions; i++) {
    session.recordAction({
      seq: session.nextSeq(),
      startedAt: Date.now(),
      type: "goto",
      target: "demo.test",
      durationMs: 5,
      ok: true,
      errorCode: null,
    });
  }
  await session.endSession("success");
}

describe("the API is away for a long time (R-M1-03)", () => {
  it("one minute of connection refused, then it is back: every event arrives, in order, none dropped", async () => {
    const net = virtualNetwork((clock) => (clock < 60_000 ? "down" : 202));
    const collector = collectorOver(net.transport);
    await oneSession(collector, 9);
    await collector.flush();
    await collector.close();

    expect(collector.stats()).toMatchObject({ pushed: 11, sent: 11, dropped: 0, pending: 0 });
    expect(net.clock).toBeGreaterThanOrEqual(60_000);
    // The old limit was 8 tries (about 14 to 26 s); this needed far more.
    expect(net.sleeps.length).toBeGreaterThan(8);
  });

  it("the events that piled up behind the stuck batch arrive after it, in the order they were produced", async () => {
    const received: FleetEvent[] = [];
    const net = virtualNetwork((clock) => (clock < 30_000 ? 503 : 202));
    const spy: Transport = {
      async send(events, options) {
        const result = await net.transport.send(events, options);
        if (result.status === "accepted") received.push(...events);
        return result;
      },
    };
    const collector = collectorOver(spy);
    await oneSession(collector, 5); // the first batch gets stuck on the 503s ...
    await oneSession(collector, 5); // ... and these events wait behind it
    await collector.flush();
    await collector.close();

    expect(collector.stats().dropped).toBe(0);
    expect(received).toHaveLength(14);
    const types = received.map((e) => e.type);
    expect(types[0]).toBe("session.started");
    // per session: started first, ended last
    for (const id of new Set(received.map((e) => e.session_id))) {
      const mine = received.filter((e) => e.session_id === id).map((e) => e.type);
      expect(mine[0]).toBe("session.started");
      expect(mine.at(-1)).toBe("session.ended");
    }
    for (const id of new Set(received.map((e) => e.session_id))) {
      const seqs = received
        .filter((e) => e.session_id === id && e.type === "action")
        .map((e) => (e as { seq: number }).seq);
      expect(seqs).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("every retry resends the very same events (same event_id), so a late resend is a recognised duplicate", async () => {
    const net = virtualNetwork((clock) => (clock < 20_000 ? 500 : 202));
    const result = await net.transport.send([sampleEvent()]);
    expect(result.status).toBe("accepted");
    expect(net.bodies.length).toBeGreaterThan(3);
    expect(new Set(net.bodies).size).toBe(1);
  });

  it("honours Retry-After on a 503 without hammering", async () => {
    const net = virtualNetwork((clock) => (clock < 10_000 ? 503 : 202));
    await net.transport.send([sampleEvent()]);
    expect(net.sleeps.every((ms) => ms === 2000)).toBe(true);
    expect(net.bodies.length).toBeLessThanOrEqual(7);
  });

  it("gives up on a batch only after ten minutes, and says how long it tried", async () => {
    const net = virtualNetwork(() => "down");
    const result = await net.transport.send([sampleEvent()]);
    expect(result.status).toBe("failed");
    expect(net.clock).toBeGreaterThanOrEqual(600_000);
    expect(net.clock).toBeLessThan(600_000 + 15_000); // the last sleep is at most one backoff step
    expect((result as { error: string }).error).toMatch(/gave up after \d+ attempts, 6\d\ds/);
  });

  it("the ten minutes stay under the API's 15-minute duplicate window", async () => {
    // The API remembers event ids for 15 minutes (ADR 0002); a resend after more than that would
    // not be recognised, so the transport must stop before. Guard the default against edits.
    const net = virtualNetwork(() => "down");
    await net.transport.send([sampleEvent()]);
    expect(net.clock).toBeLessThan(15 * 60_000);
  });

  it("a 400 still ends a batch at once, outage or not", async () => {
    const net = virtualNetwork(() => 400);
    const result = await net.transport.send([sampleEvent()]);
    expect(result.status).toBe("rejected");
    expect(net.bodies).toHaveLength(1);
  });
});

describe("close() leaves final numbers (QA-M1-04)", () => {
  function queueOver(transport: Transport) {
    return new EventQueue({
      transport,
      logger: silentLogger,
      flushIntervalMs: 10_000,
      flushSize: 100,
      maxBatchSize: 2,
    });
  }

  it("a send that honours the abort: its events are counted as dropped by the time close() returns", async () => {
    const transport: Transport = {
      send: (_events, options) =>
        new Promise<SendResult>((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            // The real HTTP transport answers a moment after the abort, not synchronously.
            setTimeout(() => resolve({ status: "failed", error: "aborted" }), 20),
          );
        }),
    };
    const queue = queueOver(transport);
    for (let i = 0; i < 5; i++) queue.push(sampleEvent());
    await queue.close(30);

    expect(queue.stats()).toMatchObject({ pushed: 5, sent: 0, dropped: 5, pending: 0 });
  });

  it("a send that ignores the abort: counted as dropped anyway, and its late answer changes nothing", async () => {
    let answer: ((r: SendResult) => void) | undefined;
    const transport: Transport = {
      send: () =>
        new Promise<SendResult>((resolve) => {
          answer = resolve;
        }),
    };
    const queue = queueOver(transport);
    for (let i = 0; i < 5; i++) queue.push(sampleEvent());
    await queue.close(30);

    expect(queue.stats()).toMatchObject({ sent: 0, dropped: 5, pending: 0 });
    answer?.({ status: "accepted", accepted: 2, duplicates: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue.stats()).toMatchObject({ sent: 0, dropped: 5, pending: 0 });
  });

  it("when everything was sent in time nothing is dropped", async () => {
    const sink = recordingTransport();
    const queue = queueOver(sink.transport);
    for (let i = 0; i < 5; i++) queue.push(sampleEvent());
    await queue.close(1000);
    expect(queue.stats()).toMatchObject({ sent: 5, dropped: 0, pending: 0 });
  });
});

function sampleEvent(): FleetEvent {
  return {
    v: 1,
    type: "action",
    event_id: crypto.randomUUID(),
    ts: Date.now(),
    session_id: "s1",
    source: "real",
    agent_id: "a",
    engine: "chromium",
    provider: "local-docker",
    seq: 0,
    action_type: "goto",
    target: "demo.test",
    duration_ms: 1,
    ok: true,
    error_code: null,
  };
}
