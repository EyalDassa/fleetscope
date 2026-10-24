# QA report: M2 Grafana dashboards

Branch `m2-grafana-dashboards`, first QA pass. Environment: Windows 11, Git Bash, Node 22.17, Docker Desktop, ClickHouse 26.8.34.13 (the pinned image), Grafana 13.2.4 with ClickHouse plugin 4.23.2, Chrome (system install) driven by `playwright-core` 1.64.1, Perfetto `trace_processor` from the pip package `perfetto` in a scratch venv.

Tested against the PR description, ADR 0003, `design/DESIGN.md` (the Grafana spec), `packages/db/README.md` ("Grafana data rules") and `infra/grafana/README.md`, not against what the code happens to do. `reviews/` was not read or touched.

## Verdict, first pass: READY TO MERGE (no open blocker or major bug)

The numbers are right. Every number I computed by hand matches what the dashboard SQL returns, and what the real Grafana (13.2.4 and the real ClickHouse plugin) prints on screen. The read-only user holds. The trace loads in Perfetto's `trace_processor` and in the Perfetto UI in a real Chrome. `grafana:push` is idempotent and its safety rules work. There are 13 findings, all minor or nit, none blocks the merge. Four deserve a decision before the demo:

- **QA-M2-01 (minor, platform): the local Grafana does not reload edited dashboard files.** The README says it re-reads the folder every 10 seconds. It reads it once, at start. **Your Grafana on :3001 is serving the dashboards from its start at 10:14:48, not the committed ones** (the JSON files changed at 10:38; I compared the bytes). If your manual check of the Overview was made after 10:38, it ran on those older dashboards. Restart it (`docker compose --project-directory . -f infra/docker-compose.yml restart grafana`) before the end-to-end check or any screenshot.
- **QA-M2-02 (minor, dashboard): at 1440 px the Sessions table shows only 9 of its 15 columns.** Peak memory, Est. cost, **Cause** and **Source** (the REAL/SIM label) are off-screen and need horizontal scrolling. The repo's own `sessions-1440.png` shows it cut at "Pea". Simulated rows are labelled, but you cannot see the label.
- **QA-M2-04 (minor, dashboard): a session id that does not exist looks like a running session.** Duration says "running", Actions "0 ok · 0 failed".
- **CI: GitGuardian fails with 5 "Generic Password" findings (not Vercel, new).** All five are the public dev password placeholders. See the CI section.

The re-test pass is not needed to merge, but fixes for the four above would be cheap.

## CI (`gh pr checks 5`, head `d33ed74`)

| Check | Result |
|---|---|
| Integration tests (ClickHouse) | pass, including the dashboard SQL check as the read-only user |
| Fleet smoke (Chromium) | pass |
| Secret scan (gitleaks) | pass |
| Lint, typecheck, unit tests | **fail**: `recent-ids.scale.test.ts` (QA-M1-07), timing noise. Fixed in my commit `abcd69e`, **not pushed** (see "The flaky test") |
| **GitGuardian Security Checks** | **fail, 2 s: "5 secrets uncovered".** Generic Password in `.env.example:20`, `infra/grafana/src/connection.ts:12`, `infra/grafana/src/check.test.ts:289` and `:294`, and "Curl Username Password" in `infra/grafana/README.md:36`, all in commit `7c630de`. They are the documented development defaults (`grafana_ro_dev_password`, the dev admin password). This is a third-party app on the repo, not a workflow in `ci.yml`. Mark the five incidents as false positives in the GitGuardian dashboard (or add a `.gitguardian.yaml` `matches-ignore` for the dev defaults). QA-M2-14 |
| Vercel | fail (expected: Eyal still has to disconnect that project). Vercel Preview Comments passes |

## The flaky test (your extra item)

`apps/api/src/ingest/recent-ids.scale.test.ts` > "QA-M1-07: the cost per event stays flat". The old check was `max / min < 4` over 12 chunks of 25,000 events. The maximum is exactly the one chunk a noisy runner slows down (4.6 on GitHub). Locally the fixed code already reached 3.4 on that statistic.

Now it throws away 2 warm-up chunks, uses 36 chunks of 10,000 events, and asserts `p75 / fastest < 8` plus `median < 100 µs`. I calibrated the statistic against the first (buggy) Map version, copied into a scratch script:

| Implementation | p75 / fastest | max / fastest |
|---|---|---|
| Current (Set + moving head) | 1.6 to 1.9 | 2.2 to 3.4 |
| Old Map with `keys().next()` + delete (QA-M1-07 bug) | 19.7 to 21.0 | 36 to 40 |

The limit 8 is about 4× above the good code and 2.5× below the bug. A noisy neighbour would have to slow a quarter of all chunks to fail it. Run 20 times in a row: 20/20 passed. Run 18 times with 6 copies in parallel on one machine (CPU contention): 18/18 passed. `RecentIds` exposes nothing countable, so counting operations was not an option without product changes. Committed alone as `abcd69e` (`test(api): make the QA-M1-07 scale test robust on shared runners`), not pushed.

## Tests added

All files are mine; no product code, dashboard JSON or existing test was changed. The integration tests run against real ClickHouse as the read-only user, with the SQL taken **from the dashboard JSON** (expanded by `infra/grafana/src/interpolate.ts` and `macros.ts`, the same code `grafana:check` uses), not from the README snippets that the backend's test already covers.

| File | Kind | What it covers |
|---|---|---|
| `packages/db/fixtures/dashboards.ts` | harness | Loads the dashboard queries, expands macros and variables for any time range and filter, runs them as a given user, plus the session-event builders |
| `packages/db/fixtures/known-fleet.ts` | fixture | The known fleet below (19 sessions) |
| `packages/db/src/dashboards.numbers.integration.test.ts` | integration, 38 | Every Overview KPI and chart, By engine, Recent failures, Top failure causes, the Sessions table with its filters, every Session detail panel and both annotations. Hand-computed expectations; the table that explains every session is at the top of the file. Also the rollup against the raw tables, "right now" (Active now, CPU, Memory) and the README against the dashboards |
| `packages/db/src/dashboards.edge.integration.test.ts` | integration, 16 (2 `it.fails`) | Empty database (all 40 queries of the three dashboards, with and without a session id, for the last hour, 30 days and the future), one session, only sim, an unknown session id, hostile text in the session box, the rollup at the range edge, **10,000 sessions with timings** |
| `packages/db/src/grafana-user.m2.integration.test.ts` | integration, 6 | The read-only user from outside: reads, INSERT into every table, 15 DDL/mutation/user-management statements, setting changes, another database, `system.*`, `url()/file()/remote()/s3()` |
| `infra/grafana/src/push.qa.test.ts` | unit, 9 (1 `it.fails`) | `GRAFANA_URL` and ClickHouse address rules, admin user never used, token never in an error |
| `infra/grafana/src/links.qa.test.ts` | unit, 6 | Every link: target exists, only variables the target has, time range kept, Session link shape, Perfetto link, dashboard links |
| `apps/api/src/trace/build-trace.qa.test.ts` | unit, 4 (3 `it.fails`) | Heavy page lanes, track sort order, events before the session start |
| `apps/api/src/ingest/recent-ids.scale.test.ts` | edited | The flaky QA-M1-07 test (above) |

`it.fails` marks a confirmed bug: the suite stays green and the test flips to a failure when the bug is fixed (remove the `.fails` then). They are tied to IDs below.

### The known fleet (hand-computed, and verified)

19 sessions around a range `[T0, T0+60 min]`: 13 real ones that started in it, 1 real one that started before it and ended inside, 2 real ones outside it (one after, one before), and 3 sim. They cover every status, interrupted, running, a session that started before the range and ended inside, nulls (`js_heap_mb`, a null engine version, no samples, no price), and three engines. A few of the expectations, all matched exactly:

| Number | Hand computation | Dashboard |
|---|---|---|
| Success rate (real) | 12 ended, not interrupted; 6 succeeded -> 50% | 50.0%, verdict Failed |
| Outcomes | 4 healthy, 2 degraded, 5 failed, 1 blocked | 4 / 2 / 5 / 1 |
| p95 action latency | 18 actions, interpolated position 16.15 -> 400 + 0.15 × 100 | 415 ms (same as `quantile(0.95)` on the raw table) |
| By engine, chromium p95 / CPU / peak memory | 445 ms / (10+30+20+40)/4 = 25% / avg(300, 200) = 250 MiB | 445 ms / 25% / 250 MiB |
| Cost, lightpanda + headless-shell | (20,300+60,300+8,300+40,300+20,750) ms = 149,950 ms × $0.10/h | $0.0041652778 |
| Top causes | captcha 2 (issue wins over the failed action), selector_not_found 2, crashed 1 (status), timeout 1 | same, in that order, the interrupted session's `browser_closed` absent |
| Error rate chart | chromium 100, 0, 0, 100, **null** (a bucket with only an interrupted session); lightpanda 100, 50 | same |
| "What happened" | `Failed at 1.60 s: action #1 click button.buy, selector_not_found` | same |
| Sim only | verdict 66.7%, share 100%, cost "Not available" (one sim session has no price) | same |

The same numbers appear on screen: I pushed the dashboards to a fresh Grafana 13.2.4 pointing at this dataset, opened them in Chrome and read the rendered text (`Failed`, `4 2 5 1`, `0% · all real`, `13`, `50.0%`, `415 ms`, `57.1% / 25.0% / 100.0%`, `445 / 88 / 70 ms`, the recent failures in order with the right local time, `Healthy ... Completed, no issues`, and so on).

## Findings

Severity: **blocker** (cannot merge), **major** (wrong behaviour users will hit), **minor**, **nit**. None is a blocker or major.

### QA-M2-01 (minor, platform): edited dashboard files are not reloaded, and the README says they are

- **Steps.** Start a fresh `grafana/grafana:13.2.4` with `infra/grafana/provisioning` mounted and a copy of `dashboards/`. Change `"title"` in `fleetscope-overview.json`. Wait 3 minutes. Restart the container.
- **Expected** (`infra/grafana/README.md` "Edit a dashboard", the comment in `provisioning/dashboards/fleetscope.yaml`, `updateIntervalSeconds: 10`): the title changes within 10 seconds.
- **Actual.** It stays at version 1 for the whole wait. The Grafana log shows `starting to provision dashboards` only once per start. After a restart the title is updated (version 2). A second edit while running is again not picked up.
- **Also seen on your Grafana.** `GET /api/dashboards/uid/fleetscope-overview` (version 2, `updated` 10:14:48 = container start) differs from the file (mtime 10:38, same bytes inside the container). The SQL comments in it are older ("Sessions started in the range, by display status" where the file says "ended in the range"). The three dashboards there are all older than the files.
- **Impact.** Documentation and the edit loop; the shipped JSON is fine. But anything verified by hand on :3001 since 10:38 was verified on old dashboards.
- **Fix.** Say "restart Grafana (or run `pnpm grafana:push` against the local Grafana, untested) after editing a file" and drop the 10-second claim, or find why the file provider does not poll in 13.2.4 (the `meta.provisioned` flag is `false` even right after a fresh provisioning, so the new unified storage may be involved). Files: `infra/grafana/README.md`, `infra/grafana/provisioning/dashboards/fleetscope.yaml`.

### QA-M2-02 (minor, dashboard): the Sessions table hides Cause and Source at 1440 px

- **Steps.** Open Sessions at 1440 px wide, Grafana's menu closed (the repo's `screenshots/sessions-1440.png` is exactly this). With the menu docked (Grafana's default) the table is cut after "Time to browser".
- **Expected.** DESIGN section 3: "Simulated data is always labelled (`SIM` in session tables)"; section 4.3 lists the columns Status, Session, Started ... Cause, Source.
- **Actual.** The first 11 (closed menu) or 9 (docked) of 15 columns are visible. Peak memory, Est. cost, **Cause**, **Source** need horizontal scrolling. The same happens to By engine's Memory, Est. cost and Top cause with the menu docked. A mixed real/sim table cannot be told apart at a glance.
- **Fix.** Put Source and Cause right after Session, and drop or narrow Version and Agent. File: `infra/grafana/dashboards/fleetscope-sessions.json` (and By engine in `fleetscope-overview.json`).

### QA-M2-03 (minor, platform): `grafana:check` silently runs as the admin user when the Grafana user is not configured

- **Steps.** With a `.env` that lacks `CLICKHOUSE_GRAFANA_USER` (yours does), run `pnpm grafana:check`.
- **Expected** (README: "as the read-only user"). Or a clear sign that it did not.
- **Actual.** `running every query against http://localhost:8123, ... user fleetscope`. Admin. A query with a `SETTINGS` clause, refused for the Grafana user (my read-only test), would pass here and fail in CI. There is no static rule for `SETTINGS` in `design-rules.ts`. With `CLICKHOUSE_GRAFANA_USER=grafana_ro` set it prints `user grafana_ro (read-only Grafana user)` and passes 58 queries. CI sets the variable, so CI is right.
- **Fix.** Print "(admin: the read-only user is not configured)", or fall back to the local dev defaults like `grafana-user` does, and add a static `SETTINGS` rule. Files: `infra/grafana/src/connection.ts`, `design-rules.ts`.

### QA-M2-04 (minor, dashboard): a session id that does not exist looks like a running session

- **Steps.** `/d/fleetscope-session?var-session=nope` (the repo's `session-not-found-1440.png` shows it too).
- **Expected** (DESIGN section 6): "Session not found..." in Status, the other panels show their own No value text.
- **Actual.** Status says it, but **Duration prints "running"**, Actions "0 ok · 0 failed", Requests "0", Peak CPU, Peak memory and Peak JS heap "Not available", Est. cost "Not available". Duration's No value text is the word that means "no `duration_ms` yet". Aggregate stats (`count`, `maxOrNull`) always return one row, so their No value text never shows. The Status text itself is rendered very small on a pale panel.
- **Test.** `dashboards.edge.integration.test.ts` "Session detail for an id that does not exist" documents which panels return a row.
- **Fix.** Give Duration a different No value text ("Not found" or "—"), and make the stats return no row for an unknown session (`HAVING`, or select from `sessions FINAL WHERE session_id = ...` first). File: `infra/grafana/dashboards/fleetscope-session.json`.

### QA-M2-05 (minor, dashboard): the session text box can leave the SQL string

- **Steps.** In the Session dashboard type `\' OR 1=1 --` into the session box, or open `?var-session=%5C%27%20OR%201%3D1%20--`.
- **Expected.** No rows (an unknown id), like `x' OR 1=1 --` (that one is escaped correctly, tested).
- **Actual.** `${session:singlequote}` turns `'` into `\'` and leaves the backslash, and ClickHouse reads `\\'` as "backslash, then end of string". The query becomes `session_id = '\' OR 1=1 --'` and returns the session. Tested with the check's own interpolation, which implements Grafana's `singlequote` the same way (I did not type it into a browser).
- **Impact.** Whoever can open the dashboard can run any `SELECT` on the Fleetscope database through a crafted URL, and can start expensive queries (the user's `max_execution_time` is 60 s, up to 300). The read-only user bounds the damage: `SELECT` on `fleetscope.*` only, nothing in `system.*`, no other database, no writes (all tested). On the local Grafana anyone is a Viewer, but the data is visible anyway.
- **Fix.** The percent-encoding format and `decodeURLComponent('${session:percentencode}')` in SQL (check that Grafana's `percentencode` escapes `'` and `\`), or a dropdown query variable of session ids. Test: `it.fails` "hostile text in the session box cannot leave the string (backslash then quote)". File: `fleetscope-session.json` (every `${session:singlequote}`).

### QA-M2-06 (minor, dashboard): the rollup drops the partial first minute of the range

- **Steps.** Range `[X+30 s, X+10 min]`, three actions at `X+36 s` (after `from`, in the minute that contains `from`).
- **Expected.** The p95 and the actions per minute include the three actions (the raw table has them).
- **Actual.** `$__timeFilter(minute)` is `minute >= from`, and the minute starts at `X`, so the whole minute is dropped: p95 is NULL. A Grafana range such as "Last 1 hour" practically never starts on a minute, so the KPI and the two rollup charts lose up to a minute: about 1.7% of an hour, 20% of a 5 minute range.
- **Fix.** `minute >= toStartOfMinute($__fromTime) AND minute <= $__toTime` in the four rollup queries (p95 KPI, Actions per minute, By engine `rollup`). Test: `it.fails` in `dashboards.edge.integration.test.ts`. File: `fleetscope-overview.json`.

### QA-M2-07 (minor, platform): `grafana:push` does not recognise every spelling of "this machine"

- **Steps.** `GRAFANA_URL=https://stack.grafana.net CLICKHOUSE_URL=http://127.0.0.2:8123 pnpm grafana:push --dry-run` (also `0.0.0.0` and `localhost.`).
- **Expected** (README, ADR): a localhost ClickHouse is refused for a remote Grafana.
- **Actual.** Accepted; the data source would point at an address Grafana's server cannot reach. `localhost`, `127.0.0.1`, `[::1]` and `host.docker.internal` are refused. The check is a list of five exact names, while `grafana-user` already treats every `127.x.x.x` as local.
- **Fix.** Treat `127.0.0.0/8`, `0.0.0.0`, a trailing dot and `*.localhost` as loopback. Test: `it.fails` in `push.qa.test.ts`. File: `infra/grafana/src/push.ts` `LOOPBACK_HOSTS`.

### QA-M2-08 (minor, backend): the track order of a heavy trace is broken

- **Steps.** Open `/v1/sessions/2d8339cd-08b8-46a7-9ea2-41394f429093/perfetto` (the demo's `heavy-page-crawl`, 112 sampled requests) and click the button.
- **Expected** (DESIGN section 5): tracks actions, network, issues, then counters.
- **Actual.** Network lane `k` sorts at `20 + k`, but `issues` sorts at 30 and `session` at 40. From the tenth lane on they interleave: "network 21" appears below "session" in the Perfetto UI (screenshot taken in Chrome). Sort indexes are not unique (31 distinct of 33).
- **Fix.** Give the lanes a sort range of their own (e.g. issues 5, session 6, actions 10, network 100+). Tests: two `it.fails` in `build-trace.qa.test.ts`. File: `apps/api/src/trace/build-trace.ts`.

### QA-M2-09 (minor, backend): events before the session start disappear from the timeline

- **Steps.** Build a trace for a session that has a request that started 400 ms before `started_at`, an issue 200 ms before and a sample 1 s before. Load it in `trace_processor`.
- **Expected.** The events are visible (or clamped to 0).
- **Actual.** `ts` is negative (`-400000`, `-200000`, `-1000000`). `trace_processor` reports `trace_sorter_negative_timestamp_dropped = 4` and the three events (and one more counter) are not in the trace. Silent: the JSON is valid.
- **Likelihood.** Low: none of the 54 real sessions in the dev database has a negative `ts`. A request that began before `session.started` (clock skew between collector and runner, or a page already loading) would hit it.
- **Fix.** Use the earliest event as the origin, or clamp to 0. Test: `it.fails` in `build-trace.qa.test.ts`. File: `build-trace.ts` (`at()`).

### QA-M2-10 (nit, backend): heavy pages produce a very tall timeline

- **Judgement** on "lane count". The demo's heavy page has 112 sampled requests and uses **40 network lanes** (44 thread tracks in total), as against 22 the engineer saw. Perfetto labels the first lane "network 2" (its name plus its thread id) and the others "network 2 201", "network 3 202" and so on, so "network 2" is the first lane, not the second. The CPU, memory and JS heap counters sit below all of them: on this session you scroll about 1,000 px to see the counters next to the actions, which is the point of the timeline. For normal pages (4 or 5 tracks) it is clear and nice (checked: actions with `✕` on the failed ones, network, session markers, the three counters).
- **Suggestion.** Cap the network lanes (8 to 10) and put the rest on one "network (more)" lane, and sort the counters above the network lanes. Not a deviation from DESIGN ("adds a `network N` thread only when needed").

### QA-M2-11 (nit, platform): `grafana:push` output details

- The data source line says `updated` on every run, never `unchanged` (the code cannot compare because Grafana never returns the password, so it always PUTs). The README says it prints created, updated or unchanged for each part. Idempotent in effect, noisy in text.
- With `FLEETSCOPE_API_URL` unset, a push to a remote Grafana prints no warning and keeps the committed `http://localhost:4000`; the warning only fires when the variable is set to a localhost address.

### QA-M2-12 (nit, dashboard): "What happened" and the cause can name different things

Session with a `captcha` issue and a failed `selector_not_found` action (R6 in the tests). Tables and Top causes say the cause is `captcha` (the issue wins, by the rule). Session detail's sentence says `Failed at 1.10 s: action #0 goto demo.test, selector_not_found`. Both follow their written rules, but the reader of one session sees two reasons. Consider appending the issue ("... , with issue captcha"). File: `fleetscope-session.json` "What happened".

### QA-M2-13 (nit, backend docs): the README snippets and the dashboards differ in four places

`packages/db/README.md` says it is the source of truth, and `dashboards.numbers.integration.test.ts` proves the `session-facts` block is byte-for-byte the same in every dashboard that uses it (whitespace aside), and that `session-rates` and `top-failure-causes` give the same numbers. The differences are:

1. **Cost with an unpriced session.** README `browser-hours-and-cost` sums the priced ones and counts `unpriced_sessions`. The Overview KPI and By engine return NULL ("Not available") if any session is unpriced. The dashboard is stricter, and agrees with DESIGN's "null is Not available". The README should say so.
2. **No sessions.** The KPI prints `$0.00` for a range with no sessions (README: not specified).
3. **CPU and memory "in use".** README `fleet-in-use-now` looks back 5 minutes; the KPIs and Active now look back 30 s (DESIGN section 4.2). The README snippet is stale.
4. **Top cause on a tie.** By engine uses `argMax(cause, n)`: with equal counts the shown cause is arbitrary (lightpanda's R9, R10, R11 all `×1`).

### QA-M2-14 (minor, platform): GitGuardian flags the dev placeholders

See the CI table. Not a leak (`grafana_ro_dev_password` is the public default in `docker-compose.yml`), but the check is red on the PR.

## What I tried

### 1. Numbers

See "Tests added" and the table of hand-computed values. All 38 tests in `dashboards.numbers.integration.test.ts` pass on the first run against the committed dashboards; there are no failing numbers. One check from your list is not literally possible: "a missing price" is tested with `provider = "mystery"` (no row in `pricing_current`), which is how a session ends up unpriced.

### 2. Edge data

| Case | Result |
|---|---|
| Empty database, all 40 queries, 4 variants each | no error. Verdict `no_data`, ratios NULL, counts 0, charts and tables with no rows (so their No value texts show; rendered in the repo screenshot `overview-no-data-1440.png`) |
| One session | verdict 100% healthy, one row in every table, p95 = that action, chart has one point |
| Only sim | `source = real` shows no data; `All` and `sim` show "100% · all simulated", every row says `sim` |
| Unknown session id | trace and perfetto both 404 (JSON and an HTML error page); a hostile id is HTML-escaped in the page; a 300 character id gets **414**, not 400 or 404 |
| Session detail panels for an unknown id | QA-M2-04 |
| **10,000 sessions** | see below |

**10,000 sessions** (70,000 events, three engines, 8 agents, 100 interrupted, 500 failed, 200 blocked; range last hour). The numbers are exact (9,900 ended, 92.93%, verdict Degraded, 9,200/0/500/200, causes 500 and 200, 30,000 actions; the Sessions table returns exactly 1,000 rows, newest first). SQL time per panel, as the read-only user, in ms:

| Panel | ms | Panel | ms |
|---|---|---|---|
| Fleet verdict | 134 | Error rate by engine | 120 |
| Outcomes | 110 | Active sessions by engine | 20 |
| Simulated share | 109 | Actions per minute | 14 |
| Active now | 19 | **By engine** | **452** |
| Sessions | 117 | Recent failures | 142 |
| Success rate | 139 | Top failure causes | 135 |
| p95 latency | 18 | **Sessions table (1,000 rows)** | **275** |
| CPU / Memory in use | 20 / 20 | Estimated cost / Interrupted | 115 / 120 |

**The ~5 s you saw is not the SQL.** The slowest query at 10,000 sessions is By engine at 0.45 s (it evaluates the session-facts block five times). On the 54-session dev database, through the real Grafana and the plugin, the 17 Overview queries finished in 35 to 489 ms each (By engine 489 ms, the rest under 90 ms). I could not reproduce the delay. Candidates: the first load of the plugin module in the browser, a fleet run using the CPU at the same time (containers, ClickHouse), or the older dashboards on :3001 (QA-M2-01). If it comes back, open the panel's Inspect > Query tab for the real time.

### 3. Read-only user

`grafana_ro` (and a fresh user created by `ensureGrafanaUser`): reads all 8 tables and views including `pricing_current`; refuses INSERT into every table, DROP, TRUNCATE, ALTER DELETE/UPDATE, lightweight DELETE, CREATE TABLE and VIEW, RENAME, OPTIMIZE, CREATE USER, ALTER USER, GRANT, SYSTEM, KILL, `SET`, any `SETTINGS` clause, and `max_execution_time` above 300 s (300 is accepted, as the plugin needs). Cannot read another database, `system.users`, `system.query_log`, `url()`, `file()`, `remote()`, `s3()`. **The plugin works as that user:** the real Grafana's data source health says "Data source is working" and the Overview's 17 queries run. `grafana:check` as `grafana_ro`: 3 dashboards, 58 queries OK. CI sets the user and password at job level and calls `pnpm grafana:check` after `db:grafana-user` and `db:seed`, so it runs as the read-only user (see QA-M2-03 for the local default).

### 4. `grafana:push`

Against a fresh `grafana/grafana:13.2.4` (no provisioning, a service account token with the Admin role):

| Case | Result |
|---|---|
| `--dry-run` | reads Grafana, prints "would be created" for the folder, data source, 3 dashboards and the theme; afterwards Grafana still has no dashboards |
| first push | creates all; health check "Data source is working" |
| second push | folder, 3 dashboards and the theme `unchanged`; the data source `updated` (QA-M2-11) |
| wrong token | `HTTP 401: Invalid API key`, hint about the token, exit 1, nothing written |
| Viewer token | `HTTP 403 ... datasources:write`, hint about the Admin role |
| `GRAFANA_URL=http://stack.grafana.net` | refused before any request ("must start with https://") |
| `https://...` Grafana with `CLICKHOUSE_URL=http://localhost:8123` or `[::1]` | refused; `127.0.0.2`, `0.0.0.0`, `localhost.` are not (QA-M2-07) |
| `FLEETSCOPE_API_URL=http://localhost:4000` to a remote Grafana | **warns** and continues, naming the three files |
| no `CLICKHOUSE_GRAFANA_PASSWORD` | refused ("the admin CLICKHOUSE_USER is never used here") |
| secrets in output | none: I searched every output file for the token, the Viewer token and the ClickHouse password |

The pushed dashboards then rendered correctly in Chrome against the known fleet, and the `api_url` variable was written (`http://localhost:4000/v1/sessions/R6/perfetto`, `target="_blank"`).

### 5. Trace and Perfetto

- **Valid.** Three real traces (a heavy 112-request page, a failed session, a blocked one) load in `trace_processor` with no errors: slices, instants, and counter tracks named **`CPU %`, `memory MB`, `JS heap MB`** as DESIGN says. The Perfetto UI at ui.perfetto.dev also accepts them.
- **Handshake.** In Chrome (automation with `playwright-core` and the system Chrome, which is what your run could not do): the page enables its button when the trace has loaded, a click opens `https://ui.perfetto.dev/`, the PING/PONG exchange completes, and the UI loads the trace titled "Fleetscope session ... chromium login-and-search (1 MB)". It shows actions with `✕ click [data-testid="flaky-button"]` on the failed ones, the session start and end markers, and the three counters. No "trust this origin" dialog appeared in headless Chrome (the page says one may). The script's logic is covered by the backend's 7 unit tests.
- **Nulls.** A container sample with a null value writes no counter (unit-tested by the backend; I added the loaded-in-Perfetto check: a session whose only CDP samples are null has no JS heap track and an instant on the issues track saying so; counters of the container samples are intact).
- **Failed marks.** `✕` prefix on failed actions and failed requests, nothing relies on colour.
- **All 54 sessions in the dev database** return valid JSON through the live API, none with a negative timestamp.
- **Heavy pages.** QA-M2-08 and QA-M2-10. Edge: events before the start, QA-M2-09. A request-less, sample-less session loads fine.

### 6. Links

Static (`links.qa.test.ts`, 6 tests): 21 links to dashboards, all point at existing UIDs with only variables that exist there; every Sessions link keeps the time range; the Session link is exactly `?var-session=...&from=<start-5s>&to=<end+5s>`; the Perfetto link uses `${api_url}`, opens in a new tab, and appears as a panel link and in the Timeline text. `pnpm grafana:check` link check: pass. In the real Grafana: the Recent failures row for R6 links to `/d/fleetscope-session?var-session=R6&from=...&to=...`, and the page that opens has `09:32:55` to `09:33:15` for a session that ran `09:33:00` to `09:33:10`, and shows "Failed at 1.10 s". One UX note, not a bug: the `cause` variable that the Top failure causes link sets is hidden (`hide: 2`), so a Sessions view filtered by cause shows no sign of the filter except the rows.

## Not tested

- Grafana Cloud, ClickHouse Cloud and Grafana Assistant (B5, needs Eyal's accounts).
- The exact `singlequote` escaping in a real browser (QA-M2-05 used the check's implementation of it).
- A real Ctrl+C fleet run (the interrupted rule is covered with data: R7 in the tests, the 100 sessions of the 10k run).
- 10,000 sessions through the plugin and the browser (the SQL timings are over HTTP; the dev database through Grafana has 54 sessions).
- Memory-heavy or runaway queries on the shared ClickHouse (I did not run any, on purpose).
- A light theme (dark only, as DESIGN says), and 1024 px (the repo has screenshots; I used 1440 and 1600).
- Events with a timestamp before their session in the dashboard SQL (the session-facts block ignores events older than the earliest picked session; ingest timestamps are not checked against `started_at`).
- Duplicate `event_id`s at dashboard level (an M1 ingest concern, tested there).
- `pnpm grafana:push` against the local Grafana that has provisioned dashboards.

## Run log (end of the pass)

- `pnpm lint && pnpm typecheck && pnpm test`: green. Per package: schema 135, demo-site 106, collector 129 (+2 expected fail), fleet-runner 190 (19 skipped), db 99, **grafana-tools 125 (+1 expected fail, 15 new)**, api 231 (+3 expected fail, 4 new).
- `pnpm test:integration`: green. api 71, db 216 (+2 expected fail), including my 60 new integration tests.
- `pnpm grafana:check` as `grafana_ro`: 3 dashboards OK, 58 queries.
- Leftovers: none from me. Throwaway Grafana containers, the render database and its user are removed; ClickHouse (:8123), the local Grafana (:3001, healthy, untouched) and your API (:4000) are running. Five `fleetscope_test_*` databases (09:40 to 10:23 UTC) and two `fleetscope_grafana_test_*` users in ClickHouse are older than this pass (from earlier agents' runs); drop them when convenient.
- Scratch scripts for the manual checks (not in the repo): `perfetto-e2e.cjs`, `render.cjs`, `drill.cjs`, `timing.cjs`, `tp.py` and the venv in the QA scratchpad directory.
