import { describe, expect, it } from "vitest";
import {
  ActionEvent,
  EventBatch,
  type EventEnvelope,
  FleetEvent,
  IssueEvent,
  NetworkRequestEvent,
  newEvent,
  RETENTION_DAYS,
  ScreenshotEvent,
  SessionEndedEvent,
  SessionStartedEvent,
} from "./index";

// Lone UTF-16 surrogates: free text is repaired; the safe labels that dashboards put into SQL are
// rejected, like everything else outside their ASCII charset (see the comments in events.ts and
// labels.test.ts).

const ctx: EventEnvelope = {
  session_id: "s1",
  source: "real",
  agent_id: "agent-1",
  engine: "chromium",
  provider: "local-docker",
};
const HIGH = "\ud83d"; // first half of an emoji, alone
const LOW = "\ude00"; // second half, alone

const action = (fields: Record<string, unknown> = {}) => ({
  ...newEvent("action", ctx, {
    seq: 0,
    action_type: "goto",
    target: "example.com",
    duration_ms: 1,
    ok: true,
    error_code: null,
  }),
  ...fields,
});

describe("RETENTION_DAYS", () => {
  it("is the 30 days of the raw tables' TTL", () => {
    expect(RETENTION_DAYS).toBe(30);
  });
});

describe("free text with a lone surrogate is repaired", () => {
  it("replaces it with U+FFFD in issue.message, keeping the rest and the length", () => {
    const event = newEvent("issue", ctx, { kind: "crash", message: `boom ${HIGH} tail` });
    const parsed = IssueEvent.parse(event);
    expect(parsed.message).toBe("boom � tail");
    expect(parsed.message.length).toBe(`boom ${HIGH} tail`.length);
  });

  it("repairs a low surrogate and a high one at the end of the string", () => {
    expect(ActionEvent.parse(action({ target: `${LOW}x` })).target).toBe("�x");
    expect(ActionEvent.parse(action({ target: `x${HIGH}` })).target).toBe("x�");
  });

  it("repairs each lone surrogate separately, and a reversed pair is two of them", () => {
    expect(ActionEvent.parse(action({ target: `${LOW}${HIGH}` })).target).toBe("��");
  });

  it("leaves a proper pair (an emoji) and other text untouched", () => {
    const text = "ok 😀 ünï cödé 日本語";
    expect(ActionEvent.parse(action({ target: text })).target).toBe(text);
  });

  it("repairs every free-text field", () => {
    const bad = `a${HIGH}`;
    const fixed = "a�";
    expect(
      SessionEndedEvent.parse(
        newEvent("session.ended", ctx, { status: "failed", reason: bad, duration_ms: 1 }),
      ).reason,
    ).toBe(fixed);
    expect(
      NetworkRequestEvent.parse(
        newEvent("network.request", ctx, {
          domain: bad,
          status: 200,
          bytes: 1,
          duration_ms: 1,
          resource_type: bad,
        }),
      ),
    ).toMatchObject({ domain: fixed, resource_type: fixed });
    expect(
      ScreenshotEvent.parse(newEvent("screenshot", ctx, { action_seq: 0, url: `file:///${bad}` }))
        .url,
    ).toBe("file:///a�");
  });

  it("does not repair the labels that go into SQL: it rejects them (a repaired value would be a different one)", () => {
    const bad = `a${HIGH}`;
    for (const result of [
      SessionStartedEvent.safeParse(
        newEvent("session.started", ctx, {
          engine_version: bad,
          scenario: "ok",
          region: "ok",
          startup_ms: 1,
          connect_ms: 1,
        }),
      ),
      ActionEvent.safeParse(action({ error_code: bad, ok: false })),
      FleetEvent.safeParse({
        ...newEvent("session.ended", ctx, { status: "failed", reason: null, duration_ms: 1 }),
        provider: bad,
      }),
    ]) {
      expect(result.success).toBe(false);
    }
  });

  it("keeps null and optional fields as they are", () => {
    expect(ActionEvent.parse(action()).error_code).toBeNull();
    expect(
      ScreenshotEvent.parse(newEvent("screenshot", ctx, { action_seq: 0 })).url,
    ).toBeUndefined();
  });

  it("still enforces the length limits on the original string", () => {
    expect(ActionEvent.safeParse(action({ target: "x".repeat(2001) })).success).toBe(false);
    expect(ActionEvent.safeParse(action({ target: HIGH.repeat(2001) })).success).toBe(false);
    expect(ActionEvent.safeParse(action({ target: HIGH.repeat(2000) })).success).toBe(true);
  });

  it("survives JSON, which is how it reaches the API", () => {
    const wire = JSON.stringify([action({ target: `bad ${HIGH}` })]);
    expect(wire).toContain("\\ud83d"); // JSON.stringify writes a lone surrogate as an escape
    const [event] = EventBatch.parse(JSON.parse(wire));
    expect(event).toMatchObject({ target: "bad �" });
    // what the repaired string becomes in JSON is plain, valid UTF-8 text for ClickHouse
    expect(JSON.stringify(event)).not.toMatch(/\\ud[89ab]/i);
  });
});

describe("ids with a lone surrogate are rejected", () => {
  it.each(["session_id", "agent_id"])("%s", (field) => {
    const result = ActionEvent.safeParse(action({ [field]: `s${HIGH}` }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual([field]);
  });

  it("rejects an id with a proper pair too: ids are ASCII (see labels.test.ts)", () => {
    expect(ActionEvent.safeParse(action({ session_id: "s-😀" })).success).toBe(false);
  });
});
