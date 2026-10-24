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
- The first line of `0007` points at `docs/adr/0003-grafana.md`; the file is `0003-grafana-dashboards.md`.
  The comment stays: the checksum covers the whole file, comments included, so fixing it would make
  `db:migrate` fail on every database that already applied `0007`.
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

## Reading one session

`getSessionTimeline(client, sessionId)` returns a session (the latest version, through `FINAL`) with its
actions, resource samples, network requests and issues, or `null` for an unknown id. Times are epoch
milliseconds; every parameter is bound, never spliced into the SQL. Each table is capped at 20,000
rows (`truncated` lists the ones that were cut). `getTimelineSession` reads only the session row.
The API turns the result into a Chrome trace for Perfetto (`GET /v1/sessions/:id/trace`, layout in
`design/DESIGN.md` section 5).

Two things to know about the times: an **action** is stamped when it started, but a **network
request** is stamped when it finished (it started `duration_ms` earlier).

## Logging

The ClickHouse client's own log lines are routed into pino (JSON) and limited to errors. Callers
report expected failures such as an unreachable server themselves.

## Reading the data from Grafana

Grafana reads ClickHouse directly with the official ClickHouse data source, as a read-only user
(`pnpm --filter @fleetscope/db grafana-user`, see "The read-only Grafana user"). So the SQL of every
panel lives in the dashboard JSON, and this section holds the rules that SQL must follow. It is the
source of truth for the definitions in `design/DESIGN.md` section 3; if the two disagree, fix them
together. The examples use the plugin's macros (`$__timeFilter(col)`, `$__timeInterval(col)`,
`$__fromTime`, `$__toTime`, `$__interval_s`), the multi-select variables `${engine:singlequote}` and
`${source:singlequote}`, and the `cause` text box as `decodeURLComponent('${cause:percentencode}')`
(see the second rule below). `src/dashboard-sql.integration.test.ts` runs every
`sql name=...` block below against real ClickHouse as the read-only user, so these snippets are tested,
not just written down.

Rules for every panel:

- **A free-text variable (a text box: `session`, `cause`) is written
  `decodeURLComponent('${var:percentencode}')`, never `${var:singlequote}`.** Grafana's `singlequote`
  turns `'` into `\'` and leaves a backslash alone, so a typed `\' OR 1=1 --` becomes `\\' OR 1=1 --`
  and ClickHouse reads that as "a backslash, then the end of the string": the rest is SQL (QA-M2-05).
  `percentencode` leaves nothing in the value that can end a string (it escapes `!'()*` as well as
  everything `encodeURIComponent` escapes), and ClickHouse decodes it when the query runs. The
  multi-select variables (`engine`, `source`, `status`, `agent`, `scenario`) are different: their values
  come from a fixed list or from stored values that the schema restricts to safe labels (below), not
  from what a person types, so `singlequote` is fine there.
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
- **Values that dashboards turn into SQL are restricted at ingest.** `session_id`, `agent_id`,
  `provider`, `scenario`, `region`, `engine_version` and `error_code` accept only the characters
  `A-Z a-z 0-9 . _ : @ / + -`, 1 to 128 of them (`SAFE_LABEL_PATTERN` in `packages/schema`). Anything
  else, a quote, a backslash, a space, an accent or an emoji, gets a `400` that names the field.
  Why: dashboards put these stored values into SQL: `agent_id` and `scenario` through multi-select
  variables (`${agent:singlequote}`), `session_id` through the link to Session detail, and
  `error_code` through the failure cause (the `cause` filter). Grafana's `singlequote` turns `'` into
  `\'` and leaves a backslash alone, so a stored value with `\` or `'` could end the string early
  and add SQL of its own, and ingest has no authentication. The read-only user limits what such a
  query can do; the restricted charset removes the problem at the source, and nothing real is
  lost: the values are names such as `fleet-runner@<hostname>`, `local-docker`, `checkout-form`,
  `eu-west`, a UUID or `156.0.8078.4`. Free text (`reason`, `message`, `target`, `domain`,
  `resource_type`) is not restricted because it is only displayed. **Keep it that way: a new
  dashboard variable, link or filter may only be filled from a restricted field.** Producers conform
  instead of being rejected, because the collector drops a refused batch for good: the fleet runner
  replaces odd characters in a host name, the collector turns a browser's version string, a scenario
  and a region into safe labels, and both refuse an agent id, provider or session id they cannot send.

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
   **Filter with `minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime`, not with
   `$__timeFilter(minute)`.** A Grafana range hardly ever starts on a minute, and `minute >= from`
   throws away the whole minute that contains `from` (a 5 minute range would lose a fifth of its data,
   QA-M2-06). The price is that the first bucket may include up to 59 seconds from before `from`.
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
WHERE minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime
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
WHERE minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime
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
WHERE minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime
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
WHERE minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime
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
WHERE minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime
  AND engine IN (${engine:singlequote})
  AND source IN (${source:singlequote})
GROUP BY time, engine
ORDER BY time
```

Cores and memory in use right now: the latest container sample of each running session, counting
only samples from the **last 30 seconds**. A live session's newest sample is normally at most about
4 seconds old (one sample every 2 s, plus the collector's 1 s flush and the API's 1 s flush), so 30 s
tolerates a short ingest stall and matches the dashboards' 30 s refresh. A longer window, 5 minutes
say, would keep counting the containers of a runner that died. The price: when ingest has been down
for more than 30 s, "in use" drops to 0, which is an honest reading of "no data now". The dashboards'
Active now, CPU in use and Memory in use use the same 30 s.

```sql name=fleet-in-use-now
SELECT
    sum(latest_cpu_pct) / 100 AS cores_in_use,
    sum(latest_mem_mib) AS memory_mib_in_use,
    count() AS containers
FROM
(
    SELECT
        session_id,
        argMax(toFloat64(assumeNotNull(cpu_pct)), ts) AS latest_cpu_pct,
        argMax(toFloat64(assumeNotNull(mem_mb)), ts) AS latest_mem_mib
    FROM resource_samples
    WHERE origin = 'container'
      AND cpu_pct IS NOT NULL AND mem_mb IS NOT NULL
      AND ts >= now() - INTERVAL 30 SECOND
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

It looks up the oldest minute that the raw tables still hold, deletes the rollup rows from that
minute on (a mutation, waited for) and writes them again with `INSERT ... SELECT` from the raw tables
(the same queries as the two views; a test checks that both give the same numbers). So it is
idempotent: run it as often as you like, the result is the same.

Things to know:

- **Older rollup rows are kept.** The raw tables hold 30 days and the rollup a year, so a rollup row
  older than the oldest raw row cannot be rebuilt. An earlier version truncated the whole table and
  would have erased eleven months of history on a run at month 12. Now only the minutes the raw
  tables can reproduce are rebuilt, and when the raw tables are empty nothing is touched.
- **Run it with the API stopped** (or at least with no ingest in progress): rows inserted while it
  runs are either counted twice or missed, because the rebuild and the views both see them.
- **On ClickHouse Cloud, a repeated identical backfill could be dropped as a duplicate insert.** A
  shared or replicated table remembers the hash of every block it has inserted and skips an
  identical one, which would make a second run an empty one after the delete. We could not make a
  local table do this: with a deduplication window set on `fleet_minute`, `TRUNCATE` and the old
  `INSERT ... SELECT` repeated fine, three runs in a row gave the same numbers (tested). Both inserts
  send `deduplicate_insert = 'disable'` anyway, which costs nothing, so the first run on Cloud is the
  place to check: run it twice and compare `SELECT count(), sumMerge(...)` of `fleet_minute`.

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
provider has no price (a `LEFT JOIN` would give 0, which looks like "free").

- **A total is NULL when any session in it has no price.** A sum of only the priced sessions, shown as
  the total, would be too low and look right. The panel shows "Not available"; `unpriced_sessions`
  says how many sessions had no price.
- **A range with no sessions is a true 0** (`$0.00`), not "Not available": nothing ran, so nothing
  was spent. Test `count() = 0` first, as the snippet below does.

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

**M3 note: an old `running` session turns off partition pruning.** `picked` has no lower bound on
`started_at`, so one session that stays `running` from days ago (a zombie, a killed runner) pulls
`min(started_at)` back, and the `issues` and `actions` lookups then read from that day on, in every
panel. That is fine with dozens of sessions (M2). Revisit it in M3, with the simulator's 500+
sessions: cap the lookback, or keep per-session facts in a table filled at ingest.

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

The most frequent cause of each engine (By engine). **A tie is broken by the cause name, so the
answer never changes between two refreshes**: most sessions first, then the alphabetically first cause.
`argMax(cause, n)` is arbitrary on equal counts, do not use it. The Top failure causes table above
has the same rule (`ORDER BY sessions DESC, cause`).

```sql name=top-cause-per-engine
WITH facts AS (/* session-facts */)
SELECT
    engine,
    argMin(cause, (-toInt64(n), cause)) AS top_cause,
    max(n) AS top_n
FROM
(
    SELECT engine, cause, count() AS n
    FROM facts
    WHERE ended_at IS NOT NULL AND $__timeFilter(ended_at) AND cause IS NOT NULL
    GROUP BY engine, cause
)
GROUP BY engine
ORDER BY engine
```

The Sessions list filtered by the `cause` text box (one cause per session, so a session is listed
once; the value is a `cause` of the query above, and the Top failure causes links fill the box). A text
box is free text, so it is `decodeURLComponent('${cause:percentencode}')`:

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
WHERE $__timeFilter(started_at) AND cause = decodeURLComponent('${cause:percentencode}')
ORDER BY started_at DESC
LIMIT 1000
```

Browser-hours and estimated cost per engine for the sessions that **started** in the range (running
ones count until now). The cost of an engine is NULL when any of its sessions has no price:

```sql name=browser-hours-and-cost
WITH facts AS (/* session-facts */)
SELECT
    engine,
    count() AS sessions,
    sum(browser_hours) AS browser_hours,
    multiIf(countIf(est_cost_usd IS NULL) > 0, NULL, sum(est_cost_usd)) AS estimated_cost_usd,
    countIf(est_cost_usd IS NULL) AS unpriced_sessions
FROM facts
WHERE $__timeFilter(started_at)
GROUP BY engine
ORDER BY engine
```

The same for the whole fleet (the Estimated cost KPI). This is the one place where "nothing ran" must
be a real 0 and "something is unpriced" must be NULL, so the order of the `multiIf` branches matters:

```sql name=estimated-cost-total
WITH facts AS (/* session-facts */)
SELECT
    multiIf(count() = 0, 0, countIf(est_cost_usd IS NULL) > 0, NULL, sum(est_cost_usd)) AS estimated_cost_usd,
    countIf(est_cost_usd IS NULL) AS unpriced_sessions,
    sum(browser_hours) AS browser_hours
FROM facts
WHERE $__timeFilter(started_at)
```

#### How the dashboards relate to these snippets

- The `session-facts` block is embedded unchanged in every panel that needs it. The one allowed
  change is on Session detail, where `picked`'s `WHERE` is replaced by the session id. A test
  compares the embedded copies with the block above.
- The panels add **presentation** to the snippets and nothing else: a short session id,
  `cause: reason` as one text, `from_ms` / `to_ms` for the links, thresholds and the verdict word.
  The filters, windows and order are the ones above.
- Active now, CPU in use and Memory in use use the 30 s window of `fleet-in-use-now`; CPU and Memory are
  two panels (one value each) and, like the snippet, only count samples with both values.
- By engine computes the per-engine versions of the success rate, cost and top cause (with the
  tie-break above) from one `facts`.
- Anything not in this list that you find different between a panel and a snippet is a bug in one of
  them, not a decision: fix both together.

## The read-only Grafana user

Grafana connects as its own ClickHouse user, so a panel can never change data, even if someone pastes
a `DROP TABLE` into it.

```
CLICKHOUSE_GRAFANA_USER=grafana_ro
CLICKHOUSE_GRAFANA_PASSWORD=...            # at least 8 characters
pnpm --filter @fleetscope/db grafana-user  # root alias: pnpm db:grafana-user
```

**Defaults only for a local ClickHouse.** When `CLICKHOUSE_URL` is `localhost`, `127.x.x.x` or `::1`, a
missing user or password falls back to `grafana_ro` / `grafana_ro_dev_password`, the same defaults as
`infra/docker-compose.yml`. For any other server (ClickHouse Cloud, a hostname, a LAN address) both
must be set explicitly, and the development password is refused even if it is set on purpose, so
the default that is public in this repository can never become a real password.

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

Two more settings are **pinned** on the user (a plain user setting, which a panel cannot change
either), so a different server or profile default, ClickHouse Cloud's for example, cannot silently
change what the snippets mean:

| Pinned | Why |
|---|---|
| `join_use_nulls = 0` | `session-facts` reads an unmatched `LEFT JOIN` row as `0` and `''`. With 1 it is NULL: every successful session without issues becomes "degraded" and every cause falls back to the status, with no error |
| `aggregate_functions_null_for_empty = 0` | `sum()` over no rows must be `0`. With 1 it is NULL (`count()` stays 0), so an idle fleet's CPU in use and Memory in use would show no value instead of `0` |

Running the script again puts them back if someone changed them by hand. If a snippet starts to
depend on another setting, pin it in `grafana-user.ts` and add it here.

Anything else is refused with `READONLY`, in particular a `SETTINGS` clause in a panel. Two layers
protect the data: the grants (`SELECT` only) and `readonly = 1`. The integration test checks both: a
user with only `SELECT` is refused writes, and a user that was given `INSERT, ALTER, DROP, TRUNCATE,
CREATE` on the database still is, because of `readonly = 1`.

Note for tests and scripts: `createClickHouseClient` sends `async_insert = 0` with every request,
and a `readonly = 1` user may not change that. Connect as the Grafana user with `createReaderClient`
from `@fleetscope/db/testing` (or any client that sets no settings).
