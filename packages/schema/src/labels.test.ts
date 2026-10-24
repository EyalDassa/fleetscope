import { describe, expect, it } from "vitest";
import {
  type EventEnvelope,
  FleetEvent,
  newEvent,
  SAFE_LABEL_PATTERN,
  SessionId,
  SessionStartedEvent,
} from "./index";

/**
 * The labels that dashboards put into SQL (session_id, agent_id, provider, scenario, region,
 * engine_version, error_code) accept only `A-Z a-z 0-9 . _ : @ / + -`, 1 to 128 characters. See the
 * comment on SAFE_LABEL_PATTERN in events.ts for why.
 */

const ctx: EventEnvelope = {
  session_id: "7f0c8b0e-2c1a-4a43-9c52-0b1e3d9f5a11",
  source: "real",
  agent_id: "fleet-runner@LAPTOP-G1JS2HFL",
  engine: "chromium",
  provider: "local-docker",
};

const started = (over: Record<string, unknown> = {}) =>
  FleetEvent.safeParse({
    ...newEvent("session.started", ctx, {
      engine_version: "156.0.8078.4",
      scenario: "checkout-form",
      region: "local",
      startup_ms: 1,
      connect_ms: 1,
    }),
    ...over,
  });

const action = (over: Record<string, unknown> = {}) =>
  FleetEvent.safeParse({
    ...newEvent("action", ctx, {
      seq: 0,
      action_type: "goto",
      target: "example.com",
      duration_ms: 1,
      ok: false,
      error_code: "timeout",
    }),
    ...over,
  });

/** Every field the rule covers, with a function that builds an event carrying `value` in it. */
const FIELDS: Record<string, (value: string) => ReturnType<typeof started>> = {
  session_id: (value) => started({ session_id: value }),
  agent_id: (value) => started({ agent_id: value }),
  provider: (value) => started({ provider: value }),
  scenario: (value) => started({ scenario: value }),
  region: (value) => started({ region: value }),
  engine_version: (value) => started({ engine_version: value }),
  error_code: (value) => action({ error_code: value }),
};

/** What real producers send today: the fleet runner, the seed, the collector's error codes. */
const REAL_VALUES: Record<string, string[]> = {
  session_id: ["7f0c8b0e-2c1a-4a43-9c52-0b1e3d9f5a11", "seed-chromium-1", "trace-int-1"],
  agent_id: [
    "fleet-runner@LAPTOP-G1JS2HFL",
    "fleet-runner@build-agent-07.example.com",
    "seed-agent-1",
  ],
  provider: ["local-docker", "browserbase"],
  scenario: ["checkout-form", "heavy-page-crawl", "login-and-search", "long-idle-session"],
  region: ["local", "eu-west", "us-east-1"],
  engine_version: ["156.0.8078.4", "141.0", "HeadlessChrome/141.0.7390.37", "0.2.5+build.7"],
  error_code: [
    "timeout",
    "nav_error",
    "selector_not_found",
    "http_403",
    "http_5xx",
    "captcha",
    "js_error",
    "unsupported_api",
    "browser_closed",
    "unknown",
  ],
};

/** Characters that break out of an SQL string, a URL or a table cell, or that look like other ones. */
const HOSTILE: Array<[string, string]> = [
  ["a single quote", "o'brien"],
  ["a quote that ends the string", "x' OR '1'='1"],
  ["a backslash", "back\\slash"],
  ["a backslash before a quote (survives Grafana's singlequote)", "\\' OR 1=1 --"],
  ["a double quote", 'say "hi"'],
  ["a backtick", "tick`tock"],
  ["a space", "has space"],
  ["a tab", "a\tb"],
  ["a newline", "line\nbreak"],
  ["a NUL", "nul\u0000byte"],
  ["a semicolon", "a;b"],
  ["a comma", "a,b"],
  ["parentheses", "f(x)"],
  ["a percent sign", "100%"],
  ["a dollar sign", "$__timeFilter"],
  ["a letter with an accent", "café"],
  ["a CJK character", "日本語"],
  ["an emoji", "rocket-🚀"],
  ["a full-width letter that looks ASCII", "ＡＢＣ"],
  ["a right-to-left override", "a‮b"],
  ["a lone surrogate", "a\ud83d"],
  ["an empty string", ""],
  ["129 characters", "a".repeat(129)],
];

describe("SAFE_LABEL_PATTERN", () => {
  it("is exactly: 1 to 128 of A-Z a-z 0-9 . _ : @ / + -", () => {
    for (const ok of ["a", "A", "0", ".", "_", ":", "@", "/", "+", "-", "a".repeat(128)]) {
      expect(SAFE_LABEL_PATTERN.test(ok), ok).toBe(true);
    }
  });
});

describe.each(Object.keys(FIELDS))("%s", (field) => {
  const build = FIELDS[field] as (value: string) => ReturnType<typeof started>;

  it.each(REAL_VALUES[field] as string[])("accepts the real value %s", (value) => {
    expect(build(value).success).toBe(true);
  });

  it("accepts the longest value, 128 characters", () => {
    expect(build("a".repeat(128)).success).toBe(true);
  });

  it.each(HOSTILE)("rejects %s", (_name, value) => {
    const result = build(value);
    expect(result.success).toBe(false);
    if (result.success) return;
    // it is the field that is named, and the message does not repeat the value (it may be hostile)
    expect(result.error.issues.map((i) => i.path.join("."))).toContain(field);
    for (const issue of result.error.issues) {
      expect(issue.message).toBe("must be 1 to 128 characters from A-Z a-z 0-9 . _ : @ / + -");
    }
  });
});

describe("error_code stays optional", () => {
  it("accepts null (an action that succeeded)", () => {
    expect(action({ ok: true, error_code: null }).success).toBe(true);
  });
});

describe("engine_version stays nullable", () => {
  it("accepts null (an engine that does not report its version)", () => {
    expect(started({ engine_version: null }).success).toBe(true);
  });
});

describe('"." and ".." (QA-M2-16)', () => {
  it("are not session ids: no URL can name them, so such a session could never be opened", () => {
    for (const dots of [".", ".."]) {
      expect(SessionId.safeParse(dots).success, dots).toBe(false);
      const result = FIELDS.session_id?.(dots);
      expect(result?.success, dots).toBe(false);
      if (result?.success !== false) continue;
      expect(result.error.issues.map((i) => [i.path.join("."), i.message])).toEqual([
        ["session_id", "must not be . or .."],
      ]);
    }
  });

  it("are only refused exactly: other ids with dots are fine", () => {
    for (const id of ["...", ".hidden", "a.b", "a..b", "v1.2.3", "..a", "a.."]) {
      expect(SessionId.safeParse(id).success, id).toBe(true);
    }
  });

  it("stay allowed in the other labels (a host or a version can be made of dots)", () => {
    for (const field of ["agent_id", "provider", "scenario", "region", "engine_version"]) {
      for (const dots of [".", ".."]) {
        expect(
          (FIELDS[field] as (v: string) => ReturnType<typeof started>)(dots).success,
          field,
        ).toBe(true);
      }
    }
  });
});

describe("SessionId (the one rule for ids in events and URLs)", () => {
  it("accepts a UUID and rejects a hostile id", () => {
    expect(SessionId.safeParse(ctx.session_id).success).toBe(true);
    expect(SessionId.safeParse("x' OR 1=1 --").success).toBe(false);
    expect(SessionId.safeParse("a b").success).toBe(false);
  });
});

describe("fields that are NOT labels keep their freedom", () => {
  it("accepts quotes, spaces and unicode in reason, target, message, domain and resource_type", () => {
    const text = 'it\'s a "test" with \\ and 日本語 🚀';
    expect(
      FleetEvent.safeParse(
        newEvent("session.ended", ctx, { status: "failed", reason: text, duration_ms: 1 }),
      ).success,
    ).toBe(true);
    expect(action({ target: text }).success).toBe(true);
    expect(
      FleetEvent.safeParse(newEvent("issue", ctx, { kind: "crash", message: text })).success,
    ).toBe(true);
    expect(
      FleetEvent.safeParse(
        newEvent("network.request", ctx, {
          domain: "[::1]:3100",
          status: 200,
          bytes: 1,
          duration_ms: 1,
          resource_type: "other (cached)",
        }),
      ).success,
    ).toBe(true);
  });
});

describe("the event schemas export the same rule", () => {
  it("SessionStartedEvent rejects a bad scenario by itself", () => {
    const event = newEvent("session.started", ctx, {
      engine_version: null,
      scenario: "bad scenario",
      region: "local",
      startup_ms: 1,
      connect_ms: 1,
    });
    expect(SessionStartedEvent.safeParse(event).success).toBe(false);
  });
});
