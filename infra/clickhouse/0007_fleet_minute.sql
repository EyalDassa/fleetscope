-- Per-minute rollup for the dashboards (PLAN.md section 6, docs/adr/0003-grafana.md).
--
-- Grafana reads this table instead of scanning the raw tables, so a chart over days touches
-- thousands of rows, not millions. Two materialized views fill it as rows are inserted into
-- `actions` and `resource_samples`; each view writes only its own columns, and the rows that share a
-- (minute, engine, source) key are merged by the AggregatingMergeTree in the background. So a
-- query must always aggregate again: `countMerge(actions)`, `sumMerge(cpu_pct_sum)`, ...
-- (packages/db/README.md has one example per metric).
--
-- NOT in here: active sessions per minute. They come from `sessions` at query time (small table).
--
-- A materialized view only sees rows inserted AFTER it exists. For rows that were already there,
-- run `pnpm db:backfill-rollups` once (it truncates this table and rebuilds it from the raw tables).
--
-- Retention is 1 year, much longer than the 30 days of the raw tables. The partition is the month,
-- so with ttl_only_drop_parts whole old months are dropped.
CREATE TABLE IF NOT EXISTS fleet_minute
(
    minute        DateTime('UTC'),
    engine        LowCardinality(String),
    source        LowCardinality(String),
    -- from actions
    actions       AggregateFunction(count),
    action_errors AggregateFunction(count),
    action_ms     AggregateFunction(quantiles(0.5, 0.95), UInt32),
    -- from resource_samples, container samples only (Docker stats: CPU, memory)
    samples       AggregateFunction(count),
    cpu_pct_sum   AggregateFunction(sum, Float64),
    mem_mb_sum    AggregateFunction(sum, Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (engine, source, minute)
TTL minute + INTERVAL 1 YEAR
SETTINGS ttl_only_drop_parts = 1;

-- Actions: how many, how many failed (NOT ok), and the latency distribution.
CREATE MATERIALIZED VIEW IF NOT EXISTS fleet_minute_actions_mv TO fleet_minute AS
SELECT
    toStartOfMinute(ts) AS minute,
    engine,
    source,
    countState() AS actions,
    countIfState(NOT ok) AS action_errors,
    quantilesState(0.5, 0.95)(duration_ms) AS action_ms
FROM actions
GROUP BY minute, engine, source;

-- Container samples: only rows that have both numbers, so `samples` is the divisor for both
-- averages (a NULL would otherwise count in the divisor but not in the sum). The schema already
-- guarantees that a container sample has cpu_pct and mem_mb; this filter keeps the rollup right even
-- if a row arrives some other way. cdp samples (JS heap) have no CPU or memory and are not in here.
CREATE MATERIALIZED VIEW IF NOT EXISTS fleet_minute_samples_mv TO fleet_minute AS
SELECT
    toStartOfMinute(ts) AS minute,
    engine,
    source,
    countState() AS samples,
    sumState(toFloat64(assumeNotNull(cpu_pct))) AS cpu_pct_sum,
    sumState(toFloat64(assumeNotNull(mem_mb))) AS mem_mb_sum
FROM resource_samples
WHERE origin = 'container' AND cpu_pct IS NOT NULL AND mem_mb IS NOT NULL
GROUP BY minute, engine, source;
