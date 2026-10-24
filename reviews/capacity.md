# Capacity dashboard, billing and alerts: review (first review)

Reviewer: senior reviewer. Branch `capacity-dashboard` at `6338bc2`, diff `main...capacity-dashboard` (7 commits). Timebox 40 min.
Read: the commit messages, `packages/db/README.md` "Capacity" and "The read-only Grafana user", `infra/grafana/README.md` "Capacity: system logs, billing and alerts", DESIGN.md 2 and 4.5, `alerts/*.json`, `src/{alerts,billing,infinity,push,snippet-copies,palette,design-rules,check}.ts`, compose, the system-logs config, the CI script, the screenshot.
Run on the branch: `pnpm lint`, `pnpm typecheck`, `pnpm test` (all green, cached), `vitest --config vitest.integration.config.ts capacity grafana-user` (41/41), `pnpm grafana:check` against the local ClickHouse (5 dashboards, 2 alert groups, 84 queries, OK). No secret file was read or printed.
Lead decisions not reopened: `sessions` out of sent/written, `error = 0`, no source filter on the capacity snippets, per-replica system tables without `READ ON REMOTE`, Infinity + basic auth in `secureJsonData`, 1 CHC = $1, two alert groups, UTC.

## What is good

- Sent vs written is well defined and well tested: the four append-only tables against `NewPart` rows with `error = 0` of the same tables in `currentDatabase()`. The integration test proves that the MVs, the `sessions` rows and a deduplicated retry do not change the count. Zero-fill (`WITH FILL ... TO $__toTime STEP 60`) is right for counts. Utilization and limits stay NULL (`-OrNull`, `nullIf(..., 0)`) and are never turned into 0.
- The CPU metric choice is right and was checked: `CGroupUserTime + CGroupSystemTime` are already in cores, and the README shows the `...Normalized` cross-check. Not using the `OS...` host metrics is correct.
- Alert queries return one nullable `value`. `noDataState` is set on purpose for each rule. The mismatch window is whole minutes that ended one minute ago, which keeps it away from the `part_log` flush lag.
- Alerts as code: there is one `PUT .../rule-groups/<group>` per file, and a second run says `unchanged` (`containsAll` tolerates fields that Grafana adds). Provenance `api` makes the rules read-only in the UI, which is deliberate and documented. Billing runs every 15 min in its own group.
- `grafana:check`: every SQL alert and Capacity panel must equal a README block (marker or exact match). An unused `capacity-alerts-*` block fails the check. Infinity queries are shape-checked (backend parser, relative URL, no auth header, no credentials in the URL). The Capacity colours are allowed only on `fleetscope-capacity` and refused elsewhere with a clear message. The engine-override rule is skipped only there.
- Secrets: the key is only in `secureJsonData`. Push prints `key ********` and a test asserts that the key is never printed. Compose passes the key as non-`GF_` env, so Grafana does not log it, and the entrypoint echoes only a status line. `.env.example` has empty values. The grant test proves the user is denied `query_log`, `processes`, `grants` and `clusterAllReplicas`.
- No throwaway container or volume from 2026-10-25 is left in Docker (checked with `docker ps -a` and `docker volume ls`, metadata only).

## Must fix

### RV-CAP-01 The billing alerts never get the organisation id, so they cannot fire. Owner: platform
`infra/grafana/alerts/billing.json:27` and `:114`, `infra/grafana/src/alerts.ts:331-345` (`groupBody`), `push.ts:394`.
Both rules call `/v1/organizations/${ch_org}/usageCost`. `${ch_org}` is a dashboard variable. Grafana alerting does not interpolate dashboard template variables, and push writes `ch_org` only into dashboards (`withConstantVariable`), not into rule groups. So the rules send the literal `${ch_org}`, the API answers 4xx, and `execErrState: "KeepLast"` (`:82`, `:169`) keeps the rule Normal without any email. The two money alerts are silently dead. The README's "verified" covers a mock (which accepts any path) and panel queries (where the variable is substituted), not alert evaluation against the real API.
**Fix (pick one):**
- (a, preferred) Put the org in the data source, not in queries: base URL `https://api.clickhouse.cloud/v1/organizations/<org>` from `CLICKHOUSE_CLOUD_ORG_ID`, and query URLs `/usageCost?...`, in the panels and the alerts alike. That drops the `ch_org` variable and its push plumbing, and the data source needs both the key and the org id (no org id: skip it with a note).
- (b) Substitute `${ch_org}` in `groupBody` for Infinity models, and skip billing rules (with a note) when `CLICKHOUSE_CLOUD_ORG_ID` is unset.

Either way, `alertStructureProblems` should reject any `${` or `$__` in an alert model (no template variables in alerting). Set `execErrState: "Error"` on the two billing rules, so that a revoked key or a changed API sends one email instead of going quiet. Then evaluate the rules once on a throwaway Grafana against the real API and paste `health: ok` and the value into the PR.

### RV-CAP-02 A push without the API key deletes the billing alerts from Grafana. Owner: platform
`infra/grafana/src/alerts.ts:338` and `:396-408`, `push.ts` step 3b.
When `CLICKHOUSE_CLOUD_KEY_*` is not in the local env, every rule of `billing.json` is filtered out. `pushAlertGroups` then sees the existing group (2 rules on Grafana) against 0 wanted rules, marks it `updated` and sends `PUT` with `rules: []`. That empties the group on Grafana Cloud, while the billing data source created by an earlier push still exists. The skip is decided from the local env, not from what the target Grafana has. The only test covers a mixed group (`alerts.test.ts:377`).
**Fix:** when every rule of a group is skipped, do not send the group (log `left as it is`). Better still, decide the skip by `GET /api/datasources/uid/clickhouse-cloud-api` on the target, not by the local env. Add a test: an existing 2-rule billing group plus a push without the key gives no `PUT`.

### RV-CAP-03 The memory alerts' "for" does not mean what the rule says: a 1-second peak pages. Owner: backend (README block) and platform (alert JSON)
`packages/db/README.md:1087-1099` (`capacity-alerts-mem-pct`), `infra/grafana/alerts/capacity.json:70` and `:147`.
The value is the maximum over the last 10 minutes of the per-second samples. One second above 90% keeps the value above 90% for the next 10 minutes, so `for: 5m` passes and the critical rule fires. The same goes for the warning with `for: 10m` (it fires on the 10th evaluation while the peak is still in the window). The warning's text says "above 80% of its limit, for 10 minutes", which is not what it measures. It is noisy too: a single big merge sends a critical email.
**Fix:** add an alert block that looks at the last whole minute (`event_time >= toStartOfMinute(now()) - INTERVAL 1 MINUTE AND event_time < toStartOfMinute(now())`, max per host), so that `for` is the duration. Keep the 10-minute peak block for the stat panel. Or, if a peak is what should page, keep the query, set `for: 0s` and say "peaked above ... in the last 10 minutes". The CPU rule (10-minute average, `for: 10m`) is consistent with its text; leave it.

### RV-CAP-04 The `part_log` grant is wider than needed, and the comment that justifies it is wrong. Owner: backend
`packages/db/src/grafana-user.ts:44-52` and `:188`, README "The read-only Grafana user".
The comment says "ClickHouse cannot grant part of a system table". It can grant by column (`GRANT SELECT(col, ...) ON system.part_log`). Today `grafana_ro` sees every column of `part_log`:
- database and table names of every database on the service;
- `partition` values;
- `part_name`, `path_on_disk`, `disk_name`;
- `query_id`;
- `exception` text (a failed insert's message can quote data);
- `ProfileEvents`.

The snippets need only `event_time, event_type, database, table, rows, error` from `part_log`, and `event_time, metric, value, hostname` from `asynchronous_metric_log`. The practical risk is low today (one database on the service, only Grafana editors can run ad-hoc SQL), but this is the read-only user's whole point, and Eyal has to defend the grant in an interview.
**Fix:** column-level grants for both tables, with `CAPACITY_SYSTEM_TABLES` becoming a table-to-columns map, and a corrected comment. Extend the integration test: `SELECT exception FROM system.part_log` is `ACCESS_DENIED` for the reader. Check that `SELECT count() FROM system.part_log` still works as the reader (unsure whether `count()` needs a granted column; if not, the test can count on `rows`).

### RV-CAP-05 The key's role is the only barrier, and the role actually used is not recorded. Owner: platform (with Eyal)
`infra/grafana/src/billing.ts:62-76`, `.env.example:46-49`, `infra/grafana/README.md` "The key".
Every Grafana user who may query the data source can make Grafana send any request under `https://api.clickhouse.cloud`, signed with the key, through `/api/ds/query`. On Grafana Cloud that is every org member; on the local Grafana it is anonymous viewers on 127.0.0.1:3001. Infinity also allows POST, and the URL shape check exists only in our CI, not on the server. So with an Admin key a viewer could create services or new API keys. The docs say "never Admin", but nothing shows that the key in `.env.cloud` (and in Grafana Cloud) is not Admin. I could not check it, because reading the secret is off-limits.
**Fix:** Eyal confirms in the console that the key's role is read-only (Developer, or a custom role with only `control-plane:organization:view`). Record that in the PR and in the ADR. If it is Admin, rotate it to a read-only key before the push.

## Nits

- **RV-CAP-06 (platform, unsure)** `billing.ts:73` and the provisioning yaml: as far as I know, Infinity matches `allowedHosts` by prefix, so `https://api.clickhouse.cloud` would also allow `https://api.clickhouse.cloud.evil.example`. Use `https://api.clickhouse.cloud/` (trailing slash). If prefix matching holds, `https://api.clickhouse.cloud/v1/organizations/<org>/usageCost` would pin the key to the one endpoint it needs. Verify on a throwaway Grafana.
- **RV-CAP-07 (platform)** Run-out math, `billing.json` `root_selector`: the API has no row for today, so `grandTotalCHC` misses today's usage so far, while the projection runs from `now`. The burn is understated by up to one day (about 15 CHC). The panel projects from the start of today, so the panel and the alert disagree slightly. Project from `now | strftime("%Y-%m-%d") | strptime(...) | mktime` (start of today, UTC), like the panel. Optionally count only `locked == true` days as full.
- **RV-CAP-08 (backend, unsure)** `capacity-utilization` / `capacity-alerts-mem-pct`: use `CGroupMemoryUsedWithoutPageCache`. Page cache is reclaimable and does not cause OOM. The two metrics are equal today on Cloud and locally (0.401 GiB both, measured), so this is about meaning, not today's numbers. Also, ClickHouse refuses queries at `max_server_memory_usage` = 0.9 x the cgroup limit (locally 3.6 of 4 GiB), so the "critical > 90%" alert fires only when queries are already failing. Consider 75 / 85, or state it in the description.
- **RV-CAP-09 (platform)** `fs-capacity-no-writes`: with `tools/live-traffic.ps1` this is the "stop" alert Eyal asked for, and it is fine. But it repeats every repeat interval while the PC sleeps, and provenance `api` means the rule can't be paused in the UI. Say in the description and the README: "use a silence when stopping live traffic on purpose".
- **RV-CAP-10 (platform, unsure)** The capacity group queries ClickHouse Cloud every minute, around the clock. If the service has idling enabled, this keeps it awake when the fleet is stopped and burns credit. Check the service's idle setting. Record it in the ADR (consequences), or lengthen the interval of the non-urgent rules.
- **RV-CAP-11 (platform)** `check.ts:403`: `requireCopy` covers panels only, so the Capacity annotation (`capacity-limit-changes`) is not enforced (it matches today, but nothing keeps it so). Add `-- snippet: capacity-limit-changes` to it, or require copies for annotations on the Capacity dashboard too.
- **RV-CAP-12 (dashboard)** `design/DESIGN.md:229` still says "Idle minutes have no row ... (`insertNulls`)". Since `6338bc2` an idle minute is a row of zeros. Update the sentence (and drop `insertNulls` from the load panels if it is still set).
- **RV-CAP-13 (platform)** The trial constants (`2026-10-24`, `2026-11-23`, `300`) are repeated in 2 alerts, 4 panels and two READMEs. One unit test that asserts they agree everywhere is enough.
- **RV-CAP-14 (platform)** Evidence: the README's "Verified on a throwaway Grafana" should also say that the container and its volume were removed (that Grafana held the real key, encrypted with Grafana's default `secret_key`). I found no leftovers from 2026-10-25, so this is one line of documentation.
- **RV-CAP-15 (dashboard)** Without the billing data source, the four billing panels show Grafana's red error triangle plus "No data". DESIGN 4.5 says "show no data, and their descriptions say so". It is acceptable, but `noValue: "Not available"` on the stats would match the "not available" rule better. The triangle can't be avoided while the panel names a missing data source.

## Verdict (first review)

**Request changes.** Must fix: RV-CAP-01, RV-CAP-02, RV-CAP-03, RV-CAP-04, RV-CAP-05. The rest are nits. The SQL is sound and well tested; the blockers are about whether the alerts fire honestly and the least privilege of the user and the key.

## ADR draft (for the lead): 0006 Capacity monitoring from per-replica system tables and the billing API

**Context.** Eyal raised the live load and wants proof that ClickHouse Cloud writes what the fleet sends, utilization against the service's limits, autoscaling events, the trial credit, and email alerts for all of it. ClickHouse exposes this in two places: its own system tables (`system.part_log`, `system.asynchronous_metric_log`), and the ClickHouse Cloud control-plane API (`/v1/organizations/{id}/usageCost`). Grafana must keep reading through the read-only `grafana_ro` user, and billing needs an organisation API key.

**Options.**
1. System tables through `clusterAllReplicas(default, ...)`. This sees every replica, but it needs `GRANT READ ON REMOTE ON *.*`, which lets the user read from any server that the cluster functions can reach.
2. The plain system tables, per replica (whatever replica Grafana reaches). The grant is narrow (`SELECT` on two system tables, by column). It is exact while the service runs one replica and wrong once the inserts spread across replicas.
3. ClickHouse Cloud's built-in monitoring or its Prometheus endpoint. That means one more data source and a credential with wider scope, and it does not compare the result with the fleet's own rows.
4. Billing: the Infinity plugin with basic auth in `secureJsonData` and `allowedHosts`, or a small proxy in our API that holds the key.

**Decision.** Option 2 for load and utilization, and the Infinity data source for billing. "Sent" counts the four append-only tables and "written" counts `part_log` `NewPart` rows with `error = 0` for the same tables (`sessions` is excluded because it is a ReplacingMergeTree). The capacity queries have no `source` filter, because the system tables know nothing about it. The billing key is read-only (a role with only `control-plane:organization:view`), is stored only in Grafana's `secureJsonData`, and is limited by `allowedHosts` to `api.clickhouse.cloud`. 1 CHC is treated as $1. The alerts are code (`infra/grafana/alerts`), in two groups (capacity every minute, billing every 15 minutes), and their SQL is copied from `packages/db/README.md` and executed in CI.

**Consequences.**
- With more than one replica, the panels and the mismatch alert show only one replica and can be wrong. The README says so, and the replica count and the limits-changed alert make a scale-out visible. Moving to option 1 later is one grant and a table wrapper, and needs a new ADR, because it widens `grafana_ro`.
- A replaced replica takes its log with it, so there is no history across replacements.
- The newest ~10 s of the charts are incomplete because of the log flush.
- Backfills (seed, simulator runs with their own clock) show up as a mismatch.
- Every Grafana user who can query the billing data source can use the key within its role, so the role must stay read-only.
- Billing lags about a day.
- The per-minute alert queries keep the Cloud service from idling.
- The trial dates and the $300 are constants that must change when the plan changes.

# Round 2 (re-review of the fixes)

Scope, as cut by the lead: the fix diffs for RV-CAP-01..05 (`8c05104`, `933cce9`, `870efc0`, plus `31b45c4` for QA-CAP-01). HEAD `31b45c4`.
Run: `pnpm lint` and `pnpm typecheck` pass. `pnpm test`: everything passes except 2 api tests that timed out under the parallel turbo run. This branch does not touch `apps/api`, and both files pass when re-run alone (39/39). Integration: capacity, capacity.qa, grafana-user and dashboard-sql pass (83/83). `pnpm grafana:check`: 84 queries, 2 alert groups, OK. No secret was read or printed.

| Finding | Status | Notes |
|---|---|---|
| RV-CAP-01 billing alerts never get the org | **resolved** | The org is in the data source base URL (`billing.ts`, provisioning yaml). Panels and rules use `/usageCost?...`. `alertStructureProblems` rejects `${` and `$__` anywhere in a rule. `infinityQueryProblems` requires `/usageCost` with no variable. `execErrState: Error` on both billing rules. Evidence in the README: the credit rule was evaluated through Grafana against the real API (HTTP 200, 281.975 left). The run-out now uses the same projection as the panel (start of today, `floor(left/avg) - days_to_end`), which also resolves nit RV-CAP-07. |
| RV-CAP-02 keyless push empties the billing group | **resolved** | `pushAlertGroups` sends nothing when every rule of a group is skipped. The skip is decided by the target Grafana (`GET /api/datasources/uid/clickhouse-cloud-api`), not by the local env. A unit test covers it, and the README records a real keyless push that left the 2-rule group and the data source alone. |
| RV-CAP-03 memory `for` on a 10-minute peak | **resolved** | New block `capacity-alerts-mem-pct-1m`: the average of the last whole minute per host, max over hosts. With it, `for: 10m` / `5m` is the real duration, and the summaries now say so. The 10-minute peak block stays for the stat panel. The check that "every alert block is used" was dropped for that reason, which is acceptable. The metric is now `CGroupMemoryUsedWithoutPageCache`, and the thresholds are 75 / 85 against ClickHouse's own ~90% refusal point (resolves nit RV-CAP-08). |
| RV-CAP-04 whole-table system grants | **resolved** | `CAPACITY_SYSTEM_COLUMNS` grants only the columns the snippets use (`part_log`: database, error, event_time, event_type, rows, table; metric log: event_time, hostname, metric, value). A `REVOKE` of the whole-table grant comes first, so a re-run converges. The comment is corrected and notes `count()` needs a granted column. The integration tests pass on a real ClickHouse. |
| RV-CAP-05 key role not recorded | **resolved** (Eyal) | The role is "Organization API Reader". The lead verified a read returns 200 and a write probe (PATCH organization) returns 403. The README documents both the role and the probe. `allowedHosts` is now pinned to `.../v1/organizations/<org>/usageCost`; per the README this was measured on 4.1.3: prefix match, `evil.example` and `/services` refused (resolves nit RV-CAP-06). |
| QA-CAP-01 annotation copy check | **resolved** | `check.ts`: `requireCopy` now covers everything on the Capacity dashboard except variables, with a test in `snippet-copies.test.ts` (resolves nit RV-CAP-11). |

New nit (not blocking): the "Cost note" in `infra/grafana/README.md` says idling can be helped by "pause the group with a silence". A silence only mutes notifications; the rules keep querying every minute, so the service still can't idle. Drop that option, or say "lengthen the interval, or set `isPaused: true` and push".

Nits not re-checked under the scope cut: RV-CAP-09, 10 (README now has silence and cost notes), 12, 13, 14 (README now records the cleanup), 15.

## Verdict (round 2)

**Approve.** All five must-fix items are resolved. Nothing is disputed. One new docs nit (the silence and idling sentence) is left for the lead to forward.
