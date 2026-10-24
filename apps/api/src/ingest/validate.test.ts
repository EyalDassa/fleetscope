import { type EventEnvelope, MAX_BATCH_SIZE, newEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { checkBatch, MAX_FUTURE_SKEW_MS, MAX_REPORTED_ISSUES, oldestAcceptedTs } from "./validate";

const DAY = 86_400_000;

const NOW = 1_760_000_000_000;
const ctx: EventEnvelope = {
  session_id: "s1",
  source: "sim",
  agent_id: "agent-1",
  engine: "lightpanda",
  provider: "local-docker",
};
const issue = (ts = NOW) => newEvent("issue", ctx, { kind: "blocked", message: "m" }, ts);

describe("checkBatch", () => {
  it("accepts a valid batch and returns the parsed events", () => {
    const events = [issue(), issue(NOW - 3_600_000)];
    expect(checkBatch(events, NOW)).toEqual({ ok: true, events });
  });

  it("accepts the largest allowed batch", () => {
    const events = Array.from({ length: MAX_BATCH_SIZE }, () => issue());
    expect(checkBatch(events, NOW).ok).toBe(true);
  });

  it("answers 413 for more than 1000 events, before looking at their content", () => {
    const result = checkBatch(
      Array.from({ length: MAX_BATCH_SIZE + 1 }, () => "junk"),
      NOW,
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(result.ok === false && result.body.error).toContain("1001");
  });

  it.each([
    ["an empty batch", []],
    ["a non-array", { events: [] }],
    ["null", null],
    ["a string", "hello"],
    ["an event with a missing field", [{ ...issue(), message: undefined }]],
    ["an unknown type", [{ ...issue(), type: "nope" }]],
    ["a bad uuid", [{ ...issue(), event_id: "not-a-uuid" }]],
  ])("answers 400 for %s", (_name, body) => {
    const result = checkBatch(body, NOW);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("lists the zod issues with their path inside the batch", () => {
    const result = checkBatch([issue(), { ...issue(), kind: "nope" }], NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.issues?.some((i) => i.path[0] === 1 && i.path.includes("kind"))).toBe(true);
  });

  it("reports at most the first issues of a very bad batch, and says how many there were", () => {
    const bad = Array.from({ length: 100 }, () => ({ ...issue(), kind: "nope" }));
    const result = checkBatch(bad, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.issues).toHaveLength(MAX_REPORTED_ISSUES);
    expect(result.body.error).toContain("showing the first 20 of 100");
  });

  describe("clock skew", () => {
    it("accepts a ts exactly at the limit and rejects one millisecond later", () => {
      expect(checkBatch([issue(NOW + MAX_FUTURE_SKEW_MS)], NOW).ok).toBe(true);
      expect(checkBatch([issue(NOW + MAX_FUTURE_SKEW_MS + 1)], NOW)).toMatchObject({
        ok: false,
        status: 400,
      });
    });

    it("names the offending indexes in the error and in the issues", () => {
      const far = NOW + 3_600_000;
      const result = checkBatch([issue(), issue(far), issue(), issue(far)], NOW);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("2 event(s)");
      expect(result.body.error).toContain("indexes 1, 3");
      expect(result.body.issues).toEqual([
        { path: [1, "ts"], message: expect.stringContaining("5 minutes") },
        { path: [3, "ts"], message: expect.stringContaining("5 minutes") },
      ]);
    });

    it("uses the clock it is given", () => {
      const event = issue(NOW + 10 * 60_000);
      expect(checkBatch([event], NOW).ok).toBe(false);
      expect(checkBatch([event], NOW + 6 * 60_000).ok).toBe(true);
    });
  });

  describe("age (the retention window)", () => {
    // NOW is 2025-10-09T08:53:20Z. The raw tables keep 30 days by whole day, so the oldest day
    // that is still alive is 2025-09-10 (today minus 29).
    const CUTOFF = Date.UTC(2025, 8, 10);

    it("computes the oldest accepted ts: midnight UTC, 29 days back", () => {
      expect(oldestAcceptedTs(NOW)).toBe(CUTOFF);
      expect(new Date(oldestAcceptedTs(NOW)).toISOString()).toBe("2025-09-10T00:00:00.000Z");
      // the whole day gives the same answer, and the next day moves it by one day
      expect(oldestAcceptedTs(Date.UTC(2025, 9, 9, 0, 0, 0))).toBe(CUTOFF);
      expect(oldestAcceptedTs(Date.UTC(2025, 9, 9, 23, 59, 59, 999))).toBe(CUTOFF);
      expect(oldestAcceptedTs(Date.UTC(2025, 9, 10, 0, 0, 0))).toBe(CUTOFF + DAY);
    });

    it("accepts a ts exactly at the cutoff and rejects one millisecond before it", () => {
      expect(checkBatch([issue(CUTOFF)], NOW).ok).toBe(true);
      expect(checkBatch([issue(CUTOFF - 1)], NOW)).toMatchObject({ ok: false, status: 400 });
    });

    it("rejects an event from 30 days ago: ClickHouse would delete it at once", () => {
      expect(checkBatch([issue(NOW - 30 * DAY)], NOW).ok).toBe(false);
      expect(checkBatch([issue(NOW - 29 * DAY)], NOW).ok).toBe(true);
    });

    it("names the offending indexes, like the future check", () => {
      const result = checkBatch(
        [issue(), issue(CUTOFF - DAY), issue(), issue(Date.UTC(2021, 0, 1))],
        NOW,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("2 event(s)");
      expect(result.body.error).toContain("retention window");
      expect(result.body.error).toContain("indexes 1, 3");
      expect(result.body.issues).toEqual([
        { path: [1, "ts"], message: expect.stringContaining("retention window") },
        { path: [3, "ts"], message: expect.stringContaining("retention window") },
      ]);
    });

    it("reports old and future events together", () => {
      const result = checkBatch([issue(CUTOFF - 1), issue(NOW + 3_600_000)], NOW);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.body.error).toContain("in the future (indexes 1)");
      expect(result.body.error).toContain("retention window");
      expect(result.body.error).toContain("(indexes 0)");
      expect(result.body.issues?.map((i) => i.path)).toEqual([
        [1, "ts"],
        [0, "ts"],
      ]);
    });

    it("rejects a batch that spans 101 days (the one that ClickHouse used to refuse forever)", () => {
      const events = Array.from({ length: 101 }, (_, i) => issue(NOW - i * DAY));
      const result = checkBatch(events, NOW);
      expect(result).toMatchObject({ ok: false, status: 400 });
      if (result.ok) return;
      expect(result.body.issues).toHaveLength(MAX_REPORTED_ISSUES);
      expect(result.body.error).toContain("indexes 30, 31");
    });

    it("accepts the widest batch it lets through: from the cutoff to the future limit (31 days)", () => {
      const days = Array.from({ length: 30 }, (_, i) => issue(NOW - i * DAY));
      const events = [...days, issue(CUTOFF), issue(NOW + MAX_FUTURE_SKEW_MS)];
      expect(checkBatch(events, NOW).ok).toBe(true);
      const partitions = new Set(events.map((e) => new Date(e.ts).toISOString().slice(0, 10)));
      expect(partitions.size).toBeLessThanOrEqual(31);
    });
  });
});

describe("checkBatch: the labels that dashboards put into SQL", () => {
  const started = (over: Record<string, unknown>) => ({
    ...newEvent(
      "session.started",
      ctx,
      {
        engine_version: "156.0.8078.4",
        scenario: "checkout-form",
        region: "local",
        startup_ms: 1,
        connect_ms: 1,
      },
      NOW,
    ),
    ...over,
  });

  it.each([
    ["agent_id", "x' OR '1'='1"],
    ["session_id", "back\\slash"],
    ["provider", "local docker"],
    ["scenario", "café"],
    ["region", "\\' OR 1=1 --"],
    ["engine_version", "1.0; DROP TABLE sessions"],
  ])(
    "answers 400 for a %s such as %j, names the field, and does not repeat the value",
    (field, value) => {
      const result = checkBatch([issue(), started({ [field]: value })], NOW);
      expect(result).toMatchObject({ ok: false, status: 400 });
      if (result.ok) return;
      expect(result.body.issues).toEqual([
        {
          path: [1, field],
          message: "must be 1 to 128 characters from A-Z a-z 0-9 . _ : @ / + -",
        },
      ]);
      expect(JSON.stringify(result.body)).not.toContain(value);
    },
  );

  it("answers 400 for an error_code that is not a safe label", () => {
    const bad = newEvent(
      "action",
      ctx,
      { seq: 0, action_type: "goto", target: "x", duration_ms: 1, ok: false, error_code: "it's" },
      NOW,
    );
    expect(checkBatch([bad], NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts what the real producers send", () => {
    const events = [
      started({
        agent_id: "fleet-runner@LAPTOP-G1JS2HFL",
        session_id: "7f0c8b0e-2c1a-4a43-9c52-0b1e3d9f5a11",
        provider: "local-docker",
      }),
    ];
    expect(checkBatch(events, NOW).ok).toBe(true);
  });
});
