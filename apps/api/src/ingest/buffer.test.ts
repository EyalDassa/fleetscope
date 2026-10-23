import { ClickHouseError, INSERT_TABLES } from "@fleetscope/db";
import {
  type EventEnvelope,
  type FleetEvent,
  newEvent,
  type SessionEndedEvent,
} from "@fleetscope/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  type DeadLetter,
  IngestBuffer,
  type IngestBufferOptions,
  type WriteBatch,
} from "./buffer";

// The buffer is tested without Fastify and without ClickHouse: `write` is a fake, and the clock
// is a variable. Retry delays are real but a few milliseconds long.

const T0 = 1_760_000_000_000;

function envelope(session_id: string): EventEnvelope {
  return {
    session_id,
    source: "real",
    agent_id: "agent-1",
    engine: "chromium",
    provider: "local-docker",
  };
}

let seq = 0;
/** A valid action event with a fresh event_id. */
function action(session_id = "s1", ts = T0): FleetEvent {
  return newEvent(
    "action",
    envelope(session_id),
    {
      seq: seq++,
      action_type: "goto",
      target: "example.com",
      duration_ms: 5,
      ok: true,
      error_code: null,
    },
    ts,
  );
}
function ended(session_id: string, ts = T0): SessionEndedEvent {
  return newEvent(
    "session.ended",
    envelope(session_id),
    { status: "success", reason: null, duration_ms: 100 },
    ts,
  );
}

/** A fake clock and a logger that records what was logged. */
function setup(
  write: WriteBatch,
  options: Partial<IngestBufferOptions> = {},
  random = () => 0.5,
  deadLetter?: DeadLetter,
) {
  let now = T0;
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const record = (level: string) => (obj: object, msg: string) =>
    void logs.push({ level, obj: obj as Record<string, unknown>, msg });
  const buffer = new IngestBuffer({
    write,
    log: { debug: record("debug"), warn: record("warn"), error: record("error") },
    now: () => now,
    random,
    deadLetter,
    options: { retryBaseMs: 1, retryMaxMs: 2, shutdownTimeoutMs: 50, ...options },
  });
  return {
    buffer,
    logs,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

/** A `write` that records every call and always succeeds. */
function recordingWrite() {
  const calls: Array<{ events: FleetEvent[]; tokens: Record<string, string> }> = [];
  const write: WriteBatch = async (events, tokens) => {
    calls.push({ events: [...events], tokens: { ...tokens } as Record<string, string> });
    return { orphans: [] };
  };
  return { write, calls };
}

const buffers: IngestBuffer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(buffers.splice(0).map((buffer) => buffer.close()));
});
function track<T extends { buffer: IngestBuffer }>(made: T): T {
  buffers.push(made.buffer);
  return made;
}

describe("offer", () => {
  it("answers at once, without waiting for ClickHouse", async () => {
    const write = vi.fn<WriteBatch>(() => new Promise(() => {})); // never finishes
    const { buffer } = track(setup(write));
    const result = buffer.offer([action(), action()]);
    expect(result).toEqual({ ok: true, accepted: 2, duplicates: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(buffer.stats().queued).toBe(2);
  });

  it("counts repeated event ids as duplicates and does not queue them", () => {
    const { buffer } = track(setup(recordingWrite().write));
    const event = action();
    expect(buffer.offer([event])).toEqual({ ok: true, accepted: 1, duplicates: 0 });
    expect(buffer.offer([event, action()])).toEqual({ ok: true, accepted: 1, duplicates: 1 });
    expect(buffer.stats().queued).toBe(2);
  });

  it("treats ids that differ only in case as the same event", () => {
    const { buffer } = track(setup(recordingWrite().write));
    const event = action();
    const shouting = { ...event, event_id: event.event_id.toUpperCase() };
    buffer.offer([event]);
    expect(buffer.offer([shouting])).toEqual({ ok: true, accepted: 0, duplicates: 1 });
  });

  it("counts a repeat inside the same batch as a duplicate", () => {
    const { buffer } = track(setup(recordingWrite().write));
    const event = action();
    expect(buffer.offer([event, event, event])).toEqual({ ok: true, accepted: 1, duplicates: 2 });
  });

  it("forgets ids after the duplicate window, and when the id limit is exceeded", () => {
    const aged = track(setup(recordingWrite().write, { duplicateWindowMs: 1000 }));
    const event = action();
    aged.buffer.offer([event]);
    aged.tick(999);
    expect(aged.buffer.offer([event])).toMatchObject({ accepted: 0, duplicates: 1 });
    aged.tick(2);
    expect(aged.buffer.offer([event])).toMatchObject({ accepted: 1, duplicates: 0 });

    const limited = track(setup(recordingWrite().write, { duplicateWindowMaxIds: 2 }));
    const [a, b, c] = [action(), action(), action()] as [FleetEvent, FleetEvent, FleetEvent];
    limited.buffer.offer([a, b, c]); // a is pushed out by c
    expect(limited.buffer.offer([c])).toMatchObject({ duplicates: 1 });
    expect(limited.buffer.offer([a])).toMatchObject({ accepted: 1 });
  });
});

describe("capacity", () => {
  it("refuses a batch that does not fit, queues none of it, and does not remember its ids", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write, { capacity: 3 }));
    buffer.offer([action(), action()]);

    const second = [action(), action()];
    expect(buffer.offer(second)).toEqual({ ok: false, reason: "full" });
    expect(buffer.stats().queued).toBe(2);

    // After a flush there is room, and the same events are accepted: they were never "seen".
    await buffer.flush();
    expect(buffer.offer(second)).toEqual({ ok: true, accepted: 2, duplicates: 0 });
    await buffer.flush();
    expect(calls.map((call) => call.events.length)).toEqual([2, 2]);
  });

  it("still accepts a batch of nothing but duplicates when it is full", () => {
    const { buffer } = track(setup(recordingWrite().write, { capacity: 2 }));
    const events = [action(), action()];
    buffer.offer(events);
    expect(buffer.offer(events)).toEqual({ ok: true, accepted: 0, duplicates: 2 });
  });
});

describe("flush", () => {
  it("writes in arrival order, with one dedup token per table", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write));
    const events = [action("a"), action("b"), action("c")];
    buffer.offer(events.slice(0, 2));
    buffer.offer(events.slice(2));
    await buffer.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.events).toEqual(events);
    const tokens = calls[0]?.tokens ?? {};
    expect(Object.keys(tokens).sort()).toEqual([...INSERT_TABLES].sort());
    const flushId = (tokens.actions as string).split(":")[0];
    for (const table of INSERT_TABLES) expect(tokens[table]).toBe(`${flushId}:${table}`);
    expect(buffer.stats().queued).toBe(0);
  });

  it("uses a new flush id for every flush", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write));
    buffer.offer([action()]);
    await buffer.flush();
    buffer.offer([action()]);
    await buffer.flush();
    expect(calls[0]?.tokens.actions).not.toBe(calls[1]?.tokens.actions);
  });

  it("does nothing when nothing is queued", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write));
    await buffer.flush();
    expect(calls).toEqual([]);
  });

  it("flushes at once when maxBatchSize events are waiting, without waiting for the timer", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write, { maxBatchSize: 3 }));
    buffer.offer([action(), action()]);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    buffer.offer([action()]);
    await buffer.flush(); // joins the flush that offer() started
    expect(calls.map((call) => call.events.length)).toEqual([3]);
  });

  it("takes at most maxBatchSize events per INSERT and keeps going while a full batch is waiting", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write, { maxBatchSize: 3 }));
    const events = Array.from({ length: 7 }, () => action());
    buffer.offer(events);
    await buffer.flush();
    // 3 + 3 right away; the last event waits for the next tick (less than a full batch)
    expect(calls.map((call) => call.events.length)).toEqual([3, 3]);
    await buffer.flush();
    expect(calls.map((call) => call.events.length)).toEqual([3, 3, 1]);
    expect(calls.flatMap((call) => call.events)).toEqual(events);
  });

  it("runs one flush at a time and never reorders", async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const write: WriteBatch = async (events) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(...events.map((event) => (event as { seq: number }).seq));
      active--;
      return { orphans: [] };
    };
    const { buffer } = track(setup(write, { maxBatchSize: 2 }));
    const events = Array.from({ length: 6 }, () => action());
    for (const event of events) buffer.offer([event]);
    await buffer.flush();
    await buffer.flush();
    expect(maxActive).toBe(1);
    expect(order).toEqual(events.map((event) => (event as { seq: number }).seq));
  });

  it("flushes on a timer once started", async () => {
    vi.useFakeTimers();
    const { write, calls } = recordingWrite();
    const { buffer } = track(setup(write, { flushIntervalMs: 1000 }));
    buffer.start();
    buffer.offer([action()]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(1);
    await buffer.close();
  });
});

describe("when a flush fails", () => {
  /** Fails the first `failures` calls, then behaves like `recordingWrite`. */
  function flaky(failures: number) {
    const { write: good, calls } = recordingWrite();
    let left = failures;
    const write: WriteBatch = async (events, tokens) => {
      if (left-- > 0) {
        calls.push({ events: [...events], tokens: { ...tokens } as Record<string, string> });
        throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:8123"), {
          code: "ECONNREFUSED",
        });
      }
      return good(events, tokens);
    };
    return { write, calls };
  }

  it("retries the same events with the same tokens until it works", async () => {
    const { write, calls } = flaky(2);
    const { buffer, logs } = track(setup(write));
    const events = [action(), action()];
    buffer.offer(events);
    await buffer.flush();

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.events)).toEqual([events, events, events]);
    expect(calls[1]?.tokens).toEqual(calls[0]?.tokens);
    expect(calls[2]?.tokens).toEqual(calls[0]?.tokens);
    expect(logs.filter((entry) => entry.level === "error")).toHaveLength(2);
    expect(buffer.stats().queued).toBe(0);
  });

  it("keeps accepting events while it retries, and writes them in the next flush", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: FleetEvent[][] = [];
    let attempt = 0;
    const write: WriteBatch = async (events) => {
      calls.push([...events]);
      if (attempt++ === 0) throw new Error("down");
      if (attempt === 2) await gate; // hold the retry open so we can look inside
      return { orphans: [] };
    };
    const { buffer } = track(setup(write));
    const first = [action(), action()];
    const later = [action(), action()];
    buffer.offer(first);
    const flushing = buffer.flush();
    await vi.waitFor(() => expect(calls.length).toBe(2)); // failed once, retrying

    expect(buffer.stats().retrying).toBe(true);
    expect(buffer.offer(later)).toEqual({ ok: true, accepted: 2, duplicates: 0 });
    release();
    await flushing;
    await buffer.flush();

    expect(calls[0]).toEqual(first);
    expect(calls[1]).toEqual(first); // the retry does not pick up the newer events
    expect(calls[2]).toEqual(later);
  });

  it("says full once the retrying buffer reaches capacity", async () => {
    const write: WriteBatch = async () => {
      throw new Error("down");
    };
    const { buffer } = track(setup(write, { capacity: 5, retryBaseMs: 50, retryMaxMs: 50 }));
    buffer.offer([action(), action(), action()]);
    void buffer.flush();
    await vi.waitFor(() => expect(buffer.stats().retrying).toBe(true));
    expect(buffer.offer([action(), action()])).toMatchObject({ ok: true });
    expect(buffer.offer([action()])).toEqual({ ok: false, reason: "full" });
    expect(buffer.stats().queued).toBe(5);
  });

  it("reports the failure on stats without leaking the error message, and clears it on success", async () => {
    let attempt = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write: WriteBatch = async () => {
      if (attempt++ === 0) {
        throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:8123"), {
          code: "ECONNREFUSED",
        });
      }
      await gate; // keep the retry open while we look at the stats
      return { orphans: [] };
    };
    const { buffer } = track(setup(write));
    buffer.offer([action()]);
    const flushing = buffer.flush();
    await vi.waitFor(() => expect(attempt).toBe(2)); // failed once, the retry is running

    const failing = buffer.stats();
    expect(failing.retrying).toBe(true);
    expect(failing.lastFlushError).toEqual({ at: T0, error: "Error ECONNREFUSED" });
    expect(JSON.stringify(failing)).not.toContain("10.1.2.3");

    release();
    await flushing;
    const healthy = buffer.stats();
    expect(healthy.retrying).toBe(false);
    expect(healthy.lastFlushError).toBeNull();
    expect(healthy.lastFlushAt).toBe(T0);
  });
});

describe("backoffDelay", () => {
  it("doubles up to the maximum, with jitter between half and all of it", () => {
    const lowest = () => 0;
    const highest = () => 0.999999;
    expect(backoffDelay(0, 500, 10_000, lowest)).toBe(250);
    expect(backoffDelay(0, 500, 10_000, highest)).toBeCloseTo(500, 0);
    expect(backoffDelay(1, 500, 10_000, lowest)).toBe(500);
    expect(backoffDelay(3, 500, 10_000, lowest)).toBe(2000);
    expect(backoffDelay(10, 500, 10_000, lowest)).toBe(5000);
    expect(backoffDelay(10, 500, 10_000, highest)).toBeCloseTo(10_000, 0);
    expect(backoffDelay(5000, 500, 10_000, lowest)).toBe(5000); // no overflow
  });

  it("spreads retries: two callers rarely pick the same delay", () => {
    const delays = new Set(Array.from({ length: 20 }, () => backoffDelay(4, 500, 10_000)));
    expect(delays.size).toBeGreaterThan(15);
  });
});

describe("orphaned session.ended", () => {
  it("holds an end whose start is missing, offers it again in later flushes, and releases it once stored", async () => {
    const lost = ended("s-late");
    const calls: FleetEvent[][] = [];
    let startArrived = false;
    const write: WriteBatch = async (events) => {
      calls.push([...events]);
      const stillOrphan = events.includes(lost) && !startArrived;
      return { orphans: stillOrphan ? [lost] : [] };
    };
    const { buffer } = track(setup(write));

    buffer.offer([lost]);
    await buffer.flush();
    expect(buffer.stats().orphansHeld).toBe(1);
    expect(buffer.stats().queued).toBe(1); // still counts: it is not in ClickHouse

    await buffer.flush(); // nothing new, but the orphan is offered again
    expect(calls[1]).toEqual([lost]);
    expect(buffer.stats().orphansHeld).toBe(1);

    startArrived = true;
    await buffer.flush();
    expect(calls[2]).toEqual([lost]);
    expect(buffer.stats()).toMatchObject({ orphansHeld: 0, orphansDropped: 0, queued: 0 });

    await buffer.flush();
    expect(calls).toHaveLength(3); // released: no more retries
  });

  it("sends held orphans together with new events", async () => {
    const lost = ended("s-together");
    const calls: FleetEvent[][] = [];
    const write: WriteBatch = async (events) => {
      calls.push([...events]);
      return { orphans: events.includes(lost) ? [lost] : [] };
    };
    const { buffer } = track(setup(write));
    buffer.offer([lost]);
    await buffer.flush();
    const fresh = action();
    buffer.offer([fresh]);
    await buffer.flush();
    expect(calls[1]).toEqual([fresh, lost]);
  });

  it("drops it after the grace period, warns with the session ids and counts it", async () => {
    const a = ended("sess-a");
    const b = ended("sess-b");
    const write: WriteBatch = async () => ({ orphans: [a, b] });
    const { buffer, logs, tick } = track(setup(write, { orphanGraceMs: 60_000 }));
    buffer.offer([a, b]);

    await buffer.flush();
    tick(59_000);
    await buffer.flush();
    expect(buffer.stats().orphansHeld).toBe(2);
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);

    tick(1_000);
    await buffer.flush();
    expect(buffer.stats()).toMatchObject({ orphansHeld: 0, orphansDropped: 2, queued: 0 });
    const warnings = logs.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ count: 2, sessionIds: ["sess-a", "sess-b"] });
  });

  it("does not retry an orphan forever: after the drop it is gone", async () => {
    const a = ended("sess-gone");
    const write = vi.fn<WriteBatch>(async () => ({ orphans: [a] }));
    const { buffer, tick } = track(setup(write, { orphanGraceMs: 10 }));
    buffer.offer([a]);
    await buffer.flush();
    tick(10);
    await buffer.flush();
    await buffer.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe("stats", () => {
  it("reports the age of the oldest event that is still waiting", async () => {
    const { buffer, tick } = track(setup(recordingWrite().write));
    expect(buffer.stats().oldestAgeMs).toBeNull();
    buffer.offer([action()]);
    tick(400);
    buffer.offer([action()]);
    tick(100);
    expect(buffer.stats()).toMatchObject({ oldestAgeMs: 500, queued: 2, capacity: 50_000 });
    await buffer.flush();
    expect(buffer.stats()).toMatchObject({ oldestAgeMs: null, queued: 0, lastFlushAt: T0 + 500 });
  });
});

describe("close", () => {
  it("flushes everything that was accepted, then refuses new events", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = setup(write, { maxBatchSize: 2 });
    const events = Array.from({ length: 5 }, () => action());
    buffer.offer(events);

    await buffer.close();
    expect(calls.flatMap((call) => call.events)).toEqual(events);
    expect(buffer.stats().queued).toBe(0);
    expect(buffer.offer([action()])).toEqual({ ok: false, reason: "closing" });
  });

  it("keeps trying while ClickHouse recovers, as long as it is within the timeout", async () => {
    const { write: good, calls } = recordingWrite();
    let failures = 3;
    const write: WriteBatch = async (events, tokens) => {
      if (failures-- > 0) throw new Error("down");
      return good(events, tokens);
    };
    const { buffer } = setup(write, {
      retryBaseMs: 1000,
      retryMaxMs: 1000,
      shutdownTimeoutMs: 5000,
    });
    buffer.offer([action()]);
    const started = Date.now();
    await buffer.close();
    expect(calls).toHaveLength(1);
    // The normal backoff is 500 ms or more; during shutdown retries are quick.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("gives up after the timeout when ClickHouse stays down, and logs how many events were lost", async () => {
    const write: WriteBatch = async () => {
      throw new Error("down");
    };
    const { buffer, logs } = setup(write, { shutdownTimeoutMs: 100 });
    buffer.offer([action(), action(), action()]);
    const started = Date.now();
    await buffer.close();

    expect(Date.now() - started).toBeLessThan(1000);
    const lost = logs.find((entry) => entry.msg.includes("not written"));
    expect(lost?.level).toBe("error");
    expect(lost?.obj).toMatchObject({ lost: 3, timedOut: true });
  });

  it("gives up after the timeout when a write never returns", async () => {
    const write: WriteBatch = () => new Promise(() => {});
    const { buffer, logs } = setup(write, { shutdownTimeoutMs: 100 });
    buffer.offer([action()]);
    await buffer.close();
    expect(logs.some((entry) => entry.obj.lost === 1)).toBe(true);
  });

  it("can be called twice", async () => {
    const { write, calls } = recordingWrite();
    const { buffer } = setup(write);
    buffer.offer([action()]);
    await Promise.all([buffer.close(), buffer.close()]);
    await buffer.close();
    expect(calls).toHaveLength(1);
  });

  it("stops the timer", async () => {
    vi.useFakeTimers();
    const { write, calls } = recordingWrite();
    const { buffer } = setup(write, { flushIntervalMs: 1000 });
    buffer.start();
    await buffer.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("a batch bigger than the whole buffer (QA-M1-09)", () => {
  it("is refused as too large, which is not 'full': waiting would never help", () => {
    const { buffer } = track(setup(recordingWrite().write, { capacity: 3 }));
    expect(buffer.offer([action(), action(), action(), action()])).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(buffer.stats().queued).toBe(0);
  });

  it("accepts a batch of exactly the capacity, and says full (not too large) when it is taken", () => {
    const { buffer } = track(setup(recordingWrite().write, { capacity: 3 }));
    const batch = [action(), action(), action()];
    expect(buffer.offer(batch)).toMatchObject({ ok: true, accepted: 3 });
    expect(buffer.offer([action()])).toEqual({ ok: false, reason: "full" });
  });

  it("does not remember the ids of a refused batch", () => {
    const { buffer } = track(setup(recordingWrite().write, { capacity: 2 }));
    const batch = [action(), action(), action()];
    buffer.offer(batch);
    expect(buffer.offer(batch.slice(0, 2))).toEqual({ ok: true, accepted: 2, duplicates: 0 });
  });

  it("counts only the new events against the capacity, so a resent batch is not too large", () => {
    const { buffer } = track(setup(recordingWrite().write, { capacity: 3 }));
    const seen = [action(), action(), action()];
    buffer.offer(seen);
    // 3 repeats + 1 new: 4 events, but only 1 would be queued
    expect(buffer.offer([...seen, action()])).toEqual({ ok: false, reason: "full" });
  });
});

describe("a flush that ClickHouse refuses because of its data (R-M1-01)", () => {
  const dataError = () =>
    new ClickHouseError({
      message: "Cannot parse escape sequence: missing second part of surrogate pair",
      code: "25",
      type: "CANNOT_PARSE_ESCAPE_SEQUENCE",
    });
  const networkError = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8123"), { code: "ECONNREFUSED" });

  /** Fails with the given errors in order, then stores everything. */
  function scripted(errors: Array<() => Error>) {
    const calls: Array<{ events: FleetEvent[]; tokens: Record<string, string> }> = [];
    let next = 0;
    const write: WriteBatch = async (events, tokens) => {
      calls.push({ events: [...events], tokens: { ...tokens } as Record<string, string> });
      const fail = errors[next++];
      if (fail) throw fail();
      return { orphans: [] };
    };
    return { write, calls };
  }

  /** A dead letter that remembers what it was given. */
  function recordingDeadLetter() {
    const saved: Array<{ flushId: string; events: readonly FleetEvent[] }> = [];
    const deadLetter: DeadLetter = async (flushId, events) => {
      saved.push({ flushId, events: [...events] });
      return `/dead/${flushId}.jsonl`;
    };
    return { deadLetter, saved };
  }

  it("moves the flush to the dead letter after 3 data errors in a row, and carries on", async () => {
    const { write, calls } = scripted([dataError, dataError, dataError]);
    const { deadLetter, saved } = recordingDeadLetter();
    const { buffer, logs } = track(setup(write, {}, undefined, deadLetter));
    const poisoned = [action("bad-1"), action("bad-2")];
    buffer.offer(poisoned);
    await buffer.flush();

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.events)).toEqual([poisoned, poisoned, poisoned]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.events).toEqual(poisoned);
    expect(calls[0]?.tokens.actions).toBe(`${saved[0]?.flushId}:actions`);

    const stats = buffer.stats();
    expect(stats).toMatchObject({ queued: 0, retrying: false, deadLettered: 2 });
    expect(stats.lastFlushError?.error).toBe("ClickHouseError 25 CANNOT_PARSE_ESCAPE_SEQUENCE");

    // one error log says what happened, with the flush id, the event count and the error
    const moved = logs.filter((entry) => entry.msg.includes("dead-letter file"));
    expect(moved).toHaveLength(1);
    expect(moved[0]?.level).toBe("error");
    expect(moved[0]?.obj).toMatchObject({
      flushId: saved[0]?.flushId,
      events: 2,
      error: "ClickHouseError 25 CANNOT_PARSE_ESCAPE_SEQUENCE",
      file: `/dead/${saved[0]?.flushId}.jsonl`,
    });

    // the next events are stored normally, and a success clears the error
    const good = [action("good")];
    buffer.offer(good);
    await buffer.flush();
    expect(calls[3]?.events).toEqual(good);
    expect(calls[3]?.tokens.actions).not.toBe(calls[0]?.tokens.actions);
    expect(buffer.stats()).toMatchObject({ deadLettered: 2, lastFlushError: null });
  });

  it("does not stop the clients behind it: events offered during the retries are stored after it", async () => {
    const { write, calls } = scripted([dataError, dataError, dataError]);
    const { deadLetter } = recordingDeadLetter();
    const { buffer } = track(
      setup(write, { retryBaseMs: 30, retryMaxMs: 30 }, undefined, deadLetter),
    );
    buffer.offer([action("bad")]);
    const flushing = buffer.flush();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    const later = [action("innocent")];
    expect(buffer.offer(later)).toMatchObject({ ok: true, accepted: 1 });
    await flushing;
    await buffer.flush();
    expect(calls.at(-1)?.events).toEqual(later);
  });

  it("starts counting again after a transient error in between", async () => {
    const { write, calls } = scripted([dataError, dataError, networkError, dataError, dataError]);
    const { deadLetter, saved } = recordingDeadLetter();
    const { buffer } = track(setup(write, {}, undefined, deadLetter));
    buffer.offer([action()]);
    await buffer.flush();
    expect(calls).toHaveLength(6); // two data, one network, two data, then it was stored
    expect(saved).toEqual([]);
    expect(buffer.stats()).toMatchObject({ deadLettered: 0, queued: 0 });
  });

  it("never gives up on transient errors, however many", async () => {
    const { write, calls } = scripted(Array.from({ length: 12 }, () => networkError));
    const { deadLetter, saved } = recordingDeadLetter();
    const { buffer } = track(setup(write, {}, undefined, deadLetter));
    buffer.offer([action()]);
    await buffer.flush();
    expect(calls).toHaveLength(13);
    expect(saved).toEqual([]);
    expect(buffer.stats().queued).toBe(0);
  });

  it("treats a ClickHouse error that is not on the data list as transient", async () => {
    const memory = () =>
      new ClickHouseError({
        message: "Memory limit exceeded",
        code: "241",
        type: "MEMORY_LIMIT_EXCEEDED",
      });
    const { write, calls } = scripted([memory, memory, memory, memory]);
    const { deadLetter, saved } = recordingDeadLetter();
    const { buffer } = track(setup(write, {}, undefined, deadLetter));
    buffer.offer([action()]);
    await buffer.flush();
    expect(calls).toHaveLength(5);
    expect(saved).toEqual([]);
  });

  it("retries a data error forever when there is no dead letter configured", async () => {
    const { write, calls } = scripted(Array.from({ length: 8 }, () => dataError));
    const { buffer } = track(setup(write));
    buffer.offer([action()]);
    await buffer.flush();
    expect(calls).toHaveLength(9);
    expect(buffer.stats()).toMatchObject({ deadLettered: 0, queued: 0 });
  });

  it("keeps the events and tries again when the dead-letter file cannot be written", async () => {
    const { write, calls } = scripted(Array.from({ length: 10 }, () => dataError));
    const saved: Array<readonly FleetEvent[]> = [];
    let attempts = 0;
    const deadLetter: DeadLetter = async (flushId, events) => {
      if (attempts++ === 0) throw new Error("ENOSPC: no space left on device");
      saved.push([...events]);
      return `/dead/${flushId}.jsonl`;
    };
    const { buffer, logs } = track(setup(write, {}, undefined, deadLetter));
    const poisoned = [action("bad")];
    buffer.offer(poisoned);
    await buffer.flush();

    expect(attempts).toBe(2); // the first save failed, the next data error tried again
    expect(calls).toHaveLength(4);
    expect(saved).toEqual([poisoned]);
    expect(logs.some((entry) => entry.msg.includes("could not write the dead-letter file"))).toBe(
      true,
    );
    expect(buffer.stats()).toMatchObject({ deadLettered: 1, queued: 0 });
  });

  it("keeps the flush in memory while the dead-letter file cannot be written", async () => {
    const { write } = scripted(Array.from({ length: 100 }, () => dataError));
    const deadLetter: DeadLetter = async () => {
      throw new Error("EACCES");
    };
    const { buffer } = track(
      setup(write, { retryBaseMs: 20, retryMaxMs: 20 }, undefined, deadLetter),
    );
    buffer.offer([action(), action()]);
    void buffer.flush();
    await vi.waitFor(() => expect(buffer.stats().retrying).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(buffer.stats()).toMatchObject({ queued: 2, retrying: true, deadLettered: 0 });
  });

  it("lets go of held orphans that were in the dead-lettered flush", async () => {
    const lost = ended("s-held");
    let poison = false;
    const write: WriteBatch = async (events) => {
      if (poison) throw dataError();
      return { orphans: events.includes(lost) ? [lost] : [] };
    };
    const { deadLetter, saved } = recordingDeadLetter();
    const { buffer } = track(setup(write, {}, undefined, deadLetter));
    buffer.offer([lost]);
    await buffer.flush();
    expect(buffer.stats().orphansHeld).toBe(1);

    poison = true;
    buffer.offer([action()]);
    const flushing = buffer.flush();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    await flushing;
    expect(saved[0]?.events).toContain(lost);
    expect(buffer.stats()).toMatchObject({ orphansHeld: 0, queued: 0, deadLettered: 2 });
  });

  it("dead-letters during shutdown instead of waiting for the timeout", async () => {
    const { write } = scripted(Array.from({ length: 10 }, () => dataError));
    const { deadLetter, saved } = recordingDeadLetter();
    const { buffer, logs } = setup(write, { shutdownTimeoutMs: 2000 }, undefined, deadLetter);
    buffer.offer([action(), action(), action()]);
    const started = Date.now();
    await buffer.close();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(saved).toHaveLength(1);
    expect(logs.some((entry) => entry.msg.includes("not written to ClickHouse"))).toBe(false);
  });
});
