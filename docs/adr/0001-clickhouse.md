# 0001. ClickHouse for fleet telemetry

Status: accepted (M0)

## Context

Fleetscope ingests a stream of small, immutable events from browser sessions: actions, resource
samples, network requests, issues. A 500-session simulation produces a steady flood of events,
and the real fleet adds a CPU/memory sample every 2 seconds per container.

The workload has a clear shape:

- **Write-heavy and append-only.** Events are never updated. (Only the per-session "latest state"
  row changes, and we model that as a new row, see below.)
- **Read by aggregation.** The dashboard asks questions like "p95 action latency per engine per
  minute over the last 6 hours", not "give me row 42".
- **Time-bound.** Raw data is interesting for weeks, not years. Rollups are interesting longer.
- **Bursty and batched.** The collector and the API buffer events and write them in batches.

## Options

1. **ClickHouse.** Columnar OLAP database.
2. **PostgreSQL with TimescaleDB.** Postgres with time-partitioned hypertables, compression and
   continuous aggregates.
3. **Plain PostgreSQL.** Regular tables with indexes and manual partitioning.

## Decision

Use **ClickHouse** for all telemetry (`sessions`, `actions`, `resource_samples`,
`network_requests`, `issues`, and later the `fleet_minute` rollup).

Why it fits:

- **Columnar storage and compression.** A query touching `engine`, `ts` and `duration_ms` reads
  only those columns, and repetitive columns (engine, source, action type) compress very well.
  `LowCardinality(String)` makes them cheaper still.
- **Fast aggregations.** Quantiles, group-by-minute and counts over millions of rows run in
  milliseconds, which is what every dashboard chart does.
- **Built for batch inserts.** One INSERT of thousands of rows is cheap; many tiny inserts are
  not. That matches our design: the API buffers events and flushes every second or 5k rows.
- **Materialized views and AggregatingMergeTree.** The `fleet_minute` rollup (M2) is maintained
  incrementally on insert, so Overview charts never scan raw rows.
- **TTL.** `TTL toDate(ts) + INTERVAL 30 DAY` drops old raw partitions with no cron job.
- **ReplacingMergeTree** gives "latest state wins" for `sessions` without UPDATEs.
- **Single container locally and in CI**, plain SQL migrations, an official Node client.

Alternatives and why not:

- **TimescaleDB** would work at our scale and keeps one database. But the interesting queries
  (quantiles over many dimensions, high-cardinality filters) are exactly what a column store is
  best at, and we want to practise the OLAP model that real observability products use. Continuous
  aggregates are also less flexible than ClickHouse materialized views for multi-dimensional
  rollups.
- **Plain Postgres** needs manual partitioning and retention, index maintenance on a hot append
  path, and slower scans for aggregations. Fine for thousands of rows, wrong for this workload.

## Consequences

Good:

- Dashboard queries stay fast as data grows; storage stays small.
- Retention and rollups are declarative (TTL, materialized views).

Costs and things to remember:

- **No cheap row updates or transactions.** The `sessions` table stores full snapshots with a
  `version` column; a `session.ended` is merged with its `session.started` before insert.
  Reads that need exactly one row per session must use `FINAL` or `argMax`.
- **No uniqueness constraints.** Duplicate events (client retries) are removed by `event_id` in
  the API layer, not by the database.
- **Small frequent inserts are an anti-pattern.** All writes go through the ingest buffer in
  batches (`insertEvents` in `@fleetscope/db`).
- **SQL dialect and operations differ from Postgres.** Migrations are plain SQL files applied by
  our own small runner with a ledger table; DDL is not transactional.
- Everything that is not time-series data needs a second store (below).

## When Postgres is still the right choice

Use Postgres for **application metadata**: users and sessions of the dashboard, API keys, alert
rules, saved views, billing. That data is small, relational, updated in place, and needs
transactions, uniqueness and foreign keys, which is what Postgres is good at and ClickHouse is
not. Fleetscope has none of this yet (M0 to M2 have no accounts). When alert rules arrive, add
Postgres for them and keep telemetry in ClickHouse; do not push rule state into ClickHouse
tables.
