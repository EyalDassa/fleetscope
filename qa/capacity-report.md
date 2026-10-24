# QA report: Capacity dashboard, billing, alerts (branch `capacity-dashboard`)

Tested at `6338bc2` / `b8d54bc`. Review fixes landed during the pass (`8c05104`: column-level grants and the
1-minute memory alert; `933cce9`: billing org in the data source URL, keyless push keeps the billing group). The
areas they touch are marked **being fixed** and were not re-tested here. No secret was printed; the throwaway
Grafana (`qa-grafana`, port 3099) and its token were removed/discarded. Local ClickHouse limits were restored to
4 GiB / 2 CPU. Nothing was pushed to Grafana Cloud or ClickHouse Cloud.

## Tests added
- `packages/db/src/capacity.qa.integration.test.ts` (committed `1cfbeeb`, 2 tests, real ClickHouse, as `grafana_ro`):
  - backfill: events stamped 3 h ago are sent in the old minute and written in the current minute; every minute of
    the range has a row; idle minutes are rows of zeros;
  - a range ending exactly on a minute boundary stops there; `from = to` gives one row.
- Scratch tools (not committed, in the session scratchpad): snippet runner, mutation runner for `grafana:check`.

## Results per area

| # | Area | Result |
|---|------|--------|
| 1 | Sent vs written | **Pass.** Fleet run (6 real sessions, chromium + headless-shell): runner said 223 events; 12 are `sessions` rows, so 211 append-only rows. Snippet: sent 51+160 = 211, written 51+160 = 211. By hand from the tables: actions 78, resource_samples 30, network_requests 103, issues 0 = 211; `part_log` NewPart same per table. Idle minutes before and after are rows of 0/0/0. |
| 1b | Duplicate batch | **Pass.** The same 29 events POSTed 3 times (immediately, and after a flush): `accepted 29, duplicates 0`, then `accepted 0, duplicates 29` twice. `part_log` written 9+6+6+2 = 23 rows, no `error != 0` rows, tables hold 23. The second layer (retried flush, `error = 389`) is covered by the developer's integration test, which passed. |
| 1c | `sim run` backfill | **Pass, behaves as documented.** 60 sessions over 20 min (1904 events = 1784 append-only rows): sent is spread over 20 minutes (25 to 158 per minute), written is one spike of 1784 in the minute of the POST. Over 3 h the same shape. This makes the per-minute chart useless for backfills and makes the mismatch alert fire (QA-CAP-03). |
| 2 | Utilization | **Pass.** Limits read 4 GiB / 2 cores (cgroup `memory.max` 4294967296, `cpu.max 200000/100000`). Memory stress (`uniqExact(numbers(150M))`): cgroup 1.0 to 2.75 GiB sampled, ClickHouse stopped the query at 3.52 GiB RSS ("maximum 3.60", 0.9 x limit); dashboard minute peak 3.583 GiB; `capacity-alerts-mem-pct` = 89.57 = 3.583/4 x 100 (by hand). CPU stress: cgroup used 66.1 core-s in 78 s (0.85 cores); dashboard minutes 0.64 and 0.73 (partial minutes, baseline 0.2), 1.30 in the minute of the heaviest query; consistent. |
| 2b | Scaling change | **Pass.** Recreated only the clickhouse service with an override file (6 GiB / 3 CPU, then restored): utilization shows 4 -> 6 and 2 -> 3 at 21:43; `capacity-limit-changes` gives one row `memory limit 4 -> 6 GiB; CPU limit 2 -> 3 cores`; `capacity-alerts-limits-changed` = 1. Restore recorded as a second change. See QA-CAP-04 (cosmetic). |
| 3 | Grants (HEAD, before 8c05104) | **Pass for tables, see QA-CAP-05 for columns.** `grafana_ro` reads `part_log` and `asynchronous_metric_log`; denied (ACCESS_DENIED): `query_log`, `processes`, `text_log`, `metric_log`, `trace_log`, `query_views_log`, `error_log`, `users`, `grants`, `parts`, `clusters`, `asynchronous_metrics`, `metrics`, `numbers`, `clusterAllReplicas`, `remote`, `url`, `file`. Writes denied: INSERT, CREATE, DROP, ALTER, TRUNCATE, SYSTEM FLUSH, KILL; `SETTINGS readonly=0` refused. |
| 4 | Alerts on a throwaway Grafana 13.2.4 | **Pass.** Pushed HEAD alerts with lowered thresholds (scratch copy, `for` 0s). All 6 capacity rules went `firing`, health ok (value 1): memory 80/90, CPU, limits changed, no-writes, and load mismatch after a 3 h sim backfill (value 10.36 > 5; it stayed inactive while sent = written = 5149 = 0%). Re-push with the committed thresholds: memory x2, CPU, no-writes resolved; mismatch went `pending` (real 10.36% vs 5, `for` 15m: correct); limits-changed stays firing until 30 min after my limit change (correct). |
| 4b | Contact point | **Pass with a note** (QA-CAP-06). A fresh Grafana has no contact point; the default policy receiver is `empty`, so alerts fire and notify nobody. With a webhook set as the default contact point, firing and resolved notifications arrived per alert (`status=firing` 21:57:03, `resolved` 21:57:23 to 21:57:33). |
| 4c | Provenance | **Pass.** Rules are `provenance: api`. The path the UI uses (`POST` and `DELETE /api/ruler/grafana/api/v1/rules/fleetscope[/group]`) returns 400 "request affects resources created via provisioning API". (The provisioning API itself can edit them, as intended.) |
| 5 | Billing | **Partly verified.** Key in `.env.cloud` works: `usageCost` 200, one date (2026-10-24) with 17.85 CHC = `grandTotalCHC` 17.85. By hand the panels should show: used 17.85, left 300 - 17.85 = 282.15, run-out "Not available" (the projection uses only full days before today; there is none yet), per-day chart one point. **Not verified in Grafana**: I pushed without the key (see below) because the billing URL fix (933cce9) landed mid-pass, so the panels were not rendered against the live API. Keyless behaviour: push prints the note `billing data source is skipped`, and skips both billing rules with a note; billing panels stay without a data source. |
| 6 | `grafana:check` | **Mostly pass.** On a scratch copy of HEAD: edited capacity panel SQL fails; wrong `-- snippet:` marker fails; an extra target B with arbitrary SQL on a capacity panel fails; edited SQL in the state-timeline panel fails; capacity colours on Overview (fixed colour), Browsers (override) and Sessions (lower-case hex) fail with a clear message; `custom.lineStyle` dash and dot fail on Capacity and on Overview. Whitespace-only and comment-only edits pass (intended). **Gap:** an edited annotation query on the Capacity dashboard passes (QA-CAP-01). |
| 7 | Full checks | `pnpm lint && pnpm typecheck && pnpm test --concurrency=2`: green (grafana-tools 322, db 100, api 272, schema 347, collector 164, demo-site 106, fleet-runner 249 + 20 skipped, simulator 25), re-run after the review commits. `pnpm test:integration`: green (api 91, db 327), run while review fixes were still uncommitted in the working tree; the 2 new QA tests pass on their own after the commits. |

## Bugs and observations

### QA-CAP-01 (minor, platform) The Capacity annotation query is not protected by the snippet-copy check
Repro: in the scratch copy of `fleetscope-capacity.json` change the "Scaling changes" annotation `rawSql` (`n > 1` to `n > 0`), run `grafana:check --static-only`: exit 0, the edited query is accepted. Expected: fail like a panel (same as RV-CAP-11 in `reviews/capacity.md`). File: `infra/grafana/src/check.ts` (`requireCopy` only for `kind === "panel"`). Open, not being fixed per the lead's list.

### QA-CAP-03 (minor, backend/docs) Any backfill older than an hour fires `fs-capacity-load-mismatch`
Repro: `pnpm sim run --sessions 60 --duration 3h` against a local API; `capacity-alerts-load-mismatch-pct` = 10.36 (> 5). The same run over 20 min leaves it at 0 (all inside the 60-minute window). Cause: sent is placed by event `ts`, written by arrival time, so a backfill moves rows between hours. The README explains this per minute and recommends reading the alert over an hour, but not that `db:seed` and `sim run --duration > ~1h` (and a live fleet after a long outage replaying a dead-letter file) trip the alert on Cloud too. Suggest one sentence in the alert description and the README. Not a code defect.

### QA-CAP-04 (cosmetic, dashboard) A container recreate renames the replica
Local replica name is the container id, so recreating the service shows two utilization series (`a154d843f90e`, `ef02e463cb4f`). No false "replicas 1 -> 2" appeared (no minute overlapped), but a minute with both would. Expected on real autoscaling; nothing to fix, mention in the dashboard text if it confuses.

### QA-CAP-05 (major at HEAD, now **being fixed** in 8c05104; not re-tested)
At `b8d54bc` `grafana_ro` could read the whole `part_log`: 88 database names, `path_on_disk` (8,641 rows), and `exception` text (148 rows). Same as RV-CAP-04. Re-test needed against the column-level grants.

### QA-CAP-06 (minor, platform/docs) Alerts have no recipient on a fresh Grafana OSS
Both Grafana 13.2.4 instances checked (throwaway and :3001) have zero contact points and a default policy receiver `empty`, so the capacity alerts fire into nothing locally. On Grafana Cloud the default is the owner's email, which was not checked (no Cloud access). Document in `infra/grafana/README.md` that local alert delivery needs a contact point.

### QA-CAP-07 (info, backend) `capacity-load` errors when `from` is after `to`
`WITH FILL TO value cannot be less than FROM value` (INVALID_WITH_FILL_EXPRESSION). Grafana's picker cannot produce it, so no action unless the dashboard is used through the API with a reversed range.

### Being fixed, not re-tested
Billing alert URL, billing group emptied by a keyless push (the throwaway push at HEAD created the billing group with 0 rules, consistent with RV-CAP-02), memory alert window (the 1 s peak keeps `for` satisfied), column-level grants. Billing panels against the live API through Grafana still need one check after 933cce9.

## Verdict
**Not ready to merge** until the being-fixed items are re-tested: QA-CAP-05 (grants, was major), and the review's blockers RV-CAP-01 to RV-CAP-04. Nothing else open is a blocker or major: QA-CAP-01, 03, 04, 06, 07 are minor or informational. The core measurements (sent vs written, dedup, utilization against limits, scaling annotation, alert fire/resolve, provenance, `grafana:check` rules) all passed against hand-computed numbers.

## Round 2 (billing, throwaway Grafana 13.2.4, real read-only key)

Scope cut by the lead to billing only. Tested at `31b45c4`. Throwaway Grafana removed afterwards; no secret printed; the three billing variables were read from `.env.cloud` by name only (the rest of that file, which points at Cloud ClickHouse, was not loaded).

| Item | Result |
|------|--------|
| (a) Billing panels vs direct `usageCost` | **Pass.** Pushed with the key (data source URL is `https://api.clickhouse.cloud/v1/organizations/<org>`, panel URLs are `/usageCost`, no `${ch_org}`). Queried the 4 panels through `/api/ds/query`: used 18.2 credits, left 281.8, per-day chart one point (2026-10-24, 18.2), run-out "Not available". Direct call summed per date: `{2026-10-24: 18.2}`, grand 18.2, 300 - 18.2 = 281.8. Run-out is "Not available" by hand too (no full day before today). The run-out arithmetic with real multi-day data is still untested. |
| (b) Billing rules evaluate | **Pass.** Both rules `health ok`, state inactive, `execErrState: Error`, no `${` or `$__` in any model, query `/usageCost?from_date=2026-10-24&to_date=2026-11-23`. Immediate evaluation through `/api/v1/eval`: "below $50" gives 281.8; "runs out before the trial end" returns no data (no full day yet, `noDataState: OK`, so no false alert). |
| (c) Keyless push | **Pass.** A push without the three variables left the existing billing data source and both billing rules in place (`alerts Fleetscope billing unchanged (2 rule(s))`, note "What a Grafana already has is left as it is"). |

Not re-tested in Round 2 (lead's scope cut): the column grants, the 1-minute memory alert, `grafana:check`. For the record, in the same session before the cut: `pnpm db:grafana-user` left only column grants (`SELECT(event_time, hostname, metric, value)` on `asynchronous_metric_log`, `SELECT(database, error, event_time, event_type, rows, table)` on `part_log`, idempotent on a second run); all capacity snippets ran as `grafana_ro`; `exception`, `query_id`, `path_on_disk`, `partition` and `SELECT *` on both tables are denied, `count()` still works; `capacity-alerts-mem-pct-1m` returns a value (10.6) and `pnpm grafana:check` passed (5 dashboards, 2 alert groups, 84 queries). The "1 s spike does not fire, sustained load does" check was not run.

**Round 2 verdict: ready to merge from QA's side**, with two caveats the lead should accept knowingly: the 1-second-spike versus sustained-load behaviour of the 75/85 memory rule was not exercised end to end, and the run-out projection has only been seen in its "Not available" state.
