import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type EventEnvelope,
  type FleetEvent,
  newEvent,
  type SessionStatus,
} from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import {
  conditionalAll,
  createReaderClient,
  createTestDatabase,
  type TestDatabase,
  testPassword,
} from "./testing";

/**
 * The `site-engine-matrix` README snippet (the site by engine grid on the Browsers dashboard), run as
 * the read-only user against a small fleet with hand-worked numbers.
 */

let db: TestDatabase;
let reader: ClickHouseClient;
const user = `fleetscope_grid_test_${randomBytes(4).toString("hex")}`;
const MIN = 60_000;
const T0 = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}.000`;

interface Spec {
  id: string;
  engine: EventEnvelope["engine"];
  target: "demo" | "public";
  site: string;
  status: SessionStatus;
  reason?: string | null;
  startMin: number;
  /** the error_code of one failed action, if any */
  failedWith?: string;
}

const DURATION = 4000;
const SPECS: Spec[] = [
  // wikipedia on chromium: 3 ended (2 success, 1 failed with site_layout), 1 interrupted
  {
    id: "w1",
    engine: "chromium",
    target: "public",
    site: "wikipedia",
    status: "success",
    startMin: 0,
  },
  {
    id: "w2",
    engine: "chromium",
    target: "public",
    site: "wikipedia",
    status: "success",
    startMin: 1,
  },
  {
    id: "w3",
    engine: "chromium",
    target: "public",
    site: "wikipedia",
    status: "failed",
    reason: "landmark missing",
    startMin: 2,
    failedWith: "site_layout",
  },
  {
    id: "w4",
    engine: "chromium",
    target: "public",
    site: "wikipedia",
    status: "failed",
    reason: "interrupted",
    startMin: 9,
    failedWith: "browser_closed",
  },
  // wikipedia on lightpanda: 2 ended, none succeeded; one cause each, so the name breaks the tie
  {
    id: "wl1",
    engine: "lightpanda",
    target: "public",
    site: "wikipedia",
    status: "failed",
    reason: "x",
    startMin: 3,
    failedWith: "unsupported_feature",
  },
  {
    id: "wl2",
    engine: "lightpanda",
    target: "public",
    site: "wikipedia",
    status: "failed",
    reason: "x",
    startMin: 4,
    failedWith: "timeout",
  },
  // mdn on chromium: 1 success. mdn on lightpanda: only an interrupted session, so no row
  { id: "m1", engine: "chromium", target: "public", site: "mdn", status: "success", startMin: 5 },
  {
    id: "ml1",
    engine: "lightpanda",
    target: "public",
    site: "mdn",
    status: "failed",
    reason: "interrupted",
    startMin: 6,
  },
  // the demo site is not in the grid
  {
    id: "d1",
    engine: "chromium",
    target: "demo",
    site: "demo-site",
    status: "success",
    startMin: 7,
  },
  // ended before the range starts (the range below begins 5 min before T0)
  {
    id: "old1",
    engine: "chromium",
    target: "public",
    site: "wikipedia",
    status: "success",
    startMin: -60,
  },
];

function eventsOf(spec: Spec): FleetEvent[] {
  const ctx: EventEnvelope = {
    session_id: spec.id,
    source: "real",
    agent_id: "grid-test",
    engine: spec.engine,
    provider: "local-docker",
  };
  const start = T0 + spec.startMin * MIN;
  const out: FleetEvent[] = [
    newEvent(
      "session.started",
      ctx,
      {
        engine_version: null,
        scenario: "browse",
        region: "local",
        startup_ms: 100,
        connect_ms: 100,
        target: spec.target,
        site: spec.site,
      },
      start,
    ),
  ];
  if (spec.failedWith) {
    out.push(
      newEvent(
        "action",
        ctx,
        {
          seq: 0,
          action_type: "goto",
          target: "x",
          duration_ms: 50,
          ok: false,
          error_code: spec.failedWith,
        },
        start + 1000,
      ),
    );
  }
  out.push(
    newEvent(
      "session.ended",
      ctx,
      { status: spec.status, reason: spec.reason ?? null, duration_ms: DURATION },
      start + DURATION,
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
const q = (values: string[]) => values.map((v) => `'${v}'`).join(",");
const ENGINES = ["chromium", "chrome-headless-shell", "lightpanda"];

type Cell = {
  site: string;
  engine: string;
  sessions: number;
  success_rate: number | null;
  top_cause: string | null;
  last_visit: string;
};

async function grid(
  selected: { target?: string[]; site?: string[] } = {},
  engines = ENGINES,
): Promise<Cell[]> {
  const from = T0 - 5 * MIN;
  const to = Date.now() + MIN;
  const sql = conditionalAll(await snippet("site-engine-matrix"), selected)
    .replace(
      /\$__timeFilter\((\w+)\)/g,
      (_, c) => `${c} >= toDateTime(${sec(from)}) AND ${c} <= toDateTime(${sec(to)})`,
    )
    .replace(/\$__fromTime/g, `toDateTime(${sec(from)})`)
    .replace(/\$__toTime/g, `toDateTime(${sec(to)})`)
    .replace(/\$\{engine:singlequote\}/g, q(engines))
    .replace(/\$\{source:singlequote\}/g, q(["real"]));
  return (await reader.query({ query: sql, format: "JSONEachRow" })).json<Cell>();
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

describe("site-engine-matrix", () => {
  it("has the contract columns, in order", async () => {
    const rows = await grid();
    expect(Object.keys(rows[0] as Cell)).toEqual([
      "site",
      "engine",
      "sessions",
      "success_rate",
      "top_cause",
      "last_visit",
    ]);
  });

  it("has one row per public site and engine that has an ended session, sorted by site then engine", async () => {
    const rows = await grid();
    expect(
      rows.map((r) => [r.site, r.engine, Number(r.sessions), r.success_rate, r.top_cause]),
    ).toEqual([
      // mdn on lightpanda has only an interrupted session: no row. The demo site and old1 are not here.
      ["mdn", "chromium", 1, 100, null],
      // w1, w2 succeeded, w3 failed (site_layout); w4 is interrupted and old1 ended before the range
      ["wikipedia", "chromium", 3, (100 * 2) / 3, "site_layout"],
      // one failure each, a tie: the cause name decides ("timeout" < "unsupported_feature")
      ["wikipedia", "lightpanda", 2, 0, "timeout"],
    ]);
  });

  it("last_visit is the latest ended_at of the pair", async () => {
    const rows = await grid();
    const last = (site: string, engine: string) =>
      rows.find((r) => r.site === site && r.engine === engine)?.last_visit;
    // wikipedia on chromium: w3 started at minute 2 and lasted 4 s (w4 and old1 do not count)
    expect(last("wikipedia", "chromium")).toBe(iso(T0 + 2 * MIN + DURATION));
    // wikipedia on lightpanda: wl2 started at minute 4
    expect(last("wikipedia", "lightpanda")).toBe(iso(T0 + 4 * MIN + DURATION));
    expect(last("mdn", "chromium")).toBe(iso(T0 + 5 * MIN + DURATION));
  });

  it("follows the filters: engine, site and target (the demo site never appears)", async () => {
    expect((await grid({}, ["lightpanda"])).map((r) => [r.site, r.engine])).toEqual([
      ["wikipedia", "lightpanda"],
    ]);
    expect((await grid({ site: ["mdn"] })).map((r) => [r.site, r.engine])).toEqual([
      ["mdn", "chromium"],
    ]);
    expect(await grid({ target: ["demo"] })).toEqual([]);
    expect(await grid({ target: ["public"], site: ["demo-site"] })).toEqual([]);
  });

  it("returns nothing for an engine that has no public session", async () => {
    expect(await grid({}, ["chrome-headless-shell"])).toEqual([]);
  });
});
