import { describe, expect, it } from "vitest";
import { createRng, sessionSeed } from "./rng";
import type { SessionResult } from "./session-runner";
import { formatSummary } from "./summary";

function result(overrides: Partial<SessionResult>): SessionResult {
  return {
    index: 0,
    sessionId: "0123456789abcdef",
    engine: "chromium",
    routedFrom: null,
    scenario: "login-and-search",
    target: "demo",
    site: "demo-site",
    status: "success",
    reason: null,
    durationMs: 12_345,
    startupMs: 1800,
    connectMs: 600,
    actions: 11,
    failedActions: 1,
    peakMemMb: 312.4,
    ...overrides,
  };
}

const delivery = { pushed: 120, sent: 118, duplicates: 2, dropped: 0, pending: 0 };

describe("formatSummary", () => {
  it("prints a header, one row per session in order, and totals", () => {
    const text = formatSummary(
      [
        result({
          index: 1,
          status: "blocked",
          reason: "HTTP 403 for http://x/botwall",
          sessionId: "b".repeat(16),
        }),
        result({ index: 0 }),
      ],
      delivery,
      48_200,
    );
    const lines = text.split("\n");
    expect(lines[0]).toMatch(
      /^#\s+session\s+engine\s+target\/site\s+scenario\s+status\s+duration\s+startup\s+to browser\s+ok\/actions\s+peak mem$/,
    );
    expect(lines[2]).toContain("01234567");
    expect(lines[2]).toContain("success");
    expect(lines[2]).toContain("12.3s");
    expect(lines[2]).toContain("1.8s");
    expect(lines[2]).toContain("10/11");
    expect(lines[2]).toContain("312 MB");
    expect(lines[3]).toContain("blocked");
    expect(text).toContain("Why not success:\n  #2 blocked: HTTP 403 for http://x/botwall");
    expect(text).toContain("2 sessions in 48.2s: success 1, blocked 1");
    expect(text).toContain("events: 118 sent, 2 duplicates, 0 dropped");
  });

  it("shows a routed session as 'engine (from other)' and counts it where it ran", () => {
    const text = formatSummary(
      [
        result({ index: 0, engine: "chrome-headless-shell", routedFrom: "lightpanda" }),
        result({ index: 1, engine: "lightpanda" }),
      ],
      delivery,
      1000,
    );
    expect(text).toContain("chrome-headless-shell (from lightpanda)");
    expect(text).toMatch(/^ {2}lightpanda\s+1 sessions/m);
    expect(text).toMatch(/^ {2}chrome-headless-shell\s+1 sessions/m);
    expect(text).toContain("routed: 1 of 2 sessions (lightpanda -> chrome-headless-shell 1)");
  });

  it("prints no routed line when nothing was routed", () => {
    expect(formatSummary([result({})], delivery, 1000)).not.toContain("routed:");
  });

  it("shows sessions that never started as infra_error with dashes, and the reason", () => {
    const text = formatSummary(
      [
        result({
          status: "infra_error",
          reason: "browser server did not answer within 60000 ms",
          durationMs: 0,
          startupMs: null,
          actions: 0,
          failedActions: 0,
          peakMemMb: null,
        }),
      ],
      delivery,
      1000,
    );
    expect(text).toMatch(/infra_error\s+-\s+-\s+-\s+-/);
    expect(text).toContain("infra_error: browser server did not answer");
  });

  it("shows a session cut off by Ctrl+C before its browser was up as interrupted, with dashes", () => {
    const text = formatSummary(
      [
        result({
          status: "interrupted",
          reason: "interrupted while the browser container was starting",
          durationMs: 0,
          startupMs: null,
          actions: 0,
          failedActions: 0,
          peakMemMb: null,
        }),
      ],
      delivery,
      1000,
    );
    expect(text).toMatch(/interrupted\s+-\s+-\s+-\s+-/);
    expect(text).toContain("1 sessions in 1.0s: interrupted 1");
  });

  it("mentions sessions skipped by an interrupt", () => {
    expect(formatSummary([result({})], delivery, 1000, 4)).toContain("4 not started (interrupted)");
  });

  it("copes with no sessions at all", () => {
    expect(formatSummary([], delivery, 0)).toContain("0 sessions in 0.0s: none");
  });
});

describe("createRng", () => {
  it("same seed, same sequence", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it("stays in range and covers it", () => {
    const rng = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = rng.int(3, 6);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    for (let i = 0; i < 100; i++) {
      const x = rng.next();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it("chance(0) never and chance(1) always", () => {
    const rng = createRng(9);
    for (let i = 0; i < 200; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it("pick returns members", () => {
    const rng = createRng(3);
    for (let i = 0; i < 50; i++) expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
  });

  it("session seeds differ per session but follow the run seed", () => {
    expect(sessionSeed(7, 0)).not.toBe(sessionSeed(7, 1));
    expect(sessionSeed(7, 3)).toBe(sessionSeed(7, 3));
    expect(sessionSeed(7, 3)).not.toBe(sessionSeed(8, 3));
  });
});

describe("formatSummary per engine", () => {
  it("shows time to browser (startup + connect) and a total line per engine", () => {
    const text = formatSummary(
      [
        result({ index: 0, engine: "chromium", startupMs: 1000, connectMs: 500 }),
        result({ index: 1, engine: "lightpanda", startupMs: 200, connectMs: 50, peakMemMb: 40 }),
        result({
          index: 2,
          engine: "lightpanda",
          startupMs: 300,
          connectMs: 50,
          status: "failed",
          reason: "x",
          peakMemMb: null,
        }),
      ],
      delivery,
      5000,
    );
    expect(text).toMatch(/1\.5s/); // chromium: 1000 + 500
    expect(text).toContain("By engine:");
    expect(text).toMatch(/chromium\s+1 sessions\s+1 success/);
    expect(text).toMatch(/lightpanda\s+2 sessions\s+1 success/);
    expect(text).toMatch(/lightpanda.*to browser avg 0\.3s.*peak mem max 40 MB/);
  });
});
