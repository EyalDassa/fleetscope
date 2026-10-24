import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type EventEnvelope,
  type FleetEvent,
  type IssueKind,
  newEvent,
  type SessionStatus,
} from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createReaderClient, createTestDatabase, type TestDatabase, testPassword } from "./testing";

/**
 * The `engine-comparison` and `compatibility-matrix` README snippets (M3 Browsers dashboard), run as
 * the read-only user against a small fleet with hand-worked numbers.
 */

let db: TestDatabase;
let reader: ClickHouseClient;
const user = `fleetscope_cmp_test_${randomBytes(4).toString("hex")}`;
const MIN = 60_000;
const T0 = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;

interface Spec {
  id: string;
  engine: EventEnvelope["engine"];
  scenario: string;
  status: SessionStatus;
  reason?: string | null;
  provider?: string;
  startMin: number;
  startupMs: number;
  connectMs: number;
  durationMs: number;
  actions?: Array<[number, string | null]>;
  /** container mem_mb samples */
  mem?: number[];
  /** a cdp sample with a JS heap */
  heap?: number;
  /** a cdp sample whose heap is null (the engine cannot say) */
  nullHeap?: boolean;
  issue?: IssueKind;
}

const SPECS: Spec[] = [
  // chromium: 4 ended (3 success), 1 interrupted
  {
    id: "c1",
    engine: "chromium",
    scenario: "login",
    status: "success",
    startMin: 0,
    startupMs: 1000,
    connectMs: 1000,
    durationMs: 10_000,
    actions: [
      [100, null],
      [200, null],
    ],
    mem: [100, 300, 200],
    heap: 12,
  },
  {
    id: "c2",
    engine: "chromium",
    scenario: "login",
    status: "success",
    startMin: 1,
    startupMs: 2000,
    connectMs: 2000,
    durationMs: 10_000,
    actions: [[300, null]],
    mem: [500, 400],
  },
  {
    id: "c3",
    engine: "chromium",
    scenario: "login",
    status: "failed",
    reason: "boom",
    startMin: 2,
    startupMs: 1000,
    connectMs: 500,
    durationMs: 10_000,
    actions: [
      [400, null],
      [500, "timeout"],
    ],
    issue: "timeout",
  },
  {
    id: "c4",
    engine: "chromium",
    scenario: "checkout",
    status: "success",
    startMin: 3,
    startupMs: 1500,
    connectMs: 1500,
    durationMs: 10_000,
    actions: [[100, null]],
    mem: [400],
  },
  {
    id: "c5",
    engine: "chromium",
    scenario: "checkout",
    status: "failed",
    reason: "interrupted",
    startMin: 4,
    startupMs: 1000,
    connectMs: 1000,
    durationMs: 5000,
    actions: [[1000, "browser_closed"]],
    mem: [9999],
  },
  // lightpanda: 4 ended (1 success), no heap
  {
    id: "l1",
    engine: "lightpanda",
    scenario: "checkout",
    status: "failed",
    reason: "x",
    startMin: 0,
    startupMs: 100,
    connectMs: 100,
    durationMs: 4000,
    actions: [[50, "unsupported_feature"]],
    mem: [30, 40],
    nullHeap: true,
  },
  {
    id: "l2",
    engine: "lightpanda",
    scenario: "checkout",
    status: "failed",
    reason: "x",
    startMin: 1,
    startupMs: 100,
    connectMs: 100,
    durationMs: 4000,
    actions: [[60, "unsupported_feature"]],
    mem: [20],
    nullHeap: true,
  },
  {
    id: "l3",
    engine: "lightpanda",
    scenario: "checkout",
    status: "failed",
    reason: "x",
    startMin: 2,
    startupMs: 100,
    connectMs: 100,
    durationMs: 4000,
    actions: [[70, null]],
    mem: [50],
    issue: "unsupported_api",
  },
  {
    id: "l4",
    engine: "lightpanda",
    scenario: "login",
    status: "success",
    startMin: 3,
    startupMs: 100,
    connectMs: 100,
    durationMs: 4000,
    actions: [[80, null]],
    mem: [10],
    nullHeap: true,
  },
  // headless-shell: one session whose provider has no price, no samples, no actions
  {
    id: "h1",
    engine: "chrome-headless-shell",
    scenario: "login",
    status: "success",
    provider: "mystery",
    startMin: 5,
    startupMs: 700,
    connectMs: 300,
    durationMs: 3000,
  },
];

function eventsOf(spec: Spec): FleetEvent[] {
  const ctx: EventEnvelope = {
    session_id: spec.id,
    source: "real",
    agent_id: "cmp-test",
    engine: spec.engine,
    provider: spec.provider ?? "local-docker",
  };
  const start = T0 + spec.startMin * MIN;
  const out: FleetEvent[] = [
    newEvent(
      "session.started",
      ctx,
      {
        engine_version: null,
        scenario: spec.scenario,
        region: "local",
        startup_ms: spec.startupMs,
        connect_ms: spec.connectMs,
      },
      start,
    ),
  ];
  (spec.actions ?? []).forEach(([ms, code], seq) => {
    out.push(
      newEvent(
        "action",
        ctx,
        {
          seq,
          action_type: "goto",
          target: "x",
          duration_ms: ms,
          ok: code === null,
          error_code: code,
        },
        start + 1000 + seq * 100,
      ),
    );
  });
  (spec.mem ?? []).forEach((mem, i) => {
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        { origin: "container", cpu_pct: 5, mem_mb: mem, net_rx_bytes: 1, net_tx_bytes: 1 },
        start + 2000 + i * 2000,
      ),
    );
  });
  if (spec.heap !== undefined || spec.nullHeap) {
    out.push(
      newEvent(
        "resource.sample",
        ctx,
        {
          origin: "cdp",
          cpu_pct: null,
          mem_mb: null,
          net_rx_bytes: null,
          net_tx_bytes: null,
          js_heap_mb: spec.heap ?? null,
        },
        start + 3000,
      ),
    );
  }
  if (spec.issue) {
    out.push(newEvent("issue", ctx, { kind: spec.issue, message: "seen" }, start + 5000));
  }
  out.push(
    newEvent(
      "session.ended",
      ctx,
      { status: spec.status, reason: spec.reason ?? null, duration_ms: spec.durationMs },
      start + spec.durationMs,
    ),
  );
  return out;
}

async function snippet(name: string): Promise<string> {
  const readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const get = (n: string) =>
    new RegExp(`\`\`\`sql name=${n}\\n([\\s\\S]*?)\\n\`\`\``).exec(readme)?.[1] as string;
  return get(name).replace("/* session-facts */", get("session-facts"));
}

const sec = (ms: number) => Math.floor(ms / 1000);
function expand(sql: string, engines: string[], from: number, to: number): string {
  const q = (v: string[]) => v.map((x) => `'${x}'`).join(",");
  return sql
    .replace(
      /\$__timeFilter\((\w+)\)/g,
      (_, c) => `${c} >= toDateTime(${sec(from)}) AND ${c} <= toDateTime(${sec(to)})`,
    )
    .replace(/\$__fromTime/g, `toDateTime(${sec(from)})`)
    .replace(/\$__toTime/g, `toDateTime(${sec(to)})`)
    .replace(/\$\{engine:singlequote\}/g, q(engines))
    .replace(/\$\{source:singlequote\}/g, q(["real"]));
}

const ALL = ["chromium", "chrome-headless-shell", "lightpanda"];
async function run<T>(
  name: string,
  engines = ALL,
  from = T0 - 5 * MIN,
  to = Date.now() + MIN,
): Promise<T[]> {
  const query = expand(await snippet(name), engines, from, to);
  return (await reader.query({ query, format: "JSONEachRow" })).json<T>();
}

beforeAll(async () => {
  db = await createTestDatabase();
  await insertEvents(db.client, SPECS.flatMap(eventsOf));
  const password = testPassword();
  await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
  reader = createReaderClient(db.config, user, password);
});

afterAll(async () => {
  await reader.close();
  await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

type Cmp = {
  engine: string;
  sessions: number;
  success_rate: number;
  time_to_browser_p50_ms: number;
  time_to_browser_p95_ms: number;
  peak_mem_mib_p50: number | null;
  action_p95_ms: number | null;
  cost_per_1k_sessions_usd: number | null;
  js_heap_available: number;
};

describe("engine-comparison", () => {
  const rowOf = async (engine: string) =>
    (await run<Cmp>("engine-comparison")).find((r) => r.engine === engine) as Cmp;

  it("gives one row per engine, interrupted sessions left out", async () => {
    const rows = await run<Cmp>("engine-comparison");
    expect(rows.map((r) => [r.engine, Number(r.sessions)])).toEqual([
      ["chrome-headless-shell", 1],
      ["chromium", 4], // c5 is interrupted
      ["lightpanda", 4],
    ]);
  });

  it("chromium: success rate, time to browser, peak memory, action p95, cost, heap", async () => {
    const c = await rowOf("chromium");
    expect(c.success_rate).toBe(75);
    // time to browser: c1 2000, c2 4000, c3 1500, c4 3000 -> sorted 1500 2000 3000 4000
    expect(c.time_to_browser_p50_ms).toBeCloseTo(2500, 5);
    expect(c.time_to_browser_p95_ms).toBeCloseTo(3850, 5);
    // peak per session c1 300, c2 500, c4 400 (c3 has no samples; c5 is interrupted, its 9999 stays out)
    expect(c.peak_mem_mib_p50).toBe(400);
    // every chromium action in the rollup, the interrupted session's included:
    // 100 100 200 300 400 500 1000 -> p95 = 500 + 0.7 * 500
    expect(c.action_p95_ms).toBeCloseTo(850, 5);
    // (startup + connect + duration) of the four sessions, at $0.10 per browser-hour
    const ms = 12_000 + 14_000 + 11_500 + 13_000;
    expect(c.cost_per_1k_sessions_usd).toBeCloseTo((((ms / 3.6e6) * 0.1) / 4) * 1000, 9);
    expect(c.js_heap_available).toBe(1);
  });

  it("lightpanda: 25% success, median of the per-session peaks, no JS heap (a null cdp heap is not a heap)", async () => {
    const l = await rowOf("lightpanda");
    expect(l.success_rate).toBe(25);
    expect(l.peak_mem_mib_p50).toBeCloseTo(30, 5); // peaks 40 20 50 10 -> 10 20 40 50
    expect(l.js_heap_available).toBe(0);
  });

  it("is NULL, not 0, where there is no data: no samples, no actions, an unpriced session", async () => {
    const h = await rowOf("chrome-headless-shell");
    expect(h.peak_mem_mib_p50).toBeNull();
    expect(h.action_p95_ms).toBeNull();
    expect(h.cost_per_1k_sessions_usd).toBeNull(); // provider "mystery" has no price
    expect(h.js_heap_available).toBe(0);
    expect(h.success_rate).toBe(100);
    expect(h.time_to_browser_p50_ms).toBe(1000);
  });

  it("filters by engine and returns nothing for a range in which nothing ended", async () => {
    expect((await run<Cmp>("engine-comparison", ["lightpanda"])).map((r) => r.engine)).toEqual([
      "lightpanda",
    ]);
    expect(await run("engine-comparison", ALL, T0 - 600 * MIN, T0 - 500 * MIN)).toEqual([]);
  });
});

describe("compatibility-matrix", () => {
  type Cell = {
    scenario: string;
    engine: string;
    sessions: number;
    success_rate: number;
    top_cause: string | null;
  };

  it("has one cell per scenario and engine, with the most frequent cause (ties by name)", async () => {
    const cells = await run<Cell>("compatibility-matrix");
    expect(
      cells.map((c) => [c.scenario, c.engine, Number(c.sessions), c.success_rate, c.top_cause]),
    ).toEqual([
      // c4 succeeded; the interrupted c5 is not counted
      ["checkout", "chromium", 1, 100, null],
      // l1, l2: unsupported_feature (action); l3: unsupported_api (its issue beats its action)
      ["checkout", "lightpanda", 3, 0, "unsupported_feature"],
      ["login", "chrome-headless-shell", 1, 100, null],
      // c3's issue wins over its failed action: both are "timeout" here
      ["login", "chromium", 3, (100 * 2) / 3, "timeout"],
      ["login", "lightpanda", 1, 100, null],
    ]);
  });
});
