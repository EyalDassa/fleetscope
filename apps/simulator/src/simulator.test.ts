import { readFileSync } from "node:fs";
import {
  ENGINES,
  ERROR_CODES,
  type ErrorCode,
  EventBatch,
  type FleetEvent,
  ISSUE_FOR_CODE,
  SAFE_LABEL_PATTERN,
} from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { buildProfile, latestVersion, type RawData } from "./calibrate";
import { generateSession } from "./generate";
import { LiveStream } from "./live";
import { pairFor, parseDuration, planRun, simAgentId } from "./plan";
import { batchSessions, PostError, postBatch } from "./post";
import { assertProfile, type Profile, scenariosOf } from "./profile";
import { createRng, fitDist, sampleDist } from "./rng";

const profile: Profile = assertProfile(
  JSON.parse(readFileSync(new URL("./profile.json", import.meta.url), "utf8")),
);
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const strip = (events: FleetEvent[]) =>
  events.map(({ event_id: _id, session_id: _sid, ...rest }) => rest);

describe("generateSession", () => {
  const plan = {
    engine: "chromium" as const,
    scenario: "login-and-search",
    startMs: NOW,
    seed: 7,
    index: 3,
    agentId: "sim@test",
    provider: "local-docker",
  };

  it("is deterministic for a seed (event ids aside) and differs between seeds", () => {
    expect(strip(generateSession(profile, plan))).toEqual(strip(generateSession(profile, plan)));
    expect(strip(generateSession(profile, { ...plan, seed: 8 }))).not.toEqual(
      strip(generateSession(profile, plan)),
    );
  });

  it("starts with session.started, ends with session.ended, and has actions numbered from 0", () => {
    const events = generateSession(profile, plan);
    expect(events[0]?.type).toBe("session.started");
    expect(events.at(-1)?.type).toBe("session.ended");
    const seqs = events.flatMap((e) => (e.type === "action" ? [e.seq] : []));
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(events.every((e) => e.ts >= NOW && e.ts <= (events.at(-1)?.ts ?? 0))).toBe(true);
  });

  it("every event of every engine and scenario passes EventBatch and the safe-label pattern", () => {
    for (const engine of ENGINES) {
      for (const scenario of scenariosOf(profile)) {
        for (let index = 0; index < 30; index++) {
          const events = generateSession(profile, { ...plan, engine, scenario, index });
          const parsed = EventBatch.safeParse(events);
          expect(parsed.success, `${engine} ${scenario} #${index}`).toBe(true);
          for (const e of events) {
            expect(e.source).toBe("sim");
            expect(e.session_id).toMatch(SAFE_LABEL_PATTERN);
            expect(e.agent_id).toMatch(SAFE_LABEL_PATTERN);
          }
        }
      }
    }
  });

  it("a failed session ends on its failing action, with the issue the real runner would raise", () => {
    let seen = 0;
    for (let index = 0; index < 200; index++) {
      const events = generateSession(profile, {
        ...plan,
        engine: "lightpanda",
        scenario: "heavy-page-crawl",
        index,
      });
      const ended = events.at(-1);
      if (ended?.type !== "session.ended" || ended.status === "success") continue;
      seen++;
      const actions = events.filter((e) => e.type === "action");
      const lastAction = actions.at(-1);
      expect(lastAction?.type === "action" && lastAction.ok).toBe(false);
      const code = lastAction?.type === "action" ? lastAction.error_code : null;
      const issue = events.find((e) => e.type === "issue");
      expect(issue?.type === "issue" ? issue.kind : undefined).toBe(
        ISSUE_FOR_CODE[code as ErrorCode] ?? undefined,
      );
    }
    expect(seen).toBeGreaterThan(50);
  });

  it("Lightpanda never reports a JS heap, Chromium does", () => {
    const heaps = (engine: "chromium" | "lightpanda") =>
      Array.from({ length: 20 }, (_, index) =>
        generateSession(profile, { ...plan, engine, scenario: "heavy-page-crawl", index }),
      )
        .flat()
        .flatMap((e) => (e.type === "resource.sample" && e.origin === "cdp" ? [e.js_heap_mb] : []));
    expect(heaps("lightpanda").every((h) => h === null)).toBe(true);
    const chromium = heaps("chromium");
    expect(chromium.length).toBeGreaterThan(0);
    expect(chromium.every((h) => typeof h === "number" && h > 0)).toBe(true);
  });

  it("memory rises over a longer session (stretch), and container samples are 2 s apart", () => {
    const events = generateSession(profile, {
      ...plan,
      scenario: "heavy-page-crawl",
      stretch: 10,
    });
    const samples = events.flatMap((e) =>
      e.type === "resource.sample" && e.origin === "container" ? [e] : [],
    );
    expect(samples.length).toBeGreaterThan(5);
    expect((samples[1]?.ts ?? 0) - (samples[0]?.ts ?? 0)).toBe(2000);
    const mem = samples.map((s) => s.mem_mb as number);
    expect(mem.at(-1)).toBeGreaterThan(mem[0] as number);
  });
});

describe("distribution sanity", () => {
  const medianOf = (values: number[]) => fitDist(values)?.p50 as number;
  const sessionsOf = (engine: "chromium" | "chrome-headless-shell" | "lightpanda", n = 150) =>
    Array.from({ length: n }, (_, index) =>
      generateSession(profile, {
        engine,
        scenario: "heavy-page-crawl",
        startMs: NOW,
        seed: 1,
        index,
        agentId: "sim@test",
        provider: "local-docker",
      }),
    );
  const peak = (events: FleetEvent[]) =>
    Math.max(
      ...events.flatMap((e) =>
        e.type === "resource.sample" && e.origin === "container" ? [e.mem_mb as number] : [],
      ),
    );

  it("sampleDist hits its median and 95th percentile", () => {
    const rng = createRng(1);
    const values = Array.from({ length: 20_000 }, () => sampleDist(rng, { p50: 100, p95: 400 }));
    const fitted = fitDist(values) as { p50: number; p95: number };
    expect(fitted.p50).toBeGreaterThan(95);
    expect(fitted.p50).toBeLessThan(105);
    expect(fitted.p95).toBeGreaterThan(370);
    expect(fitted.p95).toBeLessThan(430);
  });

  it("Lightpanda uses far less memory than Chromium, headless-shell a bit less", () => {
    const chromium = medianOf(sessionsOf("chromium").map(peak));
    const shell = medianOf(sessionsOf("chrome-headless-shell").map(peak));
    const lightpanda = medianOf(sessionsOf("lightpanda").map(peak));
    expect(lightpanda).toBeLessThan(chromium / 5);
    expect(shell).toBeLessThan(chromium);
    expect(shell).toBeGreaterThan(chromium * 0.5);
  });

  it("Lightpanda fails checkout-form most of the time, Chromium rarely", () => {
    const failRate = (engine: "chromium" | "lightpanda") => {
      const runs = Array.from({ length: 300 }, (_, index) =>
        generateSession(profile, {
          engine,
          scenario: "checkout-form",
          startMs: NOW,
          seed: 2,
          index,
          agentId: "sim@test",
          provider: "local-docker",
        }),
      );
      return (
        runs.filter((events) => {
          const ended = events.at(-1);
          return ended?.type === "session.ended" && ended.status !== "success";
        }).length / runs.length
      );
    };
    expect(failRate("lightpanda")).toBeGreaterThan(0.6);
    expect(failRate("chromium")).toBeLessThan(0.3);
  });

  it("Lightpanda gets a usable browser faster than Chromium", () => {
    const ttb = (engine: "chromium" | "lightpanda") =>
      medianOf(
        sessionsOf(engine).map((events) => {
          const started = events[0];
          return started?.type === "session.started"
            ? started.startup_ms + started.connect_ms
            : Number.NaN;
        }),
      );
    expect(ttb("lightpanda")).toBeLessThan(ttb("chromium"));
  });
});

describe("planRun", () => {
  const options = {
    sessions: 120,
    windowMs: 30 * 60_000,
    seed: 5,
    now: NOW,
    engines: [...ENGINES],
    agentId: simAgentId("my host!"),
  };

  it("spreads the sessions over the window, never into the future, deterministically", () => {
    const runA = planRun(profile, options);
    const runB = planRun(profile, options);
    expect(runA.map(strip)).toEqual(runB.map(strip));
    expect(runA).toHaveLength(120);
    const all = runA.flat();
    expect(Math.max(...all.map((e) => e.ts))).toBeLessThanOrEqual(NOW);
    const starts = runA.map((s) => (s[0] as FleetEvent).ts);
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(NOW - 30 * 60_000);
    expect(Math.min(...starts)).toBeLessThan(NOW - 28 * 60_000);
    expect(Math.max(...starts)).toBeGreaterThan(NOW - 3 * 60_000);
    expect(new Set(all.map((e) => e.session_id)).size).toBe(120);
  });

  it("gives every scenario to every engine, evenly", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 90; i++) {
      const { engine, scenario } = pairFor(profile, [...ENGINES], 5, i);
      counts.set(`${engine}/${scenario}`, (counts.get(`${engine}/${scenario}`) ?? 0) + 1);
    }
    expect(counts.size).toBe(9);
    for (const n of counts.values()) expect(n).toBe(10);
  });

  it("the agent id is a safe label like sim@<host>", () => {
    expect(options.agentId).toBe("sim@my-host-");
    expect(options.agentId).toMatch(SAFE_LABEL_PATTERN);
  });

  it("parseDuration reads 90s, 10m, 2h and refuses nonsense", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(() => parseDuration("soon")).toThrow(/not a duration/);
  });
});

describe("batching and posting", () => {
  const sessions = planRun(profile, {
    sessions: 60,
    windowMs: 600_000,
    seed: 3,
    now: NOW,
    engines: [...ENGINES],
    agentId: "sim@test",
  });

  it("batches hold at most 1000 events and never split a session", () => {
    const batches = batchSessions(sessions);
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(1000);
    expect(batches.flat()).toHaveLength(sessions.flat().length);
    for (const batch of batches) {
      const started = new Set(
        batch.filter((e) => e.type === "session.started").map((e) => e.session_id),
      );
      for (const e of batch.filter((x) => x.type === "session.ended")) {
        expect(started.has(e.session_id)).toBe(true);
      }
    }
  });

  it("retries a 503 after Retry-After and then succeeds; a 400 is an error", async () => {
    const answers = [
      new Response("full", { status: 503, headers: { "retry-after": "2" } }),
      new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), { status: 202 }),
    ];
    const waits: number[] = [];
    await postBatch(sessions[0] as FleetEvent[], {
      apiUrl: "http://api.test/",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: (async () => answers.shift()) as unknown as typeof fetch,
    });
    expect(waits).toEqual([2000]);

    await expect(
      postBatch(sessions[0] as FleetEvent[], {
        apiUrl: "http://api.test",
        fetchImpl: (async () => new Response("bad ts", { status: 400 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/400: bad ts/);
  });
});

describe("buildProfile", () => {
  it("refuses to calibrate without real Chromium sessions", () => {
    const empty: RawData = { sessions: [], actions: [], samples: [], requests: [] };
    expect(() => buildProfile(empty)).toThrow(/at least 10 real chromium sessions/);
  });

  it("builds a real Chromium profile and derives the others with the priors", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      session_id: `s${i}`,
      engine: "chromium",
      scenario: "login-and-search",
      status: i < 9 ? "success" : "failed",
      reason: i < 9 ? null : "selector not found",
      engine_version: "156.0.1.2",
      started_at: `2026-10-24 12:00:${String(10 + i)}`,
      startup_ms: 1000 + i * 100,
      connect_ms: 500,
      duration_ms: 2000 + i * 10,
    }));
    const data: RawData = {
      sessions,
      actions: sessions.flatMap((s, i) => [
        {
          session_id: s.session_id,
          seq: 0,
          action_type: "goto",
          target: "localhost",
          duration_ms: 100,
          ok: true,
          error_code: null,
        },
        {
          session_id: s.session_id,
          seq: 1,
          action_type: "click",
          target: "#go",
          duration_ms: 50,
          ok: i < 9,
          error_code: i < 9 ? null : "selector_not_found",
        },
      ]),
      samples: sessions.flatMap((s) => [
        {
          session_id: s.session_id,
          origin: "container",
          cpu_pct: 40,
          mem_mb: 100,
          js_heap_mb: null,
        },
        {
          session_id: s.session_id,
          origin: "container",
          cpu_pct: 60,
          mem_mb: 200,
          js_heap_mb: null,
        },
        { session_id: s.session_id, origin: "cdp", cpu_pct: null, mem_mb: null, js_heap_mb: 5 },
      ]),
      requests: [],
    };
    const built = buildProfile(data, new Date(NOW));
    expect(built.engines.chromium).toMatchObject({
      basis: "measured",
      real_sessions: 12,
      engine_version: "156.0.1.2",
    });
    const scenario = built.engines.chromium.scenarios["login-and-search"];
    expect(scenario?.peak_mem_mib.p50).toBe(200);
    expect(scenario?.base_ratio).toBe(0.5);
    expect(scenario?.failures).toEqual([
      {
        p: 0.25,
        status: "failed",
        error_code: "selector_not_found",
        reason: "selector not found",
        at: 1,
      },
    ]);
    expect(built.engines.lightpanda.basis).toBe("prior");
    expect(built.engines.lightpanda.heap_mb).toBeNull();
    expect(
      built.engines["chrome-headless-shell"].scenarios["login-and-search"]?.peak_mem_mib.p50,
    ).toBe(150);
  });
});

describe("session ids (R-M3-04)", () => {
  it("two runs with the same seed have the same content but disjoint session ids", () => {
    const options = {
      sessions: 20,
      windowMs: 600_000,
      seed: 42,
      now: NOW,
      engines: [...ENGINES],
      agentId: "sim@test",
    };
    const a = planRun(profile, options);
    const b = planRun(profile, options);
    expect(a.map(strip)).toEqual(b.map(strip));
    const ids = (run: FleetEvent[][]) => new Set(run.flat().map((e) => e.session_id));
    for (const id of ids(a)) expect(ids(b).has(id)).toBe(false);
    for (const id of ids(a)) expect(id).toMatch(SAFE_LABEL_PATTERN);
  });
});

describe("the profile", () => {
  it("only uses error codes of the shared vocabulary", () => {
    for (const engine of Object.values(profile.engines)) {
      for (const scenario of Object.values(engine.scenarios)) {
        for (const failure of scenario.failures) {
          expect(ERROR_CODES as readonly string[]).toContain(failure.error_code);
        }
      }
    }
  });

  it("Lightpanda's engine_version is not a Chrome version (R-M3-12)", () => {
    const version = profile.engines.lightpanda.engine_version;
    // Chrome's look like 124.0.6367.29 (a three digit major), Lightpanda's like 1.0.2
    if (version !== null) expect(version).not.toMatch(/^\d{3,}\./);
  });

  it("latestVersion takes the newest session's version, not the most common", () => {
    const s = (started_at: string, engine_version: string | null) =>
      ({ started_at, engine_version }) as never;
    expect(
      latestVersion([
        s("2026-10-01", "124.0.1.2"),
        s("2026-10-02", "124.0.1.2"),
        s("2026-10-24", "1.0.2"),
      ]),
    ).toBe("1.0.2");
    expect(latestVersion([])).toBeNull();
  });
});

describe("LiveStream (Ctrl+C, R-M3-09)", () => {
  const stretched = (index: number) =>
    generateSession(profile, {
      engine: "chromium",
      scenario: "heavy-page-crawl",
      startMs: NOW,
      seed: 1,
      index,
      agentId: "sim@test",
      provider: "local-docker",
      stretch: 200, // ends many minutes in the future
    });

  it("stops by ending in-flight sessions at now as interrupted, with nothing in the future", async () => {
    const batches: FleetEvent[][] = [];
    const stream = new LiveStream(async (batch) => {
      batches.push(batch);
    });
    stream.add(stretched(1));
    stream.add(stretched(2));
    await stream.flushDue(NOW + 100);
    expect(stream.inFlight).toBe(2);
    await stream.stop(NOW + 5000);
    const sent = batches.flat();
    expect(Math.max(...sent.map((e) => e.ts))).toBeLessThanOrEqual(NOW + 5000);
    const ended = sent.filter((e) => e.type === "session.ended");
    expect(ended).toHaveLength(2);
    for (const e of ended) {
      expect(e).toMatchObject({ status: "failed", reason: "interrupted", ts: NOW + 5000 });
      expect(e.type === "session.ended" && e.duration_ms).toBe(5000);
    }
    expect(EventBatch.safeParse(batches[0]).success).toBe(true);
    // every session that started also ended
    const started = new Set(
      sent.filter((e) => e.type === "session.started").map((e) => e.session_id),
    );
    expect(new Set(ended.map((e) => e.session_id))).toEqual(started);
  });

  it("a batch that fails with a 503 or a network error is retried, not dropped", async () => {
    let calls = 0;
    const got: FleetEvent[][] = [];
    const stream = new LiveStream(async (batch) => {
      calls += 1;
      if (calls <= 2) throw new PostError("down", calls === 1 ? 503 : null);
      got.push(batch);
    });
    stream.add(stretched(3));
    await stream.flushDue(NOW + 100);
    await stream.stop(NOW + 3000);
    expect(stream.dropped).toBe(0);
    expect(got.flat().some((e) => e.type === "session.ended")).toBe(true);
  });

  it("a 400 is dropped (retrying cannot help) and counted", async () => {
    const stream = new LiveStream(async () => {
      throw new PostError("bad", 400);
    });
    stream.add(stretched(4));
    await stream.flushDue(NOW + 100);
    expect(stream.dropped).toBeGreaterThan(0);
  });
});
