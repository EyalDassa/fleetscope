import { type EventEnvelope, type FleetEvent, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvents } from "./insert";
import { backfillRollups } from "./rollups";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.cleanup();
});

async function rows<T>(query: string): Promise<T[]> {
  const result = await db.client.query({ query, format: "JSONEachRow" });
  return result.json<T>();
}

/** Everything the dashboards read from the rollup, merged, per minute/engine/source. */
const SNAPSHOT = `
  SELECT
    toString(minute) AS minute, engine, source,
    countMerge(actions) AS actions,
    countMerge(action_errors) AS action_errors,
    quantilesMerge(0.5, 0.95)(action_ms) AS latency,
    countMerge(samples) AS samples,
    sumMerge(cpu_pct_sum) AS cpu_sum,
    sumMerge(mem_mb_sum) AS mem_sum
  FROM fleet_minute
  GROUP BY minute, engine, source
  ORDER BY minute, engine, source`;

// A fixed, minute-aligned start 10 minutes ago, so the events stay inside the 30 day retention.
const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;

const ctx = (
  session_id: string,
  engine: EventEnvelope["engine"],
  source: EventEnvelope["source"] = "real",
): EventEnvelope => ({
  session_id,
  source,
  agent_id: "rollup-test",
  engine,
  provider: "local-docker",
});

const action = (c: EventEnvelope, seq: number, ms: number, ok: boolean, at: number) =>
  newEvent(
    "action",
    c,
    {
      seq,
      action_type: "goto",
      target: "example.com",
      duration_ms: ms,
      ok,
      error_code: ok ? null : "timeout",
    },
    at,
  );

const sample = (c: EventEnvelope, cpu: number, mem: number, at: number) =>
  newEvent(
    "resource.sample",
    c,
    { origin: "container", cpu_pct: cpu, mem_mb: mem, net_rx_bytes: 1, net_tx_bytes: 2 },
    at,
  );

function events(): FleetEvent[] {
  const a = ctx("rollup-a", "chromium");
  const b = ctx("rollup-b", "lightpanda");
  const c = ctx("rollup-c", "chromium", "sim");
  return [
    // minute 0 and minute 1 of chromium/real
    action(a, 0, 100, true, T0 + 1_000),
    action(a, 1, 300, false, T0 + 2_000),
    action(a, 2, 200, true, T0 + 61_000),
    sample(a, 10, 100, T0 + 3_000),
    sample(a, 30, 300, T0 + 5_000),
    sample(a, 50, 500, T0 + 65_000),
    // a cdp sample (JS heap) must not reach the rollup
    newEvent(
      "resource.sample",
      a,
      {
        origin: "cdp",
        cpu_pct: null,
        mem_mb: null,
        net_rx_bytes: null,
        net_tx_bytes: null,
        js_heap_mb: 40,
      },
      T0 + 4_000,
    ),
    // another engine and another source stay in their own rows
    action(b, 0, 50, true, T0 + 1_500),
    sample(b, 5, 20, T0 + 3_500),
    action(c, 0, 999, false, T0 + 1_700),
  ];
}

describe("fleet_minute", () => {
  it("is filled by the materialized views, per minute, engine and source", async () => {
    await insertEvents(db.client, events());
    const snapshot = await rows<{
      minute: string;
      engine: string;
      source: string;
      actions: number;
      action_errors: number;
      latency: number[];
      samples: number;
      cpu_sum: number;
      mem_sum: number;
    }>(SNAPSHOT);

    const find = (engine: string, source: string, offsetMin: number) =>
      snapshot.find(
        (r) =>
          r.engine === engine &&
          r.source === source &&
          r.minute.startsWith(
            new Date(T0 + offsetMin * 60_000).toISOString().slice(0, 16).replace("T", " "),
          ),
      );

    const m0 = find("chromium", "real", 0);
    expect(m0).toMatchObject({
      actions: 2,
      action_errors: 1,
      samples: 2,
      cpu_sum: 40,
      mem_sum: 400,
    });
    expect(m0?.latency).toEqual([200, 290]); // p50 and p95 of [100, 300], interpolated
    const m1 = find("chromium", "real", 1);
    expect(m1).toMatchObject({
      actions: 1,
      action_errors: 0,
      samples: 1,
      cpu_sum: 50,
      mem_sum: 500,
    });

    expect(find("lightpanda", "real", 0)).toMatchObject({
      actions: 1,
      action_errors: 0,
      samples: 1,
      cpu_sum: 5,
      mem_sum: 20,
    });
    expect(find("chromium", "sim", 0)).toMatchObject({
      actions: 1,
      action_errors: 1,
      samples: 0,
      cpu_sum: 0,
      mem_sum: 0,
    });
    expect(snapshot).toHaveLength(4);
  });

  it("gives the same numbers after a backfill from the raw tables, and again after a second one", async () => {
    const before = await rows(SNAPSHOT);
    expect(before.length).toBeGreaterThan(0);

    const first = await backfillRollups(db.client);
    expect(first.rows).toBeGreaterThan(0);
    expect(await rows(SNAPSHOT)).toEqual(before);

    await backfillRollups(db.client);
    expect(await rows(SNAPSHOT)).toEqual(before);
  });

  it("is rebuilt for rows that were inserted before the views existed", async () => {
    // an empty rollup (as on a database where 0007 was applied after the data was written)
    await db.client.command({ query: "TRUNCATE TABLE fleet_minute" });
    expect(await rows(SNAPSHOT)).toEqual([]);
    await backfillRollups(db.client);
    expect((await rows(SNAPSHOT)).length).toBe(4);
  });

  it("merges partial rows: the same minute inserted in two batches reads as one", async () => {
    const d = ctx("rollup-d", "chrome-headless-shell");
    const at = T0 + 5 * 60_000;
    await insertEvents(db.client, [action(d, 0, 100, true, at + 1_000)]);
    await insertEvents(db.client, [action(d, 1, 200, false, at + 2_000)]);
    const [row] = await rows<{ actions: number; errors: number }>(
      `SELECT countMerge(actions) AS actions, countMerge(action_errors) AS errors
       FROM fleet_minute WHERE engine = 'chrome-headless-shell'`,
    );
    expect(row).toEqual({ actions: 2, errors: 1 });
  });
});

describe("pricing", () => {
  it("seeds one row per engine for local-docker at $0.10 per browser-hour", async () => {
    const prices = await rows<{
      engine: string;
      provider: string;
      usd_per_browser_hour: number;
      source_url: string;
      note: string;
      effective_from: string;
    }>("SELECT * FROM pricing ORDER BY engine");
    expect(prices.map((p) => p.engine)).toEqual([
      "chrome-headless-shell",
      "chromium",
      "lightpanda",
    ]);
    for (const price of prices) {
      expect(price).toMatchObject({
        provider: "local-docker",
        usd_per_browser_hour: 0.1,
        source_url: "https://www.browserbase.com/pricing",
      });
      expect(price.note).toContain("reference price");
      expect(price.note).toContain("until M3");
    }
  });

  it("pricing_current has the latest price already in effect, not a future one", async () => {
    await db.client.command({
      query: `INSERT INTO pricing VALUES
        ('chromium', 'other-provider', 0.50, 'https://example.test/old', 'old', today() - 10),
        ('chromium', 'other-provider', 0.60, 'https://example.test/new', 'raised', today() - 1),
        ('chromium', 'other-provider', 9.99, 'https://example.test/future', 'not yet', today() + 30)`,
    });
    const [other] = await rows<{ usd_per_browser_hour: number; note: string }>(
      "SELECT usd_per_browser_hour, note FROM pricing_current WHERE provider = 'other-provider'",
    );
    expect(other).toEqual({ usd_per_browser_hour: 0.6, note: "raised" });
    // the seeded local-docker rows are unchanged, one per engine
    const local = await rows<{ engine: string; usd_per_browser_hour: number }>(
      "SELECT engine, usd_per_browser_hour FROM pricing_current WHERE provider = 'local-docker' ORDER BY engine",
    );
    expect(local).toEqual([
      { engine: "chrome-headless-shell", usd_per_browser_hour: 0.1 },
      { engine: "chromium", usd_per_browser_hour: 0.1 },
      { engine: "lightpanda", usd_per_browser_hour: 0.1 },
    ]);
  });
});
