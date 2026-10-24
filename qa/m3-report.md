# QA report: M3 (multi-engine)

Branch `m3-multi-engine`, tested 2026-10-24 against the working tree (the engineers and the reviewer were editing in parallel, so a few findings below are about files that changed while I tested). Timebox 45 minutes, prioritised blockers and majors.

## Verdict

**Ready to merge: yes, with two minor items to fix first because they turn CI red** (QA-M3-01 lint, QA-M3-02 one simulator test). No blocker or major bug is open. Everything in the task list that I reached passes; what I did not reach is listed under "Not tested".

## Bugs

| ID | Severity | Owner | Where | Summary |
|---|---|---|---|---|
| QA-M3-01 | minor (CI red) | backend | `apps/fleet-runner/src/engines.ts` (lines 45 and 53) | `pnpm lint` fails: Biome wants the two digest-pinned `defaultImage` strings on their own line. `pnpm biome format --write apps/fleet-runner/src/engines.ts`. The file was being edited (digest pinning) while I tested, so it may already be fixed. |
| QA-M3-02 | minor (CI red) | backend | `apps/simulator/src/simulator.test.ts:417` (R-M3-12), `apps/simulator/src/profile.ts` / the committed profile | `the profile > Lightpanda's engine_version is not a Chrome version` fails: the profile still has `124.0.6367.29` for Lightpanda. The same wrong value is in 5 real Lightpanda sessions in my dev database, all from 14:27 to 14:29, **before** the engine-version fix; every Lightpanda session since reports `1.0.2`, so the runner is fixed and the simulator profile is not. The reviewer already has this as R-M3-12. |
| QA-M3-03 | minor | backend | `apps/simulator/src/cli.ts` (`live`) | After Ctrl+C, `sim live` ends with exit code 0 (driven through the registered SIGINT handler). `fleet run` exits 130 for the same case. Not wrong, but shell scripts cannot tell "stopped by the user" from "finished". Suggest 130, or document 0. |
| QA-M3-04 | minor | dashboard | `infra/grafana/dashboards/fleetscope-browsers.json`, `infra/grafana/src/check.ts` | `grafana:check` prints 3 warnings: the three bar gauges (Time to usable browser, Peak memory, p95 action latency) use `rowsToFields`, so the check cannot verify the column names they select. A renamed column in the table would blank them with no error. My new tests assert those columns exist (engine, `time_to_browser_p50_ms`, `peak_mem_mib_p50`, `action_p95_ms`), which covers the gap for now. |
| QA-M3-05 | minor | dashboard | `fleetscope-browsers.json` panels 1 and 5 | At 1440 px the Engine comparison table and the matrix do not fit: "Action p95" is cut off and "Est. cost / 1k", "JS heap" and "Sim %" need horizontal scrolling, so Lightpanda's "Not available" is not visible at that width. At 1920 px everything is there. Suggest narrower columns or a shorter header set. |
| QA-M3-06 | minor (test code, fixed by me) | qa | `apps/fleet-runner/src/real-run.e2e.test.ts` | The opt-in real-Chromium tests used the pre-M3 image `playwright-chromium:1.64.1` and no forwarder, so after M3 `localhost:3100` was unreachable in the browser (`ERR_CONNECTION_REFUSED`). Now they use `1.64.1-2` and start the `fleetscope/forwarder:1` sidecar. Not a product bug, but anyone who runs the old test file will get this error. |

Observations (not bugs):

- **Startup is slow under load.** In the 3-engine run, "startup" was 5 to 23 s per session at concurrency 3 and the average time to browser was 12 to 13 s. Other agents' containers and the live loop were running at the same time. It also shows on the Browsers dashboard (Chromium p50 11.8 s). Do not read engine startup differences from this machine's numbers.
- **Chrome engines sometimes have a null heap sample** (3 of 42 CDP samples on Chromium and headless-shell, on heavy pages): honest nulls, and the dashboard treats an engine as "JS heap: Available" when any session has a value.
- **A parallel `pnpm test` is not reliable on this machine.** With everything in parallel the process aborted (exit 134) and 5 API tests timed out at 7.5 s. Run per package, all green (below).
- `docker.ts` has a comment naming the sidecar image `fleetscope/forwarder:1-1`; the tag is `1`. Cosmetic.
- The `sim live` events that are in flight when you press Ctrl+C get timestamps up to about 3 s after the stop time (the simulated session end). They are accepted by the API (skew limit is 5 minutes).

## Task list, one by one

### 1. Tests flipped or changed

- `collector.http.test.ts`: both QA-M1-03 tests are now normal tests and pass.
- `real-run.e2e.test.ts`: QA-M1-03 on `/js-heavy` is a normal test; with `FLEET_E2E=1` it and the missing-API test pass (see QA-M3-06 for the harness fix).
- `links.qa.test.ts`: expects 4 dashboards. The file had CRLF line endings; converted to LF and formatted with Biome as the lead asked. `pnpm lint:root` is green.
- The `dashboards.numbers` `session-facts` copy check passes (no change needed).
- Passwords: the literals are gone from `dashboards.numbers`, `dashboards.edge`, `grafana-user.m2` (now `testPassword()` from `@fleetscope/db/testing`) and from `push.qa.test.ts` / `push.test.ts` (`testPassword()` from `test-fixtures`; the `glsa_...` tokens are `glsa_${testPassword()}`). Left as they are because they are plainly wrong values: `definitely-wrong`, `definitely-not-the-password`, `wrong`, `short`, and the fake `secret` in `app.test.ts` / `app.edge.test.ts` and `hunter2-secret` (a redaction test). `grafana_ro_dev_password` in `grafana-user.test.ts` is the documented dev default, not a secret.

### 2. Real three-engine run (`--seed 7`, run id `5942a2e0`, 18 sessions, 210 s)

| Check | Result |
|---|---|
| Every scenario on every engine | **yes**: 2 sessions for each of the 9 cells (3 scenarios x 3 engines) |
| Outcomes | 15 success, 2 failed, 1 blocked. The 2 failed are Lightpanda `heavy-page-crawl` ("webWorker: timeout after 3000ms"): action `unsupported_api` plus an `unsupported_api` issue, as designed. The blocked one is a Chromium `checkout-form` hitting the botwall (HTTP 403), expected from the scenario |
| Lightpanda `js_heap_mb` | **null in all 12 CDP samples, 0 zeros.** Headless-shell and Chromium have values (3 honest nulls, see observations). Lightpanda and the two Chrome engines have container samples with CPU and memory, and CDP samples with cpu and memory null |
| Sidecar-free memory | The Lightpanda sessions peaked at 6 to 17 MB, below what the 8.7 MB forwarder container alone plus a browser would show; Chromium 188 to 436 MB. The sampler code selects the container by label `fleetscope.role=browser` (unit-tested in `docker.sidecar.test.ts`). I could not read the sampled container id from the database, so this is indirect evidence |
| Containers left | **none** for run `5942a2e0` (`docker ps -a --filter label=fleetscope.session --filter label=fleetscope.run=5942a2e0` is empty) |
| Events | 635 sent, 0 duplicates, 0 dropped |
| Ctrl+C on a 3-engine run | New opt-in test `Ctrl+C on a three-engine run (M3)` in `real-run.e2e.test.ts` (SIGINT driven through the CLI's handler, 30 sessions, concurrency 3, `heavy-page-crawl`): exit 130, "not started (interrupted)" printed, no session left `running`, every non-success session `failed` with reason `interrupted` or the Lightpanda web-worker failure, **no `crash` issue**, **no container (browser or forwarder) left for that run id**. Passes (27 s). The old `expectTidy` checked every container with a session label, which now fails whenever another run (the live loop) is going on, so it filters by run id |

### 3. Numbers (new file `packages/db/src/m3.numbers.integration.test.ts`, 17 tests)

A fresh database, a fleet of 13 real sessions (Chromium 4, headless-shell 4, Lightpanda 5; one interrupted; one with an unpriced provider; null heaps; one Lightpanda session with no samples) and 4 sim sessions. The table of every session and the arithmetic is at the top of the file. The harness (`packages/db/fixtures/dashboards.ts`) now knows the `browsers` dashboard and runs its panels as the read-only user.

- **Engine comparison**, per engine: sessions (3, 4, 5), success rate (66.67, 75, 40), p50 time to browser (2000, 2000, 200 ms), peak memory p50 (300; 80 to 90; 25 to 30 MiB), cost per 1000 sessions from the browser-hours (Chromium and Lightpanda checked to 9 decimals; headless-shell is NULL because one session has no price: never a partial sum), `js_heap_available` (1, 1, **0**). Chromium's interrupted session leaves every number except action latency (its 1000 ms action is in p95, as the README says). The Lightpanda session without samples is left out of the median, not counted as 0 (the assertion would fail at 15 MiB if it were).
- **Compatibility matrix**: the panel is the README query pivoted to one row per scenario and three columns per engine. All 9 cells match: counts 1/1/0, 0/0/2, 2/3/3; rates; top causes `timeout`, `unsupported_feature`, `unsupported_api`, `unsupported_feature`; an engine that did not run a scenario gives `n = 0` and a NULL rate (not 0 %). The cells add up to the 12 sessions of the comparison.
- **Bar gauges**: they read the table; engine and value columns are present and ordered.
- **Time series**: memory per container per minute is `(100+300)/2 = 200` Chromium, `85` headless-shell, `10` Lightpanda (its null-heap CDP sample does not dilute the average), and an engine with no container sample has **no row, never 0**. The p95 latency series stays within the Lightpanda actions (20 to 70 ms) with an engine filter.
- **R-M2-18 lower bound**: a session that started 3 days before the range and ended in it is excluded; one that started 23 hours before is kept (1 session, 100 %, time to browser 2000 ms, cost for 23 h 10 min); a range that starts a day later brings the 23-hour session out of scope; the Overview verdict agrees (1 ended, 0 started). The running 3-day and 23-hour zombies have no visible number on any panel I could read, so the "running" half is not asserted.
- **Push-down**: an engine filter returns exactly the unfiltered row of that engine, for the comparison (each engine, and two together), the matrix, and the sim facts.
- **Empty range**: no rows, and the panels have their "No sessions ended in this range" text.

### 4. Simulator

- `sim run --sessions 300 --duration 1h`: 10,486 events in 11 batches, 2.5 s; engines 101 / 99 / 100. In ClickHouse: all `source = sim`, none `running`, none with `ended_at` before `started_at` or an ended session without an end time, zero duplicate event ids; Lightpanda has 781 CDP samples, all with null heap, 0 zeros; Chromium and headless-shell have values. Lightpanda has the only `timeout` sessions (6) and the most failures (96 of 198 ended), consistent with the calibrated priors.
- `sim live --rate 30`, 60 s, then SIGINT through the handler: "stopping, sending the sessions in flight", 29 sessions, 1059 events; in the database 29 sessions (19 success, 10 failed, timeout or blocked), **none `running`** (and none anywhere for `source = sim`). Exit code 0 (QA-M3-03).
- Not checked: that the calibrated profile reproduces the real distributions (that is `sim calibrate`'s own test).

### 5. Grafana

- `pnpm grafana:check`: **4 dashboards OK, 64 queries**, with the 3 warnings of QA-M3-04.
- Browsers dashboard rendered in the real Grafana (the dev one on :3001, Chrome, 1920 and 1440 px, last 3 hours, source real): no page errors; the comparison table shows 14 / 25 / 24 sessions, success 100 / 96 / 70.8 %, and the **JS heap column: "Available" for Chromium and headless-shell, "Not available" for Lightpanda**; the Lightpanda peak memory bar is small but present (11 MiB); the matrix has its Sim % and Top cause columns, and its links go to `/d/fleetscope-sessions?...&var-engine=<engine>&var-scenario=<scenario>&var-source=real` with the time range kept (I read all of them from the page; I did not click through each). See QA-M3-05 for the 1440 px layout.

## Run log

- `pnpm lint:root`: green. `pnpm lint`: **red only for QA-M3-01** (`engines.ts`, not my file); I formatted `options.test.ts` and my files.
- `pnpm typecheck`: green (8 of 8).
- `pnpm test` (run per package because the parallel run crashed, see observations): schema 344, grafana-tools 191, db 87, api 271, demo-site 106, collector 163, fleet-runner 151 (+20 skipped without `FLEET_E2E`), simulator 24 of 25 (**QA-M3-02**).
- `pnpm test:integration`: db 268 passed (15 files, including the 17 new tests); api 75 passed.
- Opt-in `FLEET_E2E=1`: the two `/js-heavy` tests and the 3-engine Ctrl+C test pass. I did not re-run the older opt-in tests (they may need the same image and forwarder change as QA-M3-06).

## Not tested

- The 3-engine run on a clean machine (timing); startup times are polluted by other containers.
- A real console Ctrl+C on `fleet run` and `sim live` (still the handler, as in M1).
- `pnpm fleet traffic`: not run by me (the lead's live loop uses it).
- The `Fleet smoke (all engines)` CI job (needs a pushed branch).
- The sim vs real number comparison, the 10k-session Browsers dashboard timing, light theme, Grafana Cloud.
- Screenshots of the other 3 dashboards after the M3 changes beyond what `grafana:check` and the number tests cover; the Overview By engine "memory NULL, not 0" is covered by the existing M2 number tests plus the memory time-series test above, not by a new By engine test.
- The "running" zombie sessions (no panel exposes the count I could assert).
