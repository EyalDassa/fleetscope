import { type EventEnvelope, MAX_BATCH_SIZE, newEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { checkBatch, MAX_FUTURE_SKEW_MS, MAX_REPORTED_ISSUES } from "./validate";

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

    it("does not reject old events (replays are fine)", () => {
      expect(checkBatch([issue(NOW - 30 * 86_400_000)], NOW).ok).toBe(true);
    });

    it("uses the clock it is given", () => {
      const event = issue(NOW + 10 * 60_000);
      expect(checkBatch([event], NOW).ok).toBe(false);
      expect(checkBatch([event], NOW + 6 * 60_000).ok).toBe(true);
    });
  });
});
