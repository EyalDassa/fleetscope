import { type FleetEvent, newEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { EventQueue } from "./queue";
import { recordingTransport, silentLogger } from "./test-utils";
import type { SendResult, Transport } from "./transport";

const envelope = {
  session_id: "s1",
  source: "real",
  agent_id: "a1",
  engine: "chromium",
  provider: "local-docker",
} as const;

function action(seq: number): FleetEvent {
  return newEvent("action", envelope, {
    seq,
    action_type: "click",
    target: "#go",
    duration_ms: 5,
    ok: true,
    error_code: null,
  });
}

function sample(): FleetEvent {
  return newEvent("resource.sample", envelope, {
    origin: "cdp",
    cpu_pct: null,
    mem_mb: null,
    net_rx_bytes: null,
    net_tx_bytes: null,
    js_heap_mb: 1,
  });
}

function queueWith(
  transport: Transport,
  options: Partial<ConstructorParameters<typeof EventQueue>[0]> = {},
) {
  return new EventQueue({
    transport,
    logger: silentLogger,
    flushIntervalMs: 10_000, // tests flush by hand unless they are about the timer
    ...options,
  });
}

describe("EventQueue", () => {
  it("sends nothing until the size or the interval triggers, then everything in one batch", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport);
    for (let i = 0; i < 3; i++) queue.push(action(i));
    expect(sink.batches).toHaveLength(0);

    await queue.flush();
    expect(sink.batches.map((b) => b.length)).toEqual([3]);
    await queue.close();
  });

  it("flushes on its own when flushSize events are waiting", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport, { flushSize: 5 });
    for (let i = 0; i < 5; i++) queue.push(action(i));
    await queue.flush();
    expect(sink.events).toHaveLength(5);
    await queue.close();
  });

  it("flushes on the interval", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport, { flushIntervalMs: 20 });
    queue.push(action(0));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sink.events).toHaveLength(1);
    await queue.close();
  });

  it("never sends more than maxBatchSize per request", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport, { maxBatchSize: 1000, flushSize: 100_000 });
    for (let i = 0; i < 2500; i++) queue.push(action(i));
    await queue.flush();
    expect(sink.batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    await queue.close();
  });

  it("keeps events in the order they were pushed, even across slow sends", async () => {
    const seen: number[] = [];
    let slow = true;
    const transport: Transport = {
      async send(events) {
        if (slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 30)); // first batch is slow
        }
        for (const event of events) if (event.type === "action") seen.push(event.seq);
        return { status: "accepted", accepted: events.length, duplicates: 0 };
      },
    };
    const queue = queueWith(transport, { flushSize: 2, maxBatchSize: 2 });
    for (let i = 0; i < 8; i++) queue.push(action(i));
    await queue.flush();
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await queue.close();
  });

  it("never has two sends in flight at once", async () => {
    let active = 0;
    let maxActive = 0;
    const transport: Transport = {
      async send(events) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { status: "accepted", accepted: events.length, duplicates: 0 };
      },
    };
    const queue = queueWith(transport, { flushSize: 1, maxBatchSize: 1 });
    for (let i = 0; i < 10; i++) queue.push(action(i));
    await queue.flush();
    expect(maxActive).toBe(1);
    await queue.close();
  });

  it("counts a rejected batch as dropped and keeps sending the rest", async () => {
    const results: SendResult[] = [
      { status: "rejected", httpStatus: 400, error: "bad" },
      { status: "accepted", accepted: 1, duplicates: 0 },
    ];
    const batches: FleetEvent[][] = [];
    const transport: Transport = {
      async send(events) {
        batches.push([...events]);
        return results.shift() ?? { status: "accepted", accepted: events.length, duplicates: 0 };
      },
    };
    const queue = queueWith(transport, { maxBatchSize: 2, flushSize: 100 });
    for (let i = 0; i < 3; i++) queue.push(action(i));
    await queue.flush();

    expect(batches).toHaveLength(2);
    expect(queue.stats()).toMatchObject({ pushed: 3, sent: 1, dropped: 2, pending: 0 });
    await queue.close();
  });

  it("counts a transport that throws as dropped instead of crashing", async () => {
    const transport: Transport = {
      async send() {
        throw new Error("kaboom");
      },
    };
    const queue = queueWith(transport);
    queue.push(action(0));
    await queue.flush();
    expect(queue.stats().dropped).toBe(1);
    await queue.close();
  });

  it("tracks accepted and duplicate counts from the API", async () => {
    const sink = recordingTransport(() => ({ status: "accepted", accepted: 1, duplicates: 1 }));
    const queue = queueWith(sink.transport);
    queue.push(action(0));
    queue.push(action(1));
    await queue.flush();
    expect(queue.stats()).toMatchObject({ sent: 1, duplicates: 1 });
    await queue.close();
  });

  it("when the buffer is full, drops samples but keeps session and action events", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport, { maxBuffered: 3, flushSize: 100 });
    queue.push(action(0));
    queue.push(action(1));
    queue.push(action(2));
    queue.push(sample()); // dropped: buffer is at its limit
    queue.push(action(3)); // kept
    await queue.flush();
    expect(sink.events.map((e) => e.type)).toEqual(["action", "action", "action", "action"]);
    expect(queue.stats().dropped).toBe(1);
    await queue.close();
  });

  it("close() drains what is left", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport);
    queue.push(action(0));
    await queue.close();
    expect(sink.events).toHaveLength(1);
  });

  it("close() gives up at the deadline, aborts the send and counts the loss", async () => {
    let aborted = false;
    const transport: Transport = {
      send(_events, options) {
        return new Promise<SendResult>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve({ status: "failed", error: "aborted" });
          });
        });
      },
    };
    const queue = queueWith(transport, { maxBatchSize: 1, flushSize: 100 });
    queue.push(action(0));
    queue.push(action(1));

    const started = Date.now();
    await queue.close(50);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(queue.stats()).toMatchObject({ dropped: 2, pending: 0 });
  });

  it("drops events pushed after close", async () => {
    const sink = recordingTransport();
    const queue = queueWith(sink.transport);
    await queue.close();
    queue.push(action(0));
    expect(queue.stats().dropped).toBe(1);
    expect(sink.events).toHaveLength(0);
  });
});
