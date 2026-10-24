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
 * Rebuilds `fleet_minute` from `actions` and `resource_samples` for everything the raw tables still
 * hold, and leaves older rollup rows alone. Running it twice gives the same table.
 *
 * The raw tables keep 30 days and the rollup keeps a year, so wiping the whole rollup (an earlier
 * version did) would erase eleven months of history that cannot be rebuilt. Instead the oldest minute
 * in the raw tables is the start of the rebuild: rollup rows from that minute on are deleted and
 * written again from the raw rows, older ones stay. When the raw tables are empty there is nothing
 * to rebuild from, and the rollup is not touched at all.
 *
 * Rows that are inserted while it runs are counted twice or not at all (the views and this rebuild
 * both see them), so run it with ingest stopped.
 *
 * Both inserts send `deduplicate_insert = 'disable'`. A shared or replicated table (ClickHouse Cloud)
 * remembers the hashes of the blocks it has inserted and skips an identical block, which would turn
 * a second run into a no-op after the delete. A local table did not do this when we tried (with a
 * deduplication window set on it), so this is a defence that cannot be shown to matter locally.
 *
 * Returns the minute the rebuild started at (`null` when the raw tables are empty) and how many rollup
 * rows exist afterwards (before ClickHouse merges rows of the same key).
 */
export async function backfillRollups(
  client: ClickHouseClient,
): Promise<{ rows: number; from: Date | null }> {
  const oldest = await client.query({
    query: `SELECT toUnixTimestamp(minOrNull(oldest)) AS from_s
            FROM
            (
                SELECT minOrNull(toStartOfMinute(ts)) AS oldest FROM actions
                UNION ALL
                SELECT minOrNull(toStartOfMinute(ts)) AS oldest FROM resource_samples
            )`,
    format: "JSONEachRow",
  });
  const [oldestRow] = await oldest.json<{ from_s: string | number | null }>();
  const fromSeconds = oldestRow?.from_s == null ? null : Number(oldestRow.from_s);

  if (fromSeconds !== null) {
    // A mutation, waited for on every replica (mutations_sync = 2), so the inserts below land after it.
    await client.command({
      query: "ALTER TABLE fleet_minute DELETE WHERE minute >= toDateTime({from:UInt32}, 'UTC')",
      query_params: { from: fromSeconds },
      clickhouse_settings: { mutations_sync: "2" },
    });
    const noDedup = { deduplicate_insert: "disable" } as const;
    await client.command({
      query: `INSERT INTO fleet_minute (minute, engine, source, actions, action_errors, action_ms)
${ROLLUP_ACTIONS_SELECT}`,
      clickhouse_settings: noDedup,
    });
    await client.command({
      query: `INSERT INTO fleet_minute (minute, engine, source, samples, cpu_pct_sum, mem_mb_sum)
${ROLLUP_SAMPLES_SELECT}`,
      clickhouse_settings: noDedup,
    });
  }

  const result = await client.query({
    query: "SELECT count() AS rows FROM fleet_minute",
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ rows: string | number }>();
  return {
    rows: Number(row?.rows ?? 0),
    from: fromSeconds === null ? null : new Date(fromSeconds * 1000),
  };
}
