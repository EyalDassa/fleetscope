import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BlockedError, CollectedError, type Collector } from "@fleetscope/collector";
import pino from "pino";
import type { Browser } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { assignPublic, routeSession } from "./assign";
import { loadConfig } from "./config";
import type { DockerFleet } from "./docker";
import type { RunOptions } from "./options";
import { classifyOutcome } from "./outcome";
import { runFleet } from "./run";
import { PUBLIC_SCENARIOS } from "./scenarios/public";
import { createPauseStore, PAUSE_MS } from "./scenarios/public/pause";
import type { SiteRun } from "./scenarios/public/robots";
import { PUBLIC_SITES, type PublicSite, SITES } from "./scenarios/public/sites";
import { openPage, type SessionResult, type SessionSpec } from "./session-runner";

const logger = pino({ level: "silent" });
const config = loadConfig({});
const ENGINES = ["chromium", "chrome-headless-shell", "lightpanda"] as const;
const fleets = new Map(ENGINES.map((e) => [e, {} as DockerFleet]));
const collectors = () =>
  new Map(
    ENGINES.map((e) => [
      e,
      {
        close: async () => undefined,
        stats: () => ({ pushed: 0, sent: 0, duplicates: 0, dropped: 0, pending: 0 }),
      } as unknown as Collector,
    ]),
  );

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    engines: [...ENGINES],
    sessions: 10,
    concurrency: 1,
    scenario: "mix",
    seed: 0,
    agentId: "test",
    routing: "fixed",
    sessionTimeoutMs: 1000,
    public: 0,
    stateFile: undefined,
    ...overrides,
  };
}

const siteRun = (site: PublicSite): SiteRun => ({
  descriptor: SITES[site],
  paths: SITES[site].paths,
  allows: () => true,
  minDelayMs: SITES[site].minDelayMs,
});
const allSites = new Map(PUBLIC_SITES.map((s) => [s, siteRun(s)]));

function result(spec: SessionSpec, status: SessionResult["status"] = "success"): SessionResult {
  return {
    index: spec.index,
    sessionId: `s${spec.index}`,
    engine: spec.engine,
    routedFrom: spec.routedFrom ?? null,
    scenario: spec.scenario,
    target: spec.target ?? "demo",
    site: spec.site ?? "demo-site",
    status,
    reason: status === "blocked" ? "HTTP 429" : null,
    durationMs: 1,
    startupMs: 1,
    connectMs: 1,
    actions: 1,
    failedActions: 0,
    peakMemMb: 1,
  };
}

async function run(opts: Partial<RunOptions>, extra: Partial<Parameters<typeof runFleet>[0]> = {}) {
  const specs: SessionSpec[] = [];
  const out = await runFleet({
    config,
    options: options(opts),
    fleets,
    collectors: collectors(),
    logger,
    signal: new AbortController().signal,
    publicSites: allSites,
    runSession: async (_deps, spec) => {
      specs.push(spec);
      return result(spec);
    },
    ...extra,
  });
  return { specs, out };
}

describe("assignPublic", () => {
  it("goes round the sites, and the engines move too, so 5 sessions are 5 sites on mixed engines", () => {
    const picks = [0, 1, 2, 3, 4].map((n) => assignPublic([...ENGINES], [...PUBLIC_SITES], n));
    expect(picks.map((p) => p.site)).toEqual([...PUBLIC_SITES]);
    expect(new Set(picks.map((p) => p.engine)).size).toBe(3);
  });

  it("every site meets every engine over a long run, also when sites and engines are 3 and 3", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const p = assignPublic([...ENGINES], ["wikipedia", "mdn", "govuk"], n);
      seen.add(`${p.site}/${p.engine}`);
    }
    expect(seen.size).toBe(9);
  });

  it("each site has its own journey, and routing leaves a public session where it is (no capability needed)", () => {
    for (const site of PUBLIC_SITES) {
      const pick = assignPublic([...ENGINES], [site], 0);
      expect(Object.keys(PUBLIC_SCENARIOS)).toContain(pick.scenario);
      const routed = routeSession(
        { engine: "lightpanda", scenario: pick.scenario },
        [...ENGINES],
        "by-scenario",
      );
      expect(routed).toEqual({ engine: "lightpanda", scenario: pick.scenario, routedFrom: null });
    }
  });

  it("with the sites that are left (one paused), the rotation uses only those", () => {
    const left = PUBLIC_SITES.filter((s) => s !== "govuk");
    const sites = new Set(
      [0, 1, 2, 3, 4, 5, 6, 7].map((n) => assignPublic([...ENGINES], left, n).site),
    );
    expect(sites.has("govuk")).toBe(false);
    expect(sites.size).toBe(4);
  });
});

describe("runFleet with --public", () => {
  it("the first N sessions of the batch are public, the rest the demo mix; each gets its site and journey", async () => {
    const { specs } = await run({ sessions: 8, public: 3 });
    const bySession = [...specs].sort((a, b) => a.index - b.index);
    expect(bySession.slice(0, 3).map((s) => s.target)).toEqual(["public", "public", "public"]);
    expect(bySession.slice(3).every((s) => s.target === "demo" && s.site === "demo-site")).toBe(
      true,
    );
    for (const s of bySession.slice(0, 3)) {
      expect(Object.keys(PUBLIC_SCENARIOS)).toContain(s.scenario);
      expect(s.siteRun?.descriptor.site).toBe(s.site);
    }
    expect(new Set(bySession.slice(0, 3).map((s) => s.site)).size).toBe(3);
    // the demo sessions still follow the demo mix, never a public journey
    expect(bySession.slice(3).every((s) => !(s.scenario in PUBLIC_SCENARIOS))).toBe(true);
  });

  it("--public 0 changes nothing: every session is a demo session", async () => {
    const { specs } = await run({ sessions: 6, public: 0 });
    expect(specs.every((s) => s.target === "demo" && s.siteRun === undefined)).toBe(true);
  });

  it("keeps rotating from one batch to the next when the caller shares the counter (traffic)", async () => {
    const publicCounter = { next: 0 };
    const sites: string[] = [];
    for (let batch = 0; batch < 5; batch++) {
      const { specs } = await run(
        { sessions: 2, public: 1 },
        { publicCounter, firstIndex: batch * 2 },
      );
      sites.push(...specs.filter((s) => s.target === "public").map((s) => s.site as string));
    }
    expect(sites).toEqual([...PUBLIC_SITES]);
  });

  it("a blocked public session pauses its site for an hour and writes it to the pause store", async () => {
    const pause = createPauseStore();
    const now = 5_000_000;
    await run(
      { sessions: 4, public: 4, engines: ["chromium"] },
      {
        pause,
        now: () => now,
        publicSites: new Map([
          ["wikipedia", siteRun("wikipedia")],
          ["mdn", siteRun("mdn")],
        ]),
        runSession: async (_deps, spec) =>
          result(spec, spec.site === "wikipedia" ? "blocked" : "success"),
      },
    );
    expect(pause.pausedUntil("wikipedia", now)).toBe(now + PAUSE_MS);
    expect(pause.isPaused("mdn", now)).toBe(false);
  });

  it("paused sites are skipped by the next sessions of the same run", async () => {
    const pause = createPauseStore();
    const seen: string[] = [];
    await run(
      { sessions: 6, public: 6, engines: ["chromium"] },
      {
        pause,
        publicSites: new Map([
          ["wikipedia", siteRun("wikipedia")],
          ["mdn", siteRun("mdn")],
        ]),
        runSession: async (_deps, spec) => {
          seen.push(spec.site as string);
          return result(spec, spec.site === "wikipedia" ? "blocked" : "success");
        },
      },
    );
    // wikipedia is tried once (the first session), pushes back, and is not visited again
    expect(seen.filter((s) => s === "wikipedia")).toHaveLength(1);
    expect(seen.filter((s) => s === "mdn").length).toBe(5);
  });

  it("a site paused before the run (from the state file) is not visited", async () => {
    const pause = createPauseStore();
    pause.pause("mdn", Date.now() + 60_000);
    const { specs } = await run({ sessions: 5, public: 5 }, { pause });
    expect(specs.some((s) => s.site === "mdn")).toBe(false);
    expect(specs.filter((s) => s.target === "public")).toHaveLength(5);
  });

  it("with no site available the public sessions run on the demo site, and it is logged once", async () => {
    const warn = vi.fn();
    const { specs } = await run(
      { sessions: 3, public: 3 },
      { publicSites: new Map(), logger: { ...logger, warn } as unknown as typeof logger },
    );
    expect(specs.every((s) => s.target === "demo")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("only a blocked public session pauses; a failed one (site_layout) does not", async () => {
    const pause = createPauseStore();
    await run(
      { sessions: 3, public: 3 },
      { pause, runSession: async (_deps, spec) => result(spec, "failed") },
    );
    for (const site of PUBLIC_SITES) expect(pause.isPaused(site)).toBe(false);
  });
});

describe("how a public session ends", () => {
  const base = {
    interrupted: false,
    timedOut: false,
    sessionTimeoutMs: 120_000,
    disconnected: false,
  };

  it("a 403, 429 or CAPTCHA (BlockedError) is blocked, as on the demo botwall", () => {
    for (const code of ["http_403", "captcha"] as const) {
      expect(classifyOutcome({ ...base, error: new BlockedError(code, "x") }).status).toBe(
        "blocked",
      );
    }
  });

  it("site_layout is failed, with the landmark in the reason: the site changed, nothing is blocked", () => {
    const outcome = classifyOutcome({
      ...base,
      error: new CollectedError(
        "site_layout",
        "landmark missing on https://x/: #firstHeading | h1",
      ),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("landmark missing");
  });
});

describe("no fingerprint changes (Eyal's rule, docs/adr/0007)", () => {
  it("a public session opens its page exactly as a demo session does: one context, only the viewport", async () => {
    const newContext = vi.fn(async (_options: unknown) => ({ newPage: async () => ({}) }));
    const browser = { newContext } as unknown as Browser;
    // openPage is the only way the runner opens a page, for demo and public sessions alike
    await openPage(browser, logger);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(newContext.mock.calls[0]?.[0]).toEqual({ viewport: { width: 1280, height: 720 } });
  });

  const FORBIDDEN =
    /userAgent|user-agent|extraHTTPHeaders|setExtraHTTPHeaders|locale|timezoneId|setUserAgent|addInitScript|\.route\(|bypassCSP/i;

  it("nothing in the runner or the public journeys sets a user agent, header, locale or init script", () => {
    const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const files = [
      join(here, "session-runner.ts"),
      ...readdirSync(join(here, "scenarios", "public"))
        .filter((f) => ["journeys.ts", "index.ts"].includes(f))
        .map((f) => join(here, "scenarios", "public", f)),
    ];
    expect(files.length).toBe(3);
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        // comments may talk about it (they say "no user agent")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(FORBIDDEN);
    }
  });

  it("the journeys only use the collector-wrapped page: they never reach for page.raw or a context", () => {
    const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const code = readFileSync(join(here, "scenarios", "public", "journeys.ts"), "utf8");
    expect(code).not.toMatch(/\.raw\b|\.context\(|newContext|newPage/);
  });
});
