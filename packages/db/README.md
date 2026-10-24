# @fleetscope/db

ClickHouse client, migrations, batch insert and the queries shared by `api` and `mcp`. It also
documents the tables and the rules that the Grafana dashboards follow ("Reading the data from Grafana" below).

## Commands

```
pnpm db:migrate            # apply pending migrations from infra/clickhouse
pnpm db:seed               # insert a handful of source=sim events (repeatable)
pnpm db:backfill-rollups   # rebuild fleet_minute from the raw tables (see "Backfill")
pnpm test                  # unit tests, no Docker
pnpm test:integration      # needs ClickHouse: pnpm infra:up
```

## Migrations

Plain SQL files in `infra/clickhouse/`, named `NNNN_name.sql`, applied in order. The runner records
each applied file (with a checksum) in the `schema_migrations` table.

Rules:

- **Run migrations from exactly one place.** ClickHouse has no advisory locks and no transactional
  DDL, so the runner cannot lock. Run `pnpm db:migrate` as a single CI/deploy step (or by hand),
  never on API startup, where several replicas could race and record a file twice. The runner
  re-reads the ledger right before each file, which narrows the race but does not close it.
- **Keep statements idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), or keep
  one statement per file. A file that fails halfway re-runs from its first statement.
- **Applied files are append-only.** Editing or deleting an applied file makes the runner fail
  (checksum). Add a new migration instead. M0 is merged, so `0001` to `0005` are frozen; schema
  changes go in a new file (`0006` sets the insert deduplication window, `0007` adds the
  `fleet_minute` rollup, `0008` the `pricing` table).
- A file may hold several statements separated by `;`. `--` comments are stripped first, so a `;`
  or `--` inside a string literal is not supported.

## Writing events

`insertEvents(client, events)` takes validated `FleetEvent`s and writes one batch INSERT per table.
`ts` is sent as a `YYYY-MM-DD HH:MM:SS.mmm` string, because ClickHouse reads a bare integer as
seconds.

`insertEvents(client, events, { dedupTokens })` is safe to repeat. With one `insert_deduplication_token`
per table (`dedupTokensFor(flushId)` builds `<flushId>:<table>`), ClickHouse skips an INSERT it has
already seen, so a flush that failed halfway can be retried with the same events and tokens without
duplicating the tables that were written. Without tokens nothing is deduplicated. The result lists
the `session.ended` events whose `session.started` was not found (`orphans`) so the caller can try
them again later. See `docs/adr/0002-ingest-dedupe.md`.

The client sets `async_insert = 0`: ClickHouse 26.x defaults to server-side async inserts, but the
API already batches.

Rows older than the 30 day TTL are dropped by ClickHouse asynchronously: a background merge removes the expired part shortly after the insert, so a query right after the insert may still see them.

## Logging

The ClickHouse client's own log lines are routed into pino (JSON) and limited to errors. Callers
report expected failures such as an unreachable server themselves.

## Reading the data from Grafana

Grafana reads ClickHouse directly with the official ClickHouse data source, as a read-only user
(`pnpm --filter @fleetscope/db grafana-user`, see "The read-only Grafana user"). So the SQL of every
panel lives in the dashboard JSON, and this section holds the rules that SQL must follow. It is the
source of truth for the definitions in `design/DESIGN.md` section 3; if the two disagree, fix them
together. The examples use the plugin's macros (`$__timeFilter(col)`, `$__timeInterval(col)`,
`$__fromTime`, `$__toTime`, `$__interval_s`) and the dashboard variables `${engine:singlequote}`,
`${source:singlequote}` and `${cause:singlequote}`. `src/dashboard-sql.integration.test.ts` runs every
`sql name=...` block below against real ClickHouse as the read-only user, so these snippets are tested,
not just written down.

Rules for every panel:

- **No `SETTINGS` clause.** The Grafana user is `readonly = 1`, so a query that sets a setting
  (`SETTINGS join_use_nulls = 1`) is refused. The queries below are written to not need one.
- **Always filter on `source`**, and show the variable. Real and simulated data are never mixed
  silently.
- **Rates are percentages from 0 to 100** (Grafana unit `percent`). Say "no data" honestly: a ratio is
  `if(den = 0, NULL, num / den)`, never `ifNull(metric, 0)`; use `-OrNull` aggregates where a set can
  be empty.
- **Memory is in MiB.** `mem_mb` (container) and `js_heap_mb` (CDP) are bytes divided by 1024², despite
  the `mb` in the name. Use the Grafana unit `mbytes`, which prints MiB and GiB. Dividing by 1000
  somewhere would be about 5% off.
- **CPU is a percentage of one core** (`cpu_pct`, as Docker reports it; it can pass 100 on a
  multi-core container).

### The rollup `fleet_minute`

One row per `(minute, engine, source)`, filled by two materialized views as rows are inserted into
`actions` and `resource_samples` (migration `0007`). Charts over time read this table instead of the
raw ones. Raw rows are kept 30 days, the rollup 1 year.

| Column | Type | Meaning |
|---|---|---|
| `minute` | `DateTime('UTC')` | start of the minute |
| `engine`, `source` | `LowCardinality(String)` | as in the raw tables |
| `actions` | `AggregateFunction(count)` | number of actions |
| `action_errors` | `AggregateFunction(count)` | actions with `ok = false` |
| `action_ms` | `AggregateFunction(quantiles(0.5, 0.95), UInt32)` | latency distribution (`duration_ms`) |
| `samples` | `AggregateFunction(count)` | number of container samples (CPU and memory both present) |
| `cpu_pct_sum` | `AggregateFunction(sum, Float64)` | sum of `cpu_pct` over those samples |
| `mem_mb_sum` | `AggregateFunction(sum, Float64)` | sum of `mem_mb` (MiB) over those samples |

How to read it:

1. **Every metric column is an aggregate state. Wrap it in its `-Merge` function and `GROUP BY`**,
   even for a single minute: ClickHouse merges the rows of one key in the background, so until then
   a minute can be spread over several rows. `countMerge(actions)`, `sumMerge(cpu_pct_sum)`,
   `quantilesMerge(0.5, 0.95)(action_ms)`. Selecting a state column directly returns binary junk.
2. **An average is a sum divided by a count**, both merged: `sumMerge(cpu_pct_sum) /
   countMerge(samples)`, guarded against a zero count (a minute can have actions and no samples,
   or the other way round, because two views fill the table). Never `avg()` of per-minute averages
   (a minute with 2 samples would weigh as much as one with 60).
3. **A percentile is merged from states, never averaged.** `quantilesMerge` over a 15 minute bucket
   is the p95 of all the actions in it. The average of fifteen per-minute p95s is not a p95.
4. **Set the panel's "Min interval" to `1m`.** The rollup has one row per minute; a finer bucket
   splits nothing.
5. Container samples are CPU and memory measured outside the browser by Docker stats. `cdp` samples
   (JS heap) are not in the rollup; read `resource_samples` for a single session.
6. **The rollup counts actions, not sessions.** `action_errors` is its own metric, "action errors per
   minute". It is NOT the error rate of the dashboards, which is per session (below) and excludes
   interrupted sessions. The rollup cannot exclude them: an action is counted when it arrives,
   before the session ends, so a Ctrl+C can add a few `browser_closed` actions (the ones in flight).

Actions per minute (the bucket length is `greatest($__interval_s, 60)` seconds):

```sql name=actions-per-minute
SELECT
    $__timeInterval(minute) AS time,
    engine,
    countMerge(actions) / (greatest($__interval_s, 60) / 60) AS actions_per_min
FROM fleet_minute
WHERE $__timeFilter(minute)
  AND engine IN (${engine:singlequote})
  AND source IN (${source:singlequote})
GROUP BY time, engine
ORDER BY time
```

Action errors per minute (failed actions, a count; not the error rate):

```sql name=action-errors-per-minute
SELECT
    $__timeInterval(minute) AS time,
    engine,
    countMerge(action_errors) / (greatest($__interval_s, 60) / 60) AS action_errors_per_min
FROM fleet_minute
WHERE $__timeFilter(minute)
  AND engine IN (${engine:singlequote})
  AND source IN (${source:singlequote})
GROUP BY time, engine
ORDER BY time
```

Action latency p50 and p95 in ms (NULL, not `nan`, where the bucket has no actions):

```sql name=action-latency
SELECT
    $__timeInterval(minute) AS time,
    engine,
    if(countMerge(actions) = 0, NULL, quantilesMerge(0.5, 0.95)(action_ms)[1]) AS p50_ms,
    if(countMerge(actions) = 0, NULL, quantilesMerge(0.5, 0.95)(action_ms)[2]) AS p95_ms
FROM fleet_minute
WHERE $__timeFilter(minute)
  AND engine IN (${engine:singlequote})
  AND source IN (${source:singlequote})
GROUP BY time, engine
ORDER BY time
```

CPU (% of one core) and memory (MiB) per container:

```sql name=cpu-mem-per-container
SELECT
    $__timeInterval(minute) AS time,
    engine,
    if(countMerge(samples) = 0, NULL, sumMerge(cpu_pct_sum) / countMerge(samples)) AS cpu_pct_per_container,
    if(countMerge(samples) = 0, NULL, sumMerge(mem_mb_sum) / countMerge(samples)) AS mem_mib_per_container
FROM fleet_minute
WHERE $__timeFilter(minute)
  AND engine IN (${engine:singlequote})
  AND source IN (${source:singlequote})
GROUP BY time, engine
ORDER BY time
```

CPU cores and memory (MiB) in use across the whole fleet, averaged over the bucket. The runner takes
one container sample every 2 seconds, so a sample stands for 2 seconds: `sum(cpu%) / 100 * 2 s` is
core-seconds, and dividing by the bucket length gives cores. This assumes the 2 second interval (the
`StatsSampler` default); a different interval needs a different constant. For "right now" use
`fleet-in-use-now` below instead.

```sql name=fleet-cores-and-memory
SELECT
    $__timeInterval(minute) AS time,
    engine,
    sumMerge(cpu_pct_sum) / 100 * 2 / greatest($__interval_s, 60) AS cores_in_use,
    sumMerge(mem_mb_sum) * 2 / greatest($__interval_s, 60) AS memory_mib_in_use
FROM fleet_minute
WHERE $__timeFilter(minute)
  AND engine IN (${engine:singlequote})
  AND source IN (${source:singlequote})
GROUP BY time, engine
ORDER BY time
```

Cores and memory in use right now: the latest container sample of each running session. A session
whose sampler stopped (no sample in the last 5 minutes) is not counted.

```sql name=fleet-in-use-now
SELECT
    sum(cpu_pct) / 100 AS cores_in_use,
    sum(mem_mib) AS memory_mib_in_use,
    count() AS containers
FROM
(
    SELECT session_id, argMax(cpu_pct, ts) AS cpu_pct, argMax(mem_mb, ts) AS mem_mib
    FROM resource_samples
    WHERE origin = 'container'
      AND ts >= now() - INTERVAL 5 MINUTE
      AND engine IN (${engine:singlequote})
      AND source IN (${source:singlequote})
      AND session_id IN (SELECT session_id FROM sessions FINAL WHERE status = 'running')
    GROUP BY session_id
)
```

**Active sessions are not in the rollup.** They come from `sessions` at query time, which is small:
a session is active in every minute between its start and its end (a session that has not ended
counts until now). A session is counted once per bucket.

```sql name=active-sessions
SELECT
    $__timeInterval(minute) AS time,
    engine,
    uniq(session_id) AS active_sessions
FROM
(
    SELECT
        session_id,
        engine,
        arrayJoin(range(
            greatest(toUInt32(toStartOfMinute(started_at)), toUInt32(toStartOfMinute($__fromTime))),
            least(toUInt32(toStartOfMinute(coalesce(ended_at, now64(3)))), toUInt32($__toTime)) + 1,
            60)) AS minute_epoch,
        toDateTime(minute_epoch, 'UTC') AS minute
    FROM sessions FINAL
    WHERE engine IN (${engine:singlequote})
      AND source IN (${source:singlequote})
      AND started_at <= $__toTime
      AND coalesce(ended_at, now64(3)) >= $__fromTime
)
GROUP BY time, engine
ORDER BY time
```

A session whose runner was killed never gets its `session.ended` and stays `running`, so it counts
as active (and costs, below) until it is cleaned up. That is what the "zombie sessions" insight will
list.

#### Backfill

A materialized view only sees rows inserted after it was created. Rows that were already in
`actions` and `resource_samples` when migration `0007` ran are not in `fleet_minute`. To fill it
from the raw tables:

```
pnpm db:backfill-rollups      # = pnpm --filter @fleetscope/db backfill-rollups
```

It truncates `fleet_minute` and rebuilds it with `INSERT ... SELECT` from the raw tables (the same
queries as the two views; a test checks that both give the same numbers), so it is idempotent: run
it as often as you like, the result is the same. Run it with the API stopped (or at least with no
ingest in progress): rows inserted while it runs are either counted twice or missed, because the
rebuild and the views both see them. The rebuild covers what the raw tables still hold (30 days),
so rollup rows older than that are gone after a backfill.

### Prices and cost

`pricing(engine, provider, usd_per_browser_hour, source_url, note, effective_from)` holds the
reference price of one browser for one hour (migration `0008`). Today there is one row per engine
for the provider `local-docker`: **$0.10 per browser-hour**, Browserbase's published overage rate on
the Startup plan (<https://www.browserbase.com/pricing>, checked 2026-10-24), the same for all three
engines until M3. It is an estimate of what the same minutes would cost on a cloud browser
provider; nothing is billed. A panel must say "estimated" and can show `source_url` and `note`.

A new price is a new row with a later `effective_from`. The view **`pricing_current`** (engine,
provider, price, source_url, note, `in_effect_since`) holds the latest price that is already in
effect, and dashboards join that view, so every session in the selected range is priced at the
current price.

### Data rules

**One row per session: `FROM sessions FINAL`.** `sessions` keeps a running row (version 1) and an
ended row (version 2) until ClickHouse merges them. `FINAL` returns the latest, and a `WHERE` is
applied after that, so `WHERE status = 'running'` is right (without `FINAL` it also returns
sessions that have already ended). `argMax(col, version)` per `session_id` is the alternative.
Never count `sessions` without one of the two.

**Display status** (six values, `design/DESIGN.md` section 2), from the session row, its failed actions
and its issues:

| Display status | Rule |
|---|---|
| `running` | no `session.ended` yet (`status = 'running'`) |
| `interrupted` | `status = 'failed' AND reason = 'interrupted'` (Ctrl+C: the user stopped the run, the fleet did not fail) |
| `healthy` | `status = 'success'`, no failed action and no issue |
| `degraded` | `status = 'success'` with a failed action (a retry) or any issue |
| `blocked` | `status = 'blocked'` |
| `failed` | `status` is `failed`, `timeout` or `crashed` (the code is the cause) |

Test `reason` with `ifNull(reason, '')`: it is nullable, and `NOT (status = 'failed' AND reason =
'interrupted')` is NULL (so the row is dropped) for a failed session without a reason.

**Success rate** = (healthy + degraded) / ended sessions = `success` / ended, **not counting
interrupted or running sessions**. `blocked`, `timeout`, `crashed` and `failed` all count against
it. Thresholds: >= 95% is Healthy, 90 to < 95% is Degraded, < 90% is Failed.

**Error rate** (per session) = 100 - success rate, from `sessions FINAL`, bucketed by `ended_at`. It
is not computed from `fleet_minute`, so interrupted sessions are excluded and the chart agrees with
the verdict.

**Failure cause** (one per session that ended without success and was not interrupted): the kind of
its first `issue`, else the `error_code` of its first failed action (lowest `seq`), else its
`status`. `cause_from` says which one (`issue`, `action` or `status`). The `reason` text is shown next
to it as `cause: reason`.

**Interrupted sessions** have their own count and status. They never enter the success rate, the
error rate, the failure lists or the causes. They did use a browser, so they are in browser-hours and
cost.

**Browser-hours = `(startup_ms + connect_ms + duration_ms) / 3.6e6`**, and a running session counts
until now (`dateDiff('millisecond', started_at, now64(3))` instead of `duration_ms`), so cost agrees
with the Active sessions chart.

- `duration_ms` starts when the browser is already usable, so it leaves out `startup_ms` (container
  created until the server answers) and `connect_ms` (the client's `connect()`, which launches the
  Playwright browser). The container exists, and a cloud provider bills the session, from the first
  moment, so the sum is the time the browser was held. Counting only `duration_ms` would also hide
  a real difference between engines: Chromium launches its browser inside `connect_ms`, the CDP
  engines inside `startup_ms`, and the engine comparison (M3) is about exactly that.
- A session is attributed to the time it **started** (`started_at`), not spread over the hours it
  ran in.

**Estimated cost = browser-hours x `pricing_current.usd_per_browser_hour`**; NULL for a session whose
provider has no price (a `LEFT JOIN` would give 0, which looks like "free"), counted as
`unpriced_sessions`.

#### The per-session building block

Everything session-level above is computed by one query, so the definitions live in one place:
**`session-facts`** returns one row for every session that overlaps the dashboard's time range, with
its display status, failure cause, failed actions, issues, browser-hours and estimated cost. The
panels below wrap it as `WITH facts AS (<session-facts>) SELECT ... FROM facts` and then filter on
the time column they need: `ended_at` for outcomes (rates, failures, causes) and `started_at` for
lists and cost. Paste the whole query where the comment says `/* session-facts */`; the test does
exactly that.

```sql name=session-facts
WITH
    picked AS
    (
        SELECT *
        FROM sessions FINAL
        WHERE engine IN (${engine:singlequote})
          AND source IN (${source:singlequote})
          AND started_at <= $__toTime
          AND (ended_at IS NULL OR ended_at >= $__fromTime)
    ),
    issue_facts AS
    (
        SELECT session_id, count() AS issue_count, toString(argMin(kind, ts)) AS first_issue
        FROM issues
        WHERE session_id IN (SELECT session_id FROM picked)
          AND ts >= (SELECT min(started_at) FROM picked)
        GROUP BY session_id
    ),
    action_facts AS
    (
        SELECT
            session_id,
            count() AS actions,
            countIf(NOT ok) AS failed_actions,
            ifNull(argMinIf(error_code, seq, NOT ok), '') AS first_failed_code
        FROM actions
        WHERE session_id IN (SELECT session_id FROM picked)
          AND ts >= (SELECT min(started_at) FROM picked)
        GROUP BY session_id
    )
SELECT
    p.session_id AS session_id,
    p.agent_id AS agent_id,
    p.source AS source,
    p.engine AS engine,
    p.engine_version AS engine_version,
    p.provider AS provider,
    p.scenario AS scenario,
    p.started_at AS started_at,
    p.ended_at AS ended_at,
    p.status AS status,
    p.reason AS reason,
    p.duration_ms AS duration_ms,
    p.startup_ms + p.connect_ms AS time_to_browser_ms,
    (p.status = 'failed' AND ifNull(p.reason, '') = 'interrupted') AS is_interrupted,
    a.actions AS actions,
    a.failed_actions AS failed_actions,
    i.issue_count AS issue_count,
    multiIf(
        p.status = 'running', 'running',
        is_interrupted, 'interrupted',
        p.status = 'success' AND a.failed_actions = 0 AND i.issue_count = 0, 'healthy',
        p.status = 'success', 'degraded',
        p.status = 'blocked', 'blocked',
        'failed') AS display_status,
    if(p.status NOT IN ('running', 'success') AND NOT is_interrupted,
        multiIf(i.first_issue != '', i.first_issue, a.first_failed_code != '', a.first_failed_code, p.status),
        NULL) AS cause,
    if(cause IS NULL, NULL,
        multiIf(i.first_issue != '', 'issue', a.first_failed_code != '', 'action', 'status')) AS cause_from,
    (toUInt64(p.startup_ms) + p.connect_ms
        + ifNull(p.duration_ms, dateDiff('millisecond', p.started_at, now64(3)))) / 3.6e6 AS browser_hours,
    if(price.provider = '', NULL, browser_hours * price.usd_per_browser_hour) AS est_cost_usd
FROM picked AS p
LEFT JOIN issue_facts AS i ON i.session_id = p.session_id
LEFT JOIN action_facts AS a ON a.session_id = p.session_id
LEFT JOIN pricing_current AS price ON price.engine = p.engine AND price.provider = p.provider
```

(An unmatched `LEFT JOIN` row gets `0` and `''`, not NULL, since the Grafana user cannot set
`join_use_nulls`; the expressions above rely on that. `ts >= (SELECT min(started_at) FROM picked)` does
not change the result, an event is never older than its session; it lets ClickHouse skip the old
partitions of `issues` and `actions`.)

Outcomes for a range: counts per display status, the success rate and the error rate (0 to 100),
for the sessions that **ended** in it. Drop `GROUP BY engine` for the fleet-wide numbers of the KPI
row and the verdict.

```sql name=session-rates
WITH facts AS (/* session-facts */)
SELECT
    engine,
    countIf(NOT is_interrupted) AS ended,
    countIf(display_status = 'healthy') AS healthy,
    countIf(display_status = 'degraded') AS degraded,
    countIf(display_status = 'failed') AS failed,
    countIf(display_status = 'blocked') AS blocked,
    countIf(is_interrupted) AS interrupted,
    if(ended = 0, NULL, 100 * (healthy + degraded) / ended) AS success_rate,
    if(ended = 0, NULL, 100 - 100 * (healthy + degraded) / ended) AS error_rate
FROM facts
WHERE ended_at IS NOT NULL AND $__timeFilter(ended_at)
GROUP BY engine
ORDER BY engine
```

The error rate chart, per `ended_at` bucket (`min interval 5m` on the panel):

```sql name=session-error-rate-over-time
WITH facts AS (/* session-facts */)
SELECT
    $__timeInterval(ended_at) AS time,
    engine,
    if(countIf(NOT is_interrupted) = 0, NULL,
        100 * countIf(NOT is_interrupted AND status != 'success') / countIf(NOT is_interrupted)) AS error_rate
FROM facts
WHERE ended_at IS NOT NULL AND $__timeFilter(ended_at)
GROUP BY time, engine
ORDER BY time
```

The latest sessions that ended without success (interrupted excluded), with their cause:

```sql name=recent-failures
WITH facts AS (/* session-facts */)
SELECT
    ended_at AS time,
    display_status AS status,
    session_id,
    engine,
    scenario,
    cause,
    cause_from,
    reason,
    source
FROM facts
WHERE ended_at IS NOT NULL AND $__timeFilter(ended_at) AND cause IS NOT NULL
ORDER BY ended_at DESC
LIMIT 15
```

Top failure causes, with the engines that hit them (`lightpanda 71, chromium 3`):

```sql name=top-failure-causes
WITH facts AS (/* session-facts */)
SELECT
    cause,
    cause_from,
    sum(n) AS sessions,
    arrayStringConcat(
        arrayMap(x -> concat(x.1, ' ', toString(x.2)), arrayReverseSort(x -> x.2, groupArray((engine, n)))),
        ', ') AS engines
FROM
(
    SELECT cause, cause_from, engine, count() AS n
    FROM facts
    WHERE ended_at IS NOT NULL AND $__timeFilter(ended_at) AND cause IS NOT NULL
    GROUP BY cause, cause_from, engine
)
GROUP BY cause, cause_from
ORDER BY sessions DESC, cause
LIMIT 10
```

The Sessions list filtered by a `cause` dashboard variable (one cause per session, so a session is
listed once; the variable's values are the `cause` column of the query above):

```sql name=sessions-by-cause
WITH facts AS (/* session-facts */)
SELECT
    started_at AS time,
    display_status AS status,
    session_id,
    engine,
    scenario,
    cause,
    cause_from,
    reason
FROM facts
WHERE $__timeFilter(started_at) AND cause IN (${cause:singlequote})
ORDER BY started_at DESC
LIMIT 1000
```

Browser-hours and estimated cost for the sessions that **started** in the range (running ones count
until now):

```sql name=browser-hours-and-cost
WITH facts AS (/* session-facts */)
SELECT
    engine,
    count() AS sessions,
    sum(browser_hours) AS browser_hours,
    sum(est_cost_usd) AS estimated_cost_usd,
    countIf(est_cost_usd IS NULL) AS unpriced_sessions
FROM facts
WHERE $__timeFilter(started_at)
GROUP BY engine
ORDER BY engine
```

## The read-only Grafana user

Grafana connects as its own ClickHouse user, so a panel can never change data, even if someone pastes
a `DROP TABLE` into it.

```
CLICKHOUSE_GRAFANA_USER=grafana
CLICKHOUSE_GRAFANA_PASSWORD=...            # at least 8 characters
pnpm --filter @fleetscope/db grafana-user  # root alias: pnpm db:grafana-user
```

The script connects with the admin user (`CLICKHOUSE_USER`, which may manage users) and runs
`CREATE USER IF NOT EXISTS`, `ALTER USER` (password and settings) and `GRANT SELECT ON <database>.*`.
Run it again whenever you like: it is idempotent, and running it with a new password rotates the
password. It refuses to touch the admin user's own name, never logs the password (it is passed as a
query parameter, so it is not in the SQL text either, and ClickHouse does not write it to
`system.query_log`), and removes it from error messages. It uses only standard SQL access control, so
it should work on ClickHouse Cloud too (checked on 26.8 locally, not on Cloud).

**Why `readonly = 1` and not `2`.** `readonly = 2` also refuses writes, but lets the client change
any setting per query, which a shared server should not allow (a panel could lift the memory, row
and time limits). `readonly = 1` refuses all setting changes, which would break the Grafana plugin,
because its ClickHouse client sets `max_execution_time` on every query (its documentation says so
and says to keep `readonly = 1` and mark that setting changeable). So the user is `readonly = 1`
plus exactly two settings it may change:

| Setting | Why | Limit |
|---|---|---|
| `max_execution_time` | the plugin sets it for the query timeout | default 60 s, at most 300 s |
| `additional_table_filters` | how the plugin applies a dashboard's "ad hoc filters" | only narrows rows |

Anything else is refused with `READONLY`, in particular a `SETTINGS` clause in a panel. Two layers
protect the data: the grants (`SELECT` only) and `readonly = 1`. The integration test checks both: a
user with only `SELECT` is refused writes, and a user that was given `INSERT, ALTER, DROP, TRUNCATE,
CREATE` on the database still is, because of `readonly = 1`.

Note for tests and scripts: `createClickHouseClient` sends `async_insert = 0` with every request,
and a `readonly = 1` user may not change that. Connect as the Grafana user with `createReaderClient`
from `@fleetscope/db/testing` (or any client that sets no settings).
