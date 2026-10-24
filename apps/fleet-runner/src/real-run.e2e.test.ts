import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCollector } from "@fleetscope/collector";
import type { FleetEvent } from "@fleetscope/schema";
import Docker from "dockerode";
import { pino } from "pino";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerFleet } from "./docker";

/**
 * QA, M1: a REAL run, checked in ClickHouse. Opt-in, because it starts Docker containers and
 * writes to your dev database:
 *
 *   pnpm infra:up && pnpm db:migrate && pnpm browsers:build
 *   pnpm --filter @fleetscope/api dev          # :4000
 *   pnpm --filter @fleetscope/demo-site dev    # :3100
 *   FLEET_E2E=1 pnpm --filter @fleetscope/fleet-runner exec vitest run src/real-run.e2e.test.ts
 *
 * (turbo does not pass FLEET_E2E on, so run vitest directly as above.) Everything it writes
 * carries an agent_id that starts with "qa-e2e-".
 */
const ENABLED = process.env.FLEET_E2E === "1";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // no .env: use the real environment
}

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const IMAGE = process.env.FLEET_BROWSER_IMAGE ?? "fleetscope/playwright-chromium:1.64.1";
const SITE = process.env.DEMO_SITE_BROWSER_URL ?? "http://localhost:3100";

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const url = new URL(process.env.CLICKHOUSE_URL ?? "http://localhost:8123");
  url.searchParams.set("database", process.env.CLICKHOUSE_DATABASE ?? "fleetscope");
  url.searchParams.set("default_format", "JSONEachRow");
  const auth = Buffer.from(
    `${process.env.CLICKHOUSE_USER ?? ""}:${process.env.CLICKHOUSE_PASSWORD ?? ""}`,
  ).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    body: query,
    headers: { authorization: `Basic ${auth}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse: ${text.slice(0, 300)}`);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function runFleet(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "run", ...args],
      { cwd: packageDir, env: { ...process.env, LOG_LEVEL: "warn" }, timeout: 280_000 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

const stamp = Date.now();
const agentA = `qa-e2e-a-${stamp}`;
const agentB = `qa-e2e-b-${stamp}`;
const SESSIONS = 9;

interface SessionRow {
  session_id: string;
  scenario: string;
  status: string;
  reason: string | null;
  source: string;
  engine: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

async function waitForSessions(agent: string, expected: number): Promise<SessionRow[]> {
  for (let i = 0; i < 60; i++) {
    const rows = await sql<SessionRow>(
      `SELECT session_id, scenario, status, reason, source, engine, toString(started_at) AS started_at,
              if(ended_at IS NULL, NULL, toString(ended_at)) AS ended_at, duration_ms
       FROM sessions FINAL WHERE agent_id = '${agent}' ORDER BY started_at`,
    );
    if (rows.length >= expected && rows.every((r) => r.status !== "running")) return rows;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return sql<SessionRow>(
    `SELECT session_id, scenario, status, reason, source, engine, toString(started_at) AS started_at,
            if(ended_at IS NULL, NULL, toString(ended_at)) AS ended_at, duration_ms
     FROM sessions FINAL WHERE agent_id = '${agent}' ORDER BY started_at`,
  );
}

describe.skipIf(!ENABLED)("a real run of 9 sessions (seed 7)", () => {
  let runA: { code: number; stdout: string; stderr: string };
  let sessions: SessionRow[] = [];

  beforeAll(async () => {
    runA = await runFleet([
      "--engines",
      "chromium",
      "--sessions",
      String(SESSIONS),
      "--concurrency",
      "3",
      "--scenario",
      "mix",
      "--seed",
      "7",
      "--agent",
      agentA,
    ]);
    sessions = await waitForSessions(agentA, SESSIONS);
  }, 300_000);

  afterAll(async () => {
    const left = await new Docker().listContainers({
      all: true,
      filters: { label: ["fleetscope.session"] },
    });
    expect(left.map((c) => c.Names)).toEqual([]); // no containers left behind
  });

  it("exits 0, delivers every event, and prints a summary", () => {
    expect(runA.code, runA.stderr).toBe(0);
    expect(runA.stdout).toMatch(/9 sessions in/);
    expect(runA.stdout).toMatch(/events: \d+ sent, 0 duplicates, 0 dropped/);
  });

  it("stores every session as real/chromium, with an end status, an end time and a duration", () => {
    expect(sessions).toHaveLength(SESSIONS);
    for (const s of sessions) {
      expect(s.source).toBe("real");
      expect(s.engine).toBe("chromium");
      expect(["success", "failed", "blocked", "timeout", "crashed"]).toContain(s.status);
      expect(s.ended_at).not.toBeNull();
      expect(s.duration_ms).toBeGreaterThan(0);
    }
  });

  it("session.ended is the last event of every session, and nothing is older than session.started", async () => {
    const rows = await sql<{ session_id: string; first_ts: string; last_ts: string }>(
      `SELECT session_id, toString(min(ts)) first_ts, toString(max(ts)) last_ts FROM (
         SELECT session_id, ts FROM actions WHERE agent_id = '${agentA}'
         UNION ALL SELECT session_id, ts FROM resource_samples WHERE agent_id = '${agentA}'
         UNION ALL SELECT session_id, ts FROM network_requests WHERE agent_id = '${agentA}'
         UNION ALL SELECT session_id, ts FROM issues WHERE agent_id = '${agentA}'
       ) GROUP BY session_id`,
    );
    expect(rows).toHaveLength(SESSIONS);
    for (const row of rows) {
      const s = sessions.find((x) => x.session_id === row.session_id);
      expect(s, row.session_id).toBeDefined();
      expect(row.first_ts >= (s?.started_at ?? "")).toBe(true);
      expect(row.last_ts <= (s?.ended_at ?? "")).toBe(true);
    }
  });

  it("every session has container samples (roughly every 2 s) and CDP heap samples, with the right NULLs", async () => {
    const rows = await sql<{
      session_id: string;
      containers: string;
      cdps: string;
      bad_container: string;
      bad_cdp: string;
      min_gap_ms: string;
    }>(
      `SELECT session_id,
         countIf(origin = 'container') containers, countIf(origin = 'cdp') cdps,
         countIf(origin = 'container' AND (cpu_pct IS NULL OR mem_mb IS NULL OR net_rx_bytes IS NULL
                 OR net_tx_bytes IS NULL OR js_heap_mb IS NOT NULL)) bad_container,
         countIf(origin = 'cdp' AND (cpu_pct IS NOT NULL OR mem_mb IS NOT NULL
                 OR net_rx_bytes IS NOT NULL OR net_tx_bytes IS NOT NULL OR js_heap_mb IS NULL)) bad_cdp,
         0 min_gap_ms
       FROM resource_samples WHERE agent_id = '${agentA}' GROUP BY session_id`,
    );
    expect(rows).toHaveLength(SESSIONS);
    for (const row of rows) {
      expect(
        Number(row.containers),
        `container samples of ${row.session_id}`,
      ).toBeGreaterThanOrEqual(1);
      expect(Number(row.cdps)).toBeGreaterThanOrEqual(2);
      expect(Number(row.bad_container)).toBe(0);
      expect(Number(row.bad_cdp)).toBe(0);
    }
    const gaps = await sql<{ gap: string }>(
      `SELECT dateDiff('millisecond', prev, ts) AS gap FROM (
         SELECT ts, lagInFrame(ts) OVER (PARTITION BY session_id ORDER BY ts) AS prev
         FROM resource_samples WHERE agent_id = '${agentA}' AND origin = 'container'
       ) WHERE prev > toDateTime64('2000-01-01 00:00:00', 3)`,
    );
    // Docker's stream sends a frame every second; a sample is taken from every second frame, and the
    // last one of a session from the newest frame, so that gap can be as short as one frame.
    expect(gaps.length).toBeGreaterThan(0);
    for (const { gap } of gaps) {
      expect(Number(gap)).toBeGreaterThan(500);
      expect(Number(gap)).toBeLessThan(3500);
    }
  });

  it("container numbers are plausible", async () => {
    const [row] = await sql<Record<string, string>>(
      `SELECT min(cpu_pct) cpu_min, max(cpu_pct) cpu_max, min(mem_mb) mem_min, max(mem_mb) mem_max,
              min(net_rx_bytes) rx_min, max(js_heap_mb) heap_max
       FROM resource_samples WHERE agent_id = '${agentA}'`,
    );
    expect(Number(row?.cpu_min)).toBeGreaterThanOrEqual(0);
    expect(Number(row?.cpu_max)).toBeLessThan(3200); // 32 cores
    expect(Number(row?.mem_min)).toBeGreaterThan(50); // a Chromium container is not 50 MB
    expect(Number(row?.mem_max)).toBeLessThan(4096);
    expect(Number(row?.rx_min)).toBeGreaterThanOrEqual(0);
    expect(Number(row?.heap_max)).toBeGreaterThan(0);
    expect(Number(row?.heap_max)).toBeLessThan(1024);
  });

  it("a session that ran its scenario has at least 5 actions; a blocked one stops at the wall (1 action)", async () => {
    const rows = await sql<{ session_id: string; n: string }>(
      `SELECT session_id, count() n FROM actions WHERE agent_id = '${agentA}' GROUP BY session_id`,
    );
    const actions = new Map(rows.map((r) => [r.session_id, Number(r.n)]));
    for (const s of sessions) {
      const n = actions.get(s.session_id) ?? 0;
      if (s.status === "blocked") expect(n).toBeGreaterThanOrEqual(1);
      else expect(n, `${s.scenario} ${s.status}`).toBeGreaterThanOrEqual(5);
    }
  });

  // QA-M1-06, decided by the lead: "why did session X fail" is answered by `sessions.reason` plus
  // the `error_code` of the session's FIRST failed action (PLAN section 5), not by the issues table:
  // `selector_not_found` is deliberately not an issue kind. This is that rule, as a test.
  it("QA-M1-06: every session that did not succeed has a reason, and its first failed action has an error code", async () => {
    const notOk = sessions.filter((s) => s.status !== "success");
    expect(notOk.length).toBeGreaterThan(0); // seed 7 has a flaky failure and a captcha
    const causes = new Set<string>();
    for (const s of notOk) {
      expect(s.reason?.trim(), s.session_id).toBeTruthy();
      const failed = await sql<{ error_code: string | null; seq: number }>(
        `SELECT error_code, seq FROM actions WHERE session_id = '${s.session_id}' AND ok = 0 ORDER BY ts, seq`,
      );
      expect(failed.length, `${s.session_id}: ${s.reason}`).toBeGreaterThan(0);
      expect(failed[0]?.error_code, s.session_id).toBeTruthy();
      causes.add(`${s.status}:${failed[0]?.error_code}`);
    }
    // the two seeded failures of seed 7 name their cause
    expect([...causes].sort()).toEqual(["blocked:captcha", "failed:selector_not_found"]);
  });

  it("blocked sessions have a blocked or captcha issue, and no event id appears twice", async () => {
    for (const s of sessions.filter((x) => x.status === "blocked")) {
      const issues = await sql<{ kind: string }>(
        `SELECT kind FROM issues WHERE session_id = '${s.session_id}'`,
      );
      expect(issues.map((i) => i.kind).some((k) => k === "blocked" || k === "captcha")).toBe(true);
    }
    const [ids] = await sql<{ total: string; uniq: string }>(
      `SELECT count() total, uniqExact(event_id) uniq FROM (
         SELECT event_id FROM actions WHERE agent_id = '${agentA}'
         UNION ALL SELECT event_id FROM resource_samples WHERE agent_id = '${agentA}'
         UNION ALL SELECT event_id FROM network_requests WHERE agent_id = '${agentA}'
         UNION ALL SELECT event_id FROM issues WHERE agent_id = '${agentA}')`,
    );
    expect(ids?.total).toBe(ids?.uniq);
  });

  it("the same --seed gives the same scenarios and the same outcomes, whatever the concurrency", async () => {
    const runB = await runFleet([
      "--engines",
      "chromium",
      "--sessions",
      String(SESSIONS),
      "--concurrency",
      "5",
      "--scenario",
      "mix",
      "--seed",
      "7",
      "--agent",
      agentB,
    ]);
    expect(runB.code, runB.stderr).toBe(0);
    const second = await waitForSessions(agentB, SESSIONS);
    const key = (s: SessionRow) => `${s.scenario}|${s.status}|${(s.reason ?? "").slice(0, 50)}`;
    expect(second.map(key).sort()).toEqual(sessions.map(key).sort());
  }, 300_000);
});

describe.skipIf(!ENABLED)("QA-M1-05: container samples at high concurrency", () => {
  // Before the streaming sampler, 11 of 24 sessions had no container sample at --concurrency 12
  // (Docker's pull API took 3 to 10 s per reading with 12 containers running).
  it("24 short sessions at --concurrency 12: every one has a container sample", async () => {
    const agent = `qa-e2e-c12-${stamp}`;
    const run = await runFleet([
      "--engines",
      "chromium",
      "--sessions",
      "24",
      "--concurrency",
      "12",
      "--scenario",
      "login-and-search",
      "--seed",
      "3",
      "--agent",
      agent,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const rows = await waitForSessions(agent, 24);
    expect(rows).toHaveLength(24);
    const counts = await sql<{ session_id: string; n: string }>(
      `SELECT session_id, countIf(origin = 'container') n FROM resource_samples
       WHERE agent_id = '${agent}' GROUP BY session_id`,
    );
    const without = rows.filter(
      (r) => Number(counts.find((c) => c.session_id === r.session_id)?.n ?? 0) === 0,
    );
    expect(without.map((r) => r.session_id)).toEqual([]);
  }, 280_000);
});

/**
 * Ctrl+C, driven through the handlers the CLI registers (`process.emit("SIGINT")` inside the real
 * CLI process, with real containers). A real keypress through pnpm and PowerShell was checked by
 * hand: see qa/m1-report.md. The OS delivery of the signal is Node's job; what the runner does with
 * it is tested here.
 */
function runWithSignals(
  signalsAtMs: number[],
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const code = `
    process.argv = [process.argv[0], "cli.ts", "run", ...JSON.parse(process.env.QA_ARGS)];
    for (const at of JSON.parse(process.env.QA_SIGNALS)) setTimeout(() => process.emit("SIGINT", "SIGINT"), at);
    await import(process.env.QA_CLI);
  `;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          LOG_LEVEL: "warn",
          QA_ARGS: JSON.stringify(args),
          QA_SIGNALS: JSON.stringify(signalsAtMs),
          QA_CLI: pathToFileURL(join(packageDir, "src", "cli.ts")).href,
        },
        timeout: 120_000,
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe.skipIf(!ENABLED)("Ctrl+C", () => {
  const baseArgs = (agent: string) => [
    "--engines",
    "chromium",
    "--sessions",
    "20",
    "--concurrency",
    "4",
    "--scenario",
    "heavy-page-crawl",
    "--seed",
    "5",
    "--agent",
    agent,
  ];

  async function expectTidy(agent: string) {
    const rows = await sql<{ status: string; reason: string | null }>(
      `SELECT status, reason FROM sessions FINAL WHERE agent_id = '${agent}'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.status === "running")).toEqual([]); // none left running
    for (const r of rows.filter((x) => x.status !== "success")) {
      expect(r.status).toBe("failed");
      expect(r.reason).toBe("interrupted");
    }
    const crashes = await sql(
      `SELECT kind FROM issues WHERE agent_id = '${agent}' AND kind = 'crash'`,
    );
    expect(crashes).toEqual([]); // QA-M1-08 for Ctrl+C: we closed the browser, nothing crashed
    const left = await new Docker().listContainers({
      all: true,
      filters: { label: ["fleetscope.session"] },
    });
    expect(left).toEqual([]);
  }

  it("one Ctrl+C: running sessions end failed/interrupted, the summary is printed, nothing is left, exit 130", async () => {
    const agent = `qa-e2e-ctrlc1-${stamp}`;
    const run = await runWithSignals([13_000], baseArgs(agent));
    expect(run.code).toBe(130);
    expect(run.stdout).toContain("not started (interrupted)");
    await waitForSessions(agent, 1);
    await expectTidy(agent);
  }, 120_000);

  it("one keypress delivered twice (two signals 150 ms apart) is still ONE interrupt: no 'second interrupt', graceful cleanup", async () => {
    const agent = `qa-e2e-ctrlc2-${stamp}`;
    const run = await runWithSignals([13_000, 13_150], baseArgs(agent));
    expect(run.code).toBe(130);
    expect(run.stderr + run.stdout).not.toContain("second interrupt");
    expect(run.stdout).toContain("not started (interrupted)");
    await waitForSessions(agent, 1);
    await expectTidy(agent);
  }, 120_000);

  it("a deliberate second Ctrl+C (2.5 s later) takes the exit-now path: exit 130, nothing left, nothing stays running", async () => {
    const agent = `qa-e2e-ctrlc3-${stamp}`;
    const run = await runWithSignals([13_000, 15_500], baseArgs(agent));
    expect(run.code).toBe(130);
    expect(run.stderr + run.stdout).toContain("second interrupt");
    await waitForSessions(agent, 1);
    await expectTidy(agent);
  }, 120_000);
});

describe.skipIf(!ENABLED)("sessions the runner cuts off itself", () => {
  // QA-M1-08 (verified in the re-test): when the runner closed the browser because of
  // --session-timeout (or Ctrl+C), the action in progress failed with browser_closed and the
  // collector raised a `crash` issue, so a `timeout` session also said "the browser crashed".
  // The cut-off action keeps its code; the false crash issue is gone.
  it("QA-M1-08: a runner-initiated timeout does not raise a crash issue", async () => {
    const agent = `qa-e2e-timeout-${stamp}`;
    const run = await runFleet([
      "--engines",
      "chromium",
      "--sessions",
      "2",
      "--concurrency",
      "2",
      "--scenario",
      "heavy-page-crawl",
      "--session-timeout",
      "2",
      "--seed",
      "9",
      "--agent",
      agent,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const rows = await waitForSessions(agent, 2);
    expect(rows.map((r) => r.status)).toEqual(["timeout", "timeout"]);
    for (const r of rows) expect(r.reason).toBe("session exceeded 2s");
    const actions = await sql<{ error_code: string }>(
      `SELECT error_code FROM actions WHERE agent_id = '${agent}' AND ok = 0`,
    );
    expect(actions.map((a) => a.error_code)).toEqual(["browser_closed", "browser_closed"]);

    const issues = await sql<{ kind: string }>(
      `SELECT kind FROM issues WHERE agent_id = '${agent}'`,
    );
    // A crash issue would be a false statement: nothing crashed, the runner closed the browser.
    expect(issues.filter((i) => i.kind === "crash").length).toBe(0);
  }, 120_000);
});

describe.skipIf(!ENABLED)("the collector with a real Chromium", () => {
  const logger = pino({ level: "silent" });
  const fleet = new DockerFleet(IMAGE, "chromium", logger);
  let container: Awaited<ReturnType<DockerFleet["startBrowser"]>> | undefined;

  afterAll(async () => {
    await container?.remove();
  });

  async function record(
    body: (helpers: {
      page: import("@fleetscope/collector").CollectedPage;
      raw: import("playwright-core").Page;
      counts: { requests: number };
    }) => Promise<void>,
    prepare?: (page: import("playwright-core").Page) => Promise<void>,
  ): Promise<FleetEvent[]> {
    container ??= await fleet.startBrowser({ sessionId: "qa-e2e-collector" });
    const browser = await chromium.connect(container.endpoint);
    const events: FleetEvent[] = [];
    const collector = createCollector({
      apiUrl: "http://127.0.0.1:1",
      source: "real",
      agentId: "qa-e2e-collector",
      provider: "local-docker",
      engine: "chromium",
      logger,
      flushIntervalMs: 20,
      heapSampleIntervalMs: 300,
      transport: {
        async send(batch) {
          events.push(...batch);
          return { status: "accepted", accepted: batch.length, duplicates: 0 };
        },
      },
    });
    const session = collector.startSession({
      scenario: "qa",
      region: "local",
      engineVersion: browser.version(),
      startupMs: 1,
      connectMs: 1,
    });
    const context = await browser.newContext();
    const raw = await context.newPage();
    if (prepare) await prepare(raw);
    const counts = { requests: 0 };
    raw.on("requestfinished", (r) => /^https?:/.test(r.url()) && counts.requests++);
    raw.on("requestfailed", (r) => /^https?:/.test(r.url()) && counts.requests++);
    const page = await session.collectPage(raw);
    try {
      await body({ page, raw, counts });
    } finally {
      await session.endSession("success");
      await collector.close();
      await browser.close();
    }
    return events;
  }

  it("records one network.request in five, starting with the first, with status and size", async () => {
    let total = 0;
    const events = await record(async ({ page, raw, counts }) => {
      await page.goto(`${SITE}/heavy?nodes=200&images=100`);
      await raw.waitForLoadState("networkidle");
      await page.wait(300);
      total = counts.requests;
    });
    const sampled = events.filter((e) => e.type === "network.request");
    expect(total).toBeGreaterThanOrEqual(100);
    expect(sampled.length).toBe(Math.ceil(total / 5));
    for (const e of sampled) {
      if (e.type !== "network.request") continue;
      expect(e.domain).toBe("localhost");
      expect(e.status).toBe(200);
      expect(e.bytes).toBeGreaterThan(0);
    }
    expect(
      new Set(sampled.map((e) => (e.type === "network.request" ? e.resource_type : ""))),
    ).toContain("image");
  }, 60_000);

  it("takes JS heap samples through CDP, real numbers in MB", async () => {
    const events = await record(async ({ page }) => {
      await page.goto(`${SITE}/heavy?nodes=5000&images=0`);
      await page.wait(1000);
    });
    const cdp = events.filter((e) => e.type === "resource.sample" && e.origin === "cdp");
    expect(cdp.length).toBeGreaterThanOrEqual(3);
    for (const e of cdp) {
      if (e.type !== "resource.sample") continue;
      expect(e.js_heap_mb).toBeGreaterThan(0.1); // about:blank is already ~0.5 MB
      expect(e.js_heap_mb).toBeLessThan(500);
      expect(e.cpu_pct).toBeNull();
      expect(e.mem_mb).toBeNull();
    }
  }, 60_000);

  it("turns a missing browser API on /js-heavy into an unsupported_api issue (once per API)", async () => {
    const events = await record(
      async ({ page }) => {
        await page.goto(`${SITE}/js-heavy`);
        await page.wait('[data-testid="js-result"][data-status="done"]', { timeoutMs: 15_000 });
      },
      async (raw) => {
        await raw.addInitScript(() => {
          // @ts-expect-error removing a global on purpose
          delete window.IntersectionObserver;
          // @ts-expect-error removing a global on purpose
          delete window.ResizeObserver;
        });
      },
    );
    const issues = events.filter((e) => e.type === "issue");
    const messages = issues.map((e) => (e.type === "issue" ? `${e.kind}: ${e.message}` : ""));
    expect(messages).toContain(
      "unsupported_api: ReferenceError: IntersectionObserver is not defined",
    );
    expect(messages).toContain("unsupported_api: ReferenceError: ResizeObserver is not defined");
    expect(issues).toHaveLength(2);
  }, 60_000);

  it.fails("QA-M1-03: a missing crypto.subtle on /js-heavy is an unsupported_api issue too", async () => {
    const events = await record(
      async ({ page }) => {
        await page.goto(`${SITE}/js-heavy`);
        await page.wait('[data-testid="js-result"][data-status="done"]', { timeoutMs: 15_000 });
      },
      async (raw) => {
        await raw.addInitScript(() => {
          Object.defineProperty(crypto, "subtle", { value: undefined });
        });
      },
    );
    expect(events.filter((e) => e.type === "issue" && e.kind === "unsupported_api")).toHaveLength(
      1,
    );
  }, 60_000);
});
