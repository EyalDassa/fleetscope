import type { ClickHouseClient } from "./client";

/**
 * The `fleet_minute` rollup is filled by two materialized views (infra/clickhouse/0007), which only
 * see rows inserted after they were created. `backfillRollups` rebuilds the table from the raw
 * tables for everything that was already there. packages/db/README.md explains how to read it.
 *
 * These two SELECTs must stay identical to the ones in the views. A unit test compares them with
 * the migration file, and an integration test checks that the views and the backfill give the same
 * numbers, so they cannot drift apart unnoticed.
 */
export const ROLLUP_ACTIONS_SELECT = `SELECT
    toStartOfMinute(ts) AS minute,
    engine,
    source,
    countState() AS actions,
    countIfState(NOT ok) AS action_errors,
    quantilesState(0.5, 0.95)(duration_ms) AS action_ms
FROM actions
GROUP BY minute, engine, source`;

export const ROLLUP_SAMPLES_SELECT = `SELECT
    toStartOfMinute(ts) AS minute,
    engine,
    source,
    countState() AS samples,
    sumState(toFloat64(assumeNotNull(cpu_pct))) AS cpu_pct_sum,
    sumState(toFloat64(assumeNotNull(mem_mb))) AS mem_mb_sum
FROM resource_samples
WHERE origin = 'container' AND cpu_pct IS NOT NULL AND mem_mb IS NOT NULL
GROUP BY minute, engine, source`;

/**
 * Empties `fleet_minute` and fills it again from `actions` and `resource_samples`. Running it twice
 * gives the same table. Rows that are inserted while it runs are counted twice or not at all (the
 * views and this rebuild both see them), so run it with ingest stopped.
 *
 * Returns how many rollup rows exist afterwards (before ClickHouse merges rows of the same key).
 */
export async function backfillRollups(client: ClickHouseClient): Promise<{ rows: number }> {
  await client.command({ query: "TRUNCATE TABLE fleet_minute" });
  await client.command({
    query: `INSERT INTO fleet_minute (minute, engine, source, actions, action_errors, action_ms)
${ROLLUP_ACTIONS_SELECT}`,
  });
  await client.command({
    query: `INSERT INTO fleet_minute (minute, engine, source, samples, cpu_pct_sum, mem_mb_sum)
${ROLLUP_SAMPLES_SELECT}`,
  });
  const result = await client.query({
    query: "SELECT count() AS rows FROM fleet_minute",
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ rows: string | number }>();
  return { rows: Number(row?.rows ?? 0) };
}
