import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Collector, createCollector, type Transport } from "@fleetscope/collector";
import type { Engine, FleetEvent } from "@fleetscope/schema";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { DockerFleet } from "./docker";
import { engineImages } from "./engines";
import type { RunOptions } from "./options";
import { runFleet } from "./run";
import { createPauseStore, PAUSE_MS } from "./scenarios/public/pause";
import { fetchRobots, prepareSites, type SiteRun } from "./scenarios/public/robots";
import { PUBLIC_SITES, SITES } from "./scenarios/public/sites";
import type { SessionResult, SessionSpec } from "./session-runner";

/**
 * QA, public-sites: ONE public session per engine against a LOCAL stub (never a real site), with
 * real browser containers. Opt-in (starts Docker containers, no database or API needed):
 *
 *   FLEET_E2E=1 pnpm --filter @fleetscope/fleet-runner exec vitest run src/public.stub.e2e.test.ts
 *
 * The stub is reached as host.docker.internal:<port>. It records the raw request headers.
 */
const ENABLED = process.env.FLEET_E2E === "1";
const logger = pino({ level: "silent" });
const config = loadConfig({});
const images = engineImages(process.env);

type Mode = "ok" | "429" | "captcha";
let mode: Mode = "ok";
const seen: { url: string; headers: string[]; ua: string | undefined }[] = [];
let server: Server;
let port = 0;

const PAGE =
  "<html><body><h1 id='firstHeading'>Web browser</h1><div id='mw-content-text'><p><a href='/wiki/Other'>x</a></p></div></body></html>";
const CAPTCHA_PAGE = "<html><body><iframe src='https://x.example/captcha'></iframe></body></html>";

function handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
  if (req.url === "/favicon.ico") {
    res.writeHead(404).end();
    return;
  }
  const raw = req.rawHeaders.filter((_, i) => i % 2 === 0).map((h) => h.toLowerCase());
  seen.push({ url: req.url ?? "", headers: raw, ua: req.headers["user-agent"] });
  if (mode === "429") res.writeHead(429, { "retry-after": "60" }).end("slow down");
  else if (mode === "captcha")
    res.writeHead(200, { "content-type": "text/html" }).end(CAPTCHA_PAGE);
  else res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
}

function stubSiteRun(): SiteRun {
  const base = SITES.wikipedia;
  const descriptor = {
    ...base,
    baseUrl: `http://host.docker.internal:${port}`,
    host: `host.docker.internal:${port}`,
    paths: ["/wiki/Web_browser"],
    minDelayMs: 0,
  };
  return {
    descriptor,
    paths: descriptor.paths,
    allows: () => true,
    minDelayMs: 0,
  };
}

function options(engine: Engine, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    engines: [engine],
    sessions: 1,
    concurrency: 1,
    scenario: "mix",
    seed: 1,
    agentId: "qa-stub",
    routing: "fixed",
    sessionTimeoutMs: 60_000,
    public: 1,
    stateFile: undefined,
    ...overrides,
  } as RunOptions;
}

/** One public session on `engine`; the events the collector would send are returned. */
async function publicSession(engine: Engine, stateFile: string) {
  const events: FleetEvent[] = [];
  const transport: Transport = {
    async send(batch) {
      events.push(...batch);
      return { status: "accepted", accepted: batch.length, duplicates: 0 };
    },
  };
  const collector = createCollector({
    apiUrl: "http://127.0.0.1:1",
    source: "real",
    agentId: "qa-stub",
    provider: "local-docker",
    engine,
    transport,
    logger,
    flushIntervalMs: 50,
    heapSampleIntervalMs: 0,
  });
  const pause = createPauseStore(stateFile);
  const siteRun = stubSiteRun();
  const out = await runFleet({
    config,
    options: options(engine, { stateFile }),
    fleets: new Map([[engine, new DockerFleet(images[engine], engine, logger)]]),
    collectors: new Map([[engine, collector]]),
    logger,
    signal: new AbortController().signal,
    publicSites: new Map([["wikipedia", siteRun]]),
    pause,
  });
  return { result: out.results[0] as SessionResult, events, pause };
}

describe.skipIf(!ENABLED)("a public session against a local stub (real containers)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-pub-"));
    server = createServer(handle);
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  for (const engine of ["chromium", "lightpanda"] as const) {
    it(`${engine}: the wire carries the engine's own User-Agent and no extra headers`, async () => {
      mode = "ok";
      seen.length = 0;
      const { result } = await publicSession(engine, join(dir, `ok-${engine}.json`));
      process.stderr.write(`[ok:${engine}] status=${result.status} reason=${result.reason}
`);
      expect(result.status).toBe("success");
      expect(seen.length).toBeGreaterThanOrEqual(1);
      const first = seen[0];
      // the engine's own default, not a browser-looking disguise
      expect(first?.ua).toMatch(engine === "chromium" ? /HeadlessChrome/ : /Lightpanda/i);
      // no header an engine would not send on its own (nothing custom: x-*, authorization, referer, ...)
      const custom = (first?.headers ?? []).filter(
        (h) => h.startsWith("x-") || ["authorization", "referer", "from", "cookie"].includes(h),
      );
      expect(custom).toEqual([]);
      process.stderr.write(
        `[wire:${engine}] ua=${first?.ua}\n[wire:${engine}] headers=${first?.headers.join(",")}\n`,
      );
    }, 120_000);

    it(`${engine}: a 429 ends blocked, pauses the site for ~1 h in the state file, next assignment skips it`, async () => {
      mode = "429";
      seen.length = 0;
      const file = join(dir, `429-${engine}.json`);
      const before = Date.now();
      const { result, events, pause } = await publicSession(engine, file);
      expect(result.status).toBe("blocked");
      const codes = events
        .filter((e) => e.type === "action" || e.type === "issue")
        .map((e) =>
          JSON.stringify(e).replace(/"(session_id|event_id|ts|agent_id)":"[^"]*",?/g, ""),
        );
      process.stderr.write(
        `[429:${engine}] reason=${result.reason} codes=${codes.join(" | ")} types=${[...new Set(events.map((e) => e.type))].join(",")}\n`,
      );
      expect(codes.join(" ")).toContain('"error_code":"http_429"');
      const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
      const until = state.wikipedia ?? 0;
      expect(until - before).toBeGreaterThan(PAUSE_MS - 60_000);
      expect(until - before).toBeLessThan(PAUSE_MS + 60_000);
      expect(pause.isPaused("wikipedia")).toBe(true);

      // the next assignment: a public session is wanted, the only site is paused
      const specs: SessionSpec[] = [];
      await runFleet({
        config,
        options: options(engine, { stateFile: file }),
        fleets: new Map([[engine, {} as DockerFleet]]),
        collectors: new Map([
          [
            engine,
            {
              close: async () => undefined,
              flush: async () => undefined,
              stats: () => ({ pushed: 0, sent: 0, duplicates: 0, dropped: 0, pending: 0 }),
            } as unknown as Collector,
          ],
        ]),
        logger,
        signal: new AbortController().signal,
        publicSites: new Map([["wikipedia", stubSiteRun()]]),
        pause: createPauseStore(file),
        runSession: async (_deps, spec) => {
          specs.push(spec);
          return { status: "success", target: spec.target } as SessionResult;
        },
      });
      expect(specs).toHaveLength(1);
      expect(specs[0]?.target ?? "demo").toBe("demo"); // fell back: the paused site was not assigned
      expect(specs[0]?.site).not.toBe("wikipedia");
    }, 120_000);

    it(`${engine}: a CAPTCHA page ends blocked and pauses the site`, async () => {
      mode = "captcha";
      const file = join(dir, `captcha-${engine}.json`);
      const { result, events, pause } = await publicSession(engine, file);
      const codes = events.filter((e) => e.type === "action").map((e) => JSON.stringify(e));
      expect(codes.join(" ")).toContain('"error_code":"captcha"');
      process.stderr.write(
        `[captcha:${engine}] status=${result.status} reason=${result.reason} codes=${codes.join(",")}\n`,
      );
      expect(result.status).toBe("blocked");
      expect(pause.isPaused("wikipedia")).toBe(true);
    }, 120_000);
  }
});

describe("robots.txt against a real local HTTP server (no browser)", () => {
  let srv: Server;
  let base = "";
  let robots: { status: number; body: string } = { status: 200, body: "" };
  beforeAll(async () => {
    srv = createServer((req, res) => {
      if (req.url === "/robots.txt") res.writeHead(robots.status).end(robots.body);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const stubFetch = (url: string) => fetch(url.replace(/^https:\/\/[^/]+/, base));
  const warnings: { site?: string; msg: string }[] = [];
  const capture = pino(
    { level: "info" },
    {
      write: (line: string) => {
        const o = JSON.parse(line) as { site?: string; msg: string };
        warnings.push(o);
      },
    },
  );

  it("a robots.txt that disallows the planned paths: every site skipped, one log line each", async () => {
    robots = { status: 200, body: "User-agent: *\nDisallow: /\n" };
    warnings.length = 0;
    const prepared = await prepareSites({ logger: capture, fetch: stubFetch });
    expect(prepared.size).toBe(0);
    const lines = warnings.filter((w) => /skipped/.test(w.msg));
    expect(lines).toHaveLength(PUBLIC_SITES.length);
    expect(new Set(lines.map((l) => l.site)).size).toBe(PUBLIC_SITES.length);
  });

  it("an unreadable robots.txt (500) skips the site, never visited blind", async () => {
    robots = { status: 500, body: "boom" };
    warnings.length = 0;
    const prepared = await prepareSites({ logger: capture, fetch: stubFetch });
    expect(prepared.size).toBe(0);
    expect(warnings.filter((w) => /skipped/.test(w.msg))).toHaveLength(PUBLIC_SITES.length);
  });

  it("a 404 robots.txt allows everything; a partial Disallow keeps the other paths", async () => {
    robots = { status: 404, body: "" };
    expect((await prepareSites({ logger: capture, fetch: stubFetch })).size).toBe(
      PUBLIC_SITES.length,
    );
    robots = { status: 200, body: "User-agent: *\nDisallow: /wiki/Web_browser\nCrawl-delay: 45\n" };
    const prepared = await prepareSites({ logger: capture, fetch: stubFetch });
    const wiki = prepared.get("wikipedia");
    expect(wiki?.paths).not.toContain("/wiki/Web_browser");
    expect(wiki?.paths.length).toBe(SITES.wikipedia.paths.length - 1);
    expect(wiki?.minDelayMs).toBe(45_000);
  });

  it("a connection refused is unreadable too", async () => {
    const r = await fetchRobots(SITES.mdn, () => Promise.reject(new Error("ECONNREFUSED")));
    expect(r.rules.allows("/en-US/docs/x")).toBe(false);
  });
});
