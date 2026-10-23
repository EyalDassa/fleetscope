# QA report: M1 first real data

Branch `m1-first-real-data`, first QA pass. Environment: Windows 11, Git Bash, Node 22.17, pnpm 12.15, Docker Desktop 29 (data disk on D:), ClickHouse 26.8.34.13 (the pinned compose image), browser image `fleetscope/playwright-chromium:1.64.1`, Chromium 156.0.8078.4.

Tested against the PR description (decisions, contracts, "done when"), PLAN.md sections 3 to 6, ADR 0002, `design/DESIGN.md` where it says what the data must support, and the three READMEs, not against what the code happens to do. The reviewer's file `reviews/m1.md` was not read or touched.

## Verdict, first pass: NOT READY

M1's headline works. Real Chromium sessions land in ClickHouse with actions, container samples, CDP heap samples and sampled network requests, a ClickHouse outage loses and duplicates nothing, the same `--seed` repeats exactly, nothing is left running. Three **major** bugs are open, and all three are cheap to fix:

- **QA-M1-01 (major, backend-ingest):** one valid request can stall all ingest. A batch that touches more than 100 different days is refused by ClickHouse on every retry, so the buffer retries it forever and nothing else is stored. ADR 0002's premise "validated events should never be refused" is false.
- **QA-M1-02 (major, backend-fleet):** the runner's preflight does not notice a stopped API or demo site when they are addressed as `localhost` (the default). The run starts anyway. This is the exact check the brief and task C2 ask for.
- **QA-M1-05 (major, backend-fleet):** "every session gets container samples" is false under load. At `--concurrency 12`, 11 of 24 sessions had none; at 6, 2 of 12. Default concurrency 4 is fine. The lead may downgrade this if a supported concurrency is documented instead.

Everything else is minor or a nit. Details below.

## Done-when check (PR table)

| Task | Result |
|---|---|
| I1 ingest contract | pass |
| I2 `POST /v1/events` + buffer | pass, except QA-M1-01 and QA-M1-09. 202/400/413/415/503 + `Retry-After` verified over a real socket; flush on 1 s / 5k; dedupe layers 1 and 2 verified (below); orphan grace verified; graceful shutdown flushes (also through the real `server.ts` entry, see "Verified OK") |
| I3 db changes, migration 0006 | pass. Upgrade path from a real M0 database tested (new test) |
| I4 M0 leftovers | pass. FSTDEP023 gone; QA-M0-03 `it.todo` is now real tests |
| C1 collector | pass, except QA-M1-03 (forward-looking), QA-M1-04, QA-M1-08 |
| C2 fleet runner | pass, except QA-M1-02, QA-M1-05, QA-M1-08 |
| D1 demo site | pass. README contract spot-checked on a live server; `/js-heavy` throws one real page error per missing API (checked in a real Chromium with the APIs deleted) |
| P1 browser image | pass. `isSecureContext` is `true` on `http://localhost:3100` in the container. See QA-M1-10 for a README/code disagreement |
| P2 dev wiring | `pnpm fleet` works. `pnpm dev` not exercised (port 3000 belongs to something else) |
| P3 CI | `gh pr checks 4` below: green on head `e318b24`, including **Fleet smoke (Chromium)**. My commits are not pushed, so CI has not run the new tests yet |

## Data quality of a real run (ClickHouse, 12 sessions, seed 7, concurrency 4)

All checked with SQL on the real tables. The same checks are an automated, opt-in test (`real-run.e2e.test.ts`, 9 sessions, passes).

| Check | Result |
|---|---|
| Sessions | 12/12 `real`, `chromium`, `engine_version 156.0.8078.4`, region `local`, provider `local-docker`, all with `ended_at` and `duration_ms`. 9 success, 2 blocked (captcha), 1 failed (`flaky-button`) |
| Every event inside `[started_at, ended_at]` | 0 violations in actions, samples, network, issues. The `session.ended` ts is equal to or later than the last sample of every session |
| Event ids | 394 events, 394 distinct ids |
| Container samples | 20 rows, cpu 1 to 277 %, mem 192 to 431 MB, rx/tx deltas, never NULL; `js_heap_mb` always NULL. Gap between samples about 2.0 s |
| CDP samples | 34 rows, `js_heap_mb` up to 8.3 MB, the four container metrics always NULL |
| `network_requests` | exactly `ceil(requests / 5)` (checked against a real count of 100+ requests on `/heavy`), `status` and `bytes` set, `domain localhost`, types `document` and `image` |
| Actions | 129: 125 ok, 2 `selector_not_found`, 2 `captcha`. Min 1, max 18 per session (a blocked session stops at the wall, QA-M1-11). Average goto 236 ms |
| Issues for failures | blocked: 2 of 2 have a `captcha` issue. Failed: **0 of 1** has any issue row (QA-M1-06) |
| Seed repeatability | seed 7 with concurrency 4 and again with 6: same scenario order, same statuses, same reasons, same chaos (`botwall` seeds 189678 and 198083), same 129 actions |
| Leaked containers | none after every run, including Ctrl+C, a second Ctrl+C plus `cleanup`, a killed browser, a timeout and a demo site that was down |

## Tests added

All new files are mine; no existing test was weakened. Unit tests need no Docker or ClickHouse (the Docker-dependent ones skip themselves when Docker is down). Integration tests use `createTestDatabase()`.

| File | Kind | What it covers |
|---|---|---|
| `apps/api/src/ingest.abuse.integration.test.ts` | integration, 28 tests (2 `it.fails`) | **Real socket** (fetch to a listening Fastify) and real ClickHouse. 1000 vs 1001 events, body 1 character under and over 2 MiB, content types, nonsense bodies never 500. 20 parallel copies of one batch stored once; upper/mixed/lower-case ids inside and across batches; a duplicate arriving while the first copy is retrying. Skew at exactly +5 min and +5 min 1 ms, all-or-nothing, a good event next to a bad one is not "remembered". **TCP proxy between the API and ClickHouse**: the answer to INSERT 1, 2, 3, 4 and 5 lost after ClickHouse committed it (retry writes nothing twice), a request cut in the middle of a 1 MB body, an outage while events keep arriving (`/healthz` truthful, drains by itself, nothing lost), graceful shutdown during an outage (recovers inside the timeout; gives up and logs `lost: 3` after it). Poison batch (QA-M1-01). Orphaned `session.ended`: late start inside the grace, dropped and counted, resent end held once, reverse order in one request, orphans use buffer capacity. **10,000 sessions (70,000 events)** through the API with a 6,000-event buffer, 8 parallel senders, retrying on 503: every event exactly once, 4.1 s. A batch bigger than the buffer (QA-M1-09) |
| `apps/api/src/env.ingest.test.ts` | unit, 14 | `INGEST_BUFFER_CAPACITY`: default, bounds, junk, empty |
| `apps/api/src/ingest/recent-ids.slow.test.ts` | opt-in (`QA_SLOW=1`), 1 `it.fails` | QA-M1-07 |
| `packages/db/src/migrate.upgrade.integration.test.ts` | integration, 2 | An M0 database (0001 to 0005, with data) upgraded to 0006: data kept, window on, dedupe works, token-less inserts unchanged; a 0006 that fails halfway is not recorded and re-running finishes it |
| `packages/db/src/db.edge.integration.test.ts` | integration (edited) | The QA-M0-03 `it.todo` became 12 tests: for each of the 5 tables the INSERT fails before the write and after the write (lost answer), then a retry with the same tokens writes every row once; repeating a flush 3 times; the sharp edge (a token identifies the block, not its content) |
| `packages/collector/src/collector.http.test.ts` | unit, 16 (3 `it.fails`) | The collector against a **real HTTP server** that misbehaves: 400 (not retried, dropped and counted, later batches flow), 413, 503 + `Retry-After` (waits, resends the same event ids, nothing overtakes), 500 (backoff, recovery), permanent 500 (gives up, counts), connection destroyed after the server processed the batch (same ids on the resend), API gone and API hanging (`close()` bounded), slow API (100 actions in under 500 ms while every request takes 1.5 s), non-JSON 202. `isMissingApiError` messages (QA-M1-03) and stats right after `close()` (QA-M1-04) |
| `apps/fleet-runner/src/preflight.test.ts` | unit, 9 (2 `it.fails`) | `preflight()` with real sockets: ok, HTTP 503, hanging (3 s), connection refused on 127.0.0.1, Docker down (no image lookup), image missing, image lookup error, everything at once. QA-M1-02 with a faked Node error (machine independent) and with real `localhost` sockets (skipped where Node does not show the bug) |
| `apps/fleet-runner/src/cli.test.ts` | unit, 21 (1 `it.fails`), spawns the CLI | Exit code 2 and the usage for 14 bad command lines, `--help` exits 0, exit 1 for Docker unreachable / `DOCKER_HOST=banana` / missing image (exactly one problem listed) / `cleanup` without Docker; QA-M1-02 end to end. `cleanup` against real Docker only with `FLEET_E2E=1` (it removes every labelled container, including someone else's run). Adds about 20 s to the fleet-runner unit run |
| `apps/fleet-runner/src/stats.load.test.ts` | unit, 5 (2 `it.fails`) | QA-M1-05 with Docker's measured latency and the default stop timeout |
| `apps/fleet-runner/src/real-run.e2e.test.ts` | opt-in (`FLEET_E2E=1`), 15 (3 `it.fails`) | A real 9-session run checked in ClickHouse (table above), a second run with the same seed and a different concurrency, no leaked containers; runner-initiated timeouts (QA-M1-08); the collector with a real Chromium: network sampling ratio, CDP heap, `unsupported_api` from `/js-heavy` with APIs deleted (QA-M1-03) |

How to run the opt-in ones (turbo does not pass the variables on, so call vitest directly):

```
pnpm infra:up && pnpm db:migrate && pnpm browsers:build
pnpm --filter @fleetscope/api dev            # :4000
pnpm --filter @fleetscope/demo-site dev      # :3100
FLEET_E2E=1 pnpm --filter @fleetscope/fleet-runner exec vitest run src/real-run.e2e.test.ts
FLEET_E2E=1 pnpm --filter @fleetscope/fleet-runner exec vitest run src/cli.test.ts -t cleanup
QA_SLOW=1   pnpm --filter @fleetscope/api exec vitest run src/ingest/recent-ids.slow.test.ts
```

Open bugs are encoded as `it.fails("QA-M1-NN: ...")` as in M0: they pass while the bug exists and fail when it is fixed, then QA flips them to plain `it`. Engineers must not edit these files; ask QA.

Also done by hand, not automated: `docker stop` / `docker start` of ClickHouse while posting (below), Ctrl+C and a second Ctrl+C, a container killed with `docker kill`, the demo site stopped, the real `server.ts` shutdown, and the scale measurements for QA-M1-05 and QA-M1-07.

## Bugs

### QA-M1-01 (major, backend-ingest): one valid request can stall all ingest (a batch over more than 100 days is refused by ClickHouse forever)

- **File:** `apps/api/src/ingest/validate.ts` (no lower bound on `ts`), `apps/api/src/ingest/buffer.ts` (retries a refused flush forever).
- **Steps:** `POST /v1/events` with 120 valid actions whose `ts` is `now - i days` for `i = 0..119` (202). Then `POST` an ordinary session (202).
- **Expected:** a valid event is stored or answered with a clear 4xx. One client cannot stop the others. ADR 0002: "Validated events should never be refused."
- **Actual:** ClickHouse answers `Too many partitions for single INSERT block (more than 100)` (`max_partitions_per_insert_block`) to the flush, every time. The buffer retries the same flush forever: `/healthz` shows `ingest.retrying: true`, the ordinary session is never stored, the queue fills to capacity and the API starts answering 503 to everybody. The only way out is a restart, which throws away everything that was accepted and not yet written. The flush holds the events of ALL clients (up to 5000), so more than 100 distinct days can also come from many small requests of old events. Reproduced over a real socket and directly with `insertEvents`.
- **Related, same cause:** the API accepts any `ts` from 2020 onward, so an event older than the 30 day TTL gets `202` and is deleted by the TTL a moment later (silent loss; documented by a passing test). A client with a clock 40 days behind loses everything and is never told.
- **Judgement on the "known design choice":** retrying a refused flush forever (visible stall instead of silent drop) is defensible when refusals are rare and operator-fixable. That is not the case here, because a client can cause it with one valid request.
- **Suggested fix:** in `checkBatch`, reject (400, name the indexes) a `ts` older than the retention window (30 days, the TTL), as it already does for the future; that also bounds a flush to about 31 partitions. Optionally, when a flush fails with a non-transient ClickHouse error, split it (halves) so one bad group cannot hold the rest, and log what was dropped.
- **Test:** `ingest.abuse.integration.test.ts`, `it.fails("QA-M1-01: ...")`, plus a passing test that records the stall (`/healthz`, 202 until full, then 503).

### QA-M1-02 (major, backend-fleet): preflight does not notice a stopped API or demo site on `localhost`

- **File:** `apps/fleet-runner/src/preflight.ts`, `fetchOk()` and `if (problem)`.
- **Steps:** with the API and the demo site stopped, run `pnpm fleet run --sessions 2` (defaults: `http://localhost:4000`, `http://localhost:3100`). Or `FLEETSCOPE_API_URL=http://localhost:4999 DEMO_SITE_URL=http://localhost:3999 DOCKER_HOST=tcp://127.0.0.1:1 pnpm fleet run`.
- **Expected:** `Cannot start the run:` and one line each for the API, the demo site and Docker, exit 1, nothing started (C2 "checks /healthz + demo site first"; the brief: "preflight must list all problems").
- **Actual:** only Docker is listed (or, with Docker up, nothing at all and the run starts). With the API down the sessions ran for 19 s, then `events: 0 sent, 88 dropped`, exit 1. With the demo site down both sessions failed on the first `goto` (`net::ERR_EMPTY_RESPONSE`) and the run exited 0. Cause: `localhost` resolves to `::1` and `127.0.0.1`; when both refuse, Node's `fetch` fails with an `AggregateError` whose `message` is `""`. `fetchOk` returns that empty string and `if (problem)` treats it as success. With `127.0.0.1` literals the message is non-empty and the check works. There was no test for `preflight`.
- **Suggested fix:** build the reason from `cause.code` / `cause.errors[0]?.message` / `error.message` so it is never empty, and test `problem !== null`.
- **Tests:** `preflight.test.ts` (faked Node error, always runs; real sockets, where Node shows it) and `cli.test.ts`, `it.fails("QA-M1-02: ...")`.

### QA-M1-05 (major, backend-fleet): sessions without any container sample when Docker is slow

- **File:** `apps/fleet-runner/src/stats.ts` (`stopTimeoutMs` default 2500), `session-runner.ts` (`finishSession`).
- **Steps:** `pnpm fleet run --sessions 24 --concurrency 12 --scenario login-and-search --seed 3`, then count container samples per session.
- **Expected:** every session has at least one container sample (commit 22ea181, and the PR: "container `resource.sample` rows every ~2 s during the session").
- **Actual:** 11 of 24 sessions had none (46 %). Concurrency 6: 2 of 12. Concurrency 4 (default): 0 of 12. Concurrency 3: 0 of 9. Concurrency 8: 0 of 16 (borderline). Cause, measured: Docker's `stats({stream:false})` takes 2.0 s on an idle machine with 4 containers, and with 12 sessions running p50 3.4 s, p90 6.6 s, max 9.9 s (15 of 28 readings above 2.5 s). `StatsPoller.stop()` waits 2.5 s for the reading in progress and then drops it. Nothing is logged and the summary just shows `-` under peak memory.
- **Why major:** PLAN's own example is `--concurrency 8`. The loss is biased: fast, short sessions (exactly what Lightpanda will be) lose their memory number, so "memory per session" on the Browsers page (M3) is skewed toward slow sessions.
- **Suggested fix:** wait longer in `stop()` (the reading is at most about 10 s), or take the last reading with Docker's `one-shot` stats, and log a warning when a session ends without a container sample so the gap is visible.
- **Test:** `stats.load.test.ts`, two `it.fails("QA-M1-05: ...")` (reading takes 4.5 s and 6.6 s, default settings). The 2.4 s and 3.4 s cases pass.

### QA-M1-06 (minor, decision needed: lead / backend-fleet / frontend): a failed session can have no `issues` row

- **File:** `packages/collector/src/codes.ts` (`ISSUE_FOR_CODE.selector_not_found = null`), PLAN section 5 (the six issue kinds).
- **Reasoning for the lead's question.** The cause *is* answerable from the data: `sessions.reason` ("selector not found: [data-testid="flaky-button"] (page.click: Timeout 1500ms exceeded.)") and the failed `actions` row (`click`, `error_code selector_not_found`, `seq`, duration). DESIGN section 6.8 (root-cause banner: "action #9 click ...", error code and message) can be built from those two. So "why did session X fail" is not unanswerable, and I do not call it a defect of the collector against PLAN. But three DESIGN/PLAN surfaces read the `issues` table and will be empty for the one organic Chromium failure the demo has: the Issues panel (6.10, "one block per issue"), "Top issue" in the By-engine table, and `find_issues` / Insights. `sessions` has no reason *code* column, so the "Recent failures" row ("reason code in mono + message") also has no source unless M2 joins `actions`. In the real run: 1 of 1 failed session has no issue (blocked: 2 of 2 have one).
- **Decision needed before M2:** (a) add a kind (for example `element_missing`) to `IssueKind` and map `selector_not_found` and `js_error` to it, or (b) write down in the M2 contract that the failure cause comes from the first failed action's `error_code` plus `sessions.reason`, and that `find_issues` / the Issues panel include failed actions. I lean to (b) for M2 (smaller, no schema change) and (a) if the Issues panel must be the single place for causes.
- **Test:** `real-run.e2e.test.ts`, `it.fails("QA-M1-06: every failed session has at least one issue row")`. Delete it if the lead picks (b).

### QA-M1-08 (minor, backend-fleet): a timeout or Ctrl+C is recorded as a `crash`

- **File:** `apps/fleet-runner/src/session-runner.ts` (closes the browser on timeout / abort), `packages/collector/src/errors.ts` + `page.ts` (`browser_closed` becomes a `crash` issue).
- **Steps:** `pnpm fleet run --sessions 3 --scenario heavy-page-crawl --session-timeout 3`, or Ctrl+C mid-run.
- **Expected:** status `timeout` (or `failed`/`interrupted`) and no crash: nothing crashed, the runner closed the browser on purpose.
- **Actual:** status and reason are right, but the cut-off action gets `error_code browser_closed` and an `issues` row `crash` ("page.goto: Target page, context or browser has been closed"). A `timeout` session with a `crash` issue contradicts itself, and Insights' crash counts would include every Ctrl+C. (A browser that really dies, `docker kill` mid-session, gives status `crashed` and one `crash` issue: correct.)
- **Suggested fix:** let the runner tell the session it is shutting the browser down (for example `session.beginShutdown()` before `closeBrowser()`), and have the collector skip the crash issue and record the action as `timeout` / `interrupted` after that.
- **Test:** `real-run.e2e.test.ts`, `it.fails("QA-M1-08: ...")`.

### QA-M1-04 (minor, backend-fleet): `stats()` right after `close()` under-counts the lost batch

- **File:** `packages/collector/src/queue.ts`, `close()`.
- **Steps:** an API that accepts the connection and never answers; `await collector.close(500)`; read `collector.stats()`.
- **Expected:** `dropped` is final when `close()` returns.
- **Actual:** `{ sent: 0, dropped: 0, pending: 4 }` at once, `dropped: 4` a moment later (the aborted request settles after `close()` has returned). The runner reads `stats()` right after `close()`, so its summary prints "0 dropped" and the exit code stays 0 although events were lost. With the API refusing connections the abort settles first, so that case looks right (88 dropped, exit 1).
- **Suggested fix:** in `close()`, after aborting, await the drain loop (it ends as soon as the abort lands) before returning.
- **Test:** `collector.http.test.ts`, `it.fails("QA-M1-04: ...")`; the eventual-count test passes.

### QA-M1-03 (minor, backend-fleet; matters from M3): a missing `crypto.subtle` is not an `unsupported_api` issue

- **File:** `packages/collector/src/errors.ts`, `isMissingApiError`.
- **Steps:** on `/js-heavy`, remove `crypto.subtle` (what a missing WebCrypto looks like). The page throws `TypeError: Cannot read properties of undefined (reading 'digest')`, exactly the message in the demo-site README.
- **Expected:** `unsupported_api` issue, like for `IntersectionObserver`, `ResizeObserver`, `Worker`, `requestIdleCallback` (all four verified in a real Chromium: one issue each).
- **Actual:** no issue. The check accepts `ReferenceError` and "is not defined" only. "X is not a constructor" is missed too. The WebCrypto gap would not appear in the Lightpanda compatibility matrix.
- **Note:** a general "Cannot read properties of undefined" rule would also catch real page bugs. A probe (`typeof crypto?.subtle`) or a short list of known API names is safer. Not urgent for M1 (Chromium has all five APIs).
- **Tests:** `collector.http.test.ts` (2 `it.fails`) and `real-run.e2e.test.ts` (1 `it.fails`).

### QA-M1-07 (minor, backend-ingest): the dedupe window gets slow once it is full

- **File:** `apps/api/src/ingest/recent-ids.ts` (`dropOldest`, `expire`: `seen.keys().next()` plus `delete` on a `Map`).
- **Steps:** `QA_SLOW=1 pnpm --filter @fleetscope/api exec vitest run src/ingest/recent-ids.slow.test.ts`.
- **Expected:** a flat cost per event (ADR 0002 sizes the window for 1,000,000 ids).
- **Actual:** filling is cheap (1.5 µs per event). Once ids are evicted (by count or by the 15 min age) the cost per event climbs in a sawtooth: with a 100,000-id window 17 µs rising to 325 µs, over and over (V8 leaves holes at the front of the Map that every `keys().next()` skips). At 3,000 events/s with the default 1M window the average over the first 224k evictions was about 200 µs per event. `offer()` runs on the request path, so a 1000-event request can block the event loop for up to 0.3 s once the window holds about 100k ids (about 110 events/s sustained over 15 min). Memory is as the ADR says (about 110 MB for 1M ids).
- **Why only minor:** the plan's loads (10 to 40 sessions, a simulator of 500 sessions in 10 minutes) are a few events per second. It is real at the ADR's own design point.
- **Suggested fix:** keep the order in an array queue with a head index (or two rotating `Set`s), and use the `Map`/`Set` only for membership.
- **Test:** opt-in `recent-ids.slow.test.ts`, `it.fails` (about 30 s).

### QA-M1-09 (minor/nit, backend-ingest): a batch bigger than the buffer is told "retry later" forever

- **File:** `apps/api/src/env.ts` (`INGEST_BUFFER_CAPACITY` accepts 1 and up), `apps/api/src/ingest/buffer.ts` (`offer`).
- **Steps:** capacity 500, `POST` 600 events.
- **Expected:** a clear answer that cannot succeed (413 or 400), or a capacity floor of 1000 in `env.ts`.
- **Actual:** 503 + `Retry-After` while the buffer is empty. The collector retries 8 times (about a minute) and drops the batch. Only reachable by setting the variable below 1000.
- **Test:** `ingest.abuse.integration.test.ts`, `it.fails("QA-M1-09: ...")`.

### QA-M1-10 (minor, needs a decision: backend-fleet / platform): `IpcMode: "host"` contradicts the browser README

- **Files:** `apps/fleet-runner/src/docker.ts` (`HostConfig.IpcMode: "host"`, pinned by `docker.test.ts`), `infra/browsers/README.md` ("`--ipc=host` ... is not needed ... and it would share one IPC namespace between concurrent sessions").
- **Actual:** confirmed with `docker inspect` on a started container: `IpcMode host`, and `/dev/shm` is the VM's shared 3.9 GB tmpfs. The README's own table of what the runner should set has no IPC entry. So sessions share an IPC namespace (and shared memory they use is not in their own cgroup), which Decision 1 ("clean CPU/memory attribution, no state leaking between sessions") says they do not, and which is a hardening step back for browsers that will visit untrusted pages. Playwright's launch flags already move shared memory off `/dev/shm`, as the README says.
- **Needed:** either remove `IpcMode` (and the test line) or update the README and say why it is needed. No test added.

### QA-M1-11 (nit, backend-fleet / lead): "each session has at least 5 actions" does not hold for blocked sessions

- **File:** `apps/fleet-runner/src/scenarios/checkout-form.ts` (the bot wall is the first page, 20 % of `checkout-form` sessions).
- **Actual:** a blocked session has exactly 1 action. In the 12-session real run: 2 of 12 (seed 7). The lead's seed 42 run had none, so "every session has at least 8 actions" held there. The unit test "makes at least 5 actions" covers the success path.
- **Suggested:** reword the done-when ("each session that ran its scenario"), or visit two or three pages before the wall. The e2e test asserts at least 5 for non-blocked and at least 1 for blocked sessions.

## Observations (behaviour recorded, no action asked)

- **Verified OK, the lead's list.** Duplicate ids inside and across batches and upper-case ids: counted, stored once. 1000 vs 1001 events: 202 vs 413. Skew exactly +5 min accepted, +5 min 1 ms refused. Full buffer: 503 with `Retry-After: 2`, nothing queued from that request, the same events accepted later. Orphan end held 60 s (configurable), stored when its start arrives, dropped and counted when it does not. Collector: 400 and 413 never retried, 503/500/network errors retried with the same event ids, `close()` bounded for a dead and for a hanging API, a slow API does not slow the scenario, CDP unavailable gives one null sample and no crash (unit and real Chromium). Runner: `--sessions 0`, bad engine, bad numbers, unknown flags: exit 2 with the usage; Docker unreachable (bad `DOCKER_HOST`, a missing pipe, `banana`): clean message, exit 1; image missing: one line with the build command; `--concurrency` above `--sessions` is clamped; Ctrl+C: running sessions end `failed`/`interrupted`, not-yet-started ones are skipped, no container left, exit 130 in 3 s; a second Ctrl+C exits 130 at once and `pnpm fleet cleanup` removes the leftovers (and is safe to repeat); a killed browser gives `crashed`; a session timeout gives `timeout`; seed repeats exactly.
- **ClickHouse stopped for real** (`docker stop fleetscope-clickhouse-1`, 7 s, `docker start`): batches B (52 events) and C (32) accepted while it was down, `/healthz` 503 with `retrying: true`, `queued: 84`, `lastFlushError "AggregateError ECONNREFUSED"`, a client resend of B counted as 52 duplicates; recovered 13 s after the start; 3 sessions, 100 actions, no loss, no duplicates; a resend after recovery was still recognised. The container is healthy again.
- **Graceful shutdown through the real `server.ts`** (SIGINT before the 1 s timer fired): the 52 events were flushed, then the process exited by itself with code 0 about 0.9 s later. (Real SIGTERM cannot be sent to a Windows process; the handler is the same function.)
- **Poison batch policy.** Record as asked: a batch ClickHouse always refuses stalls the whole buffer until a restart, and the restart loses the queue. As a policy it is acceptable only if refusals cannot be caused by a client; QA-M1-01 shows they can. After that is fixed I would leave the policy as it is.
- **`/healthz` is 503 while ClickHouse is down although the API is holding acknowledged events.** An orchestrator that restarts on a failing liveness probe would drop that buffer. Keep in mind for M5 (probe `/healthz` for readiness, not liveness). This is the M0 decision QA-M0-11 meeting the new buffer.
- **Held orphans count against the buffer capacity**, so a client can make the API answer 503 for the 60 s grace period (recorded by a test). An orphan dropped after the grace period leaves its session `running` for ever if the start arrives later (also by design).
- **`text/plain` with a JSON body** gets `400 expected array, received string` instead of 415. **`Content-Encoding: gzip`** is not supported (400 "not valid JSON"). Neither is used by the collector.
- **Body limit.** 1000 schema-valid events with 2000-character targets are 2.28 MB and get 413; the largest batch that fits has 1,800-character targets. The collector cuts batches by count, not bytes. Not reachable with the collector's real events (targets are domains and selectors, messages are cut at 500 characters).
- **`--seed`** takes up to 10 digits but the generator wraps at 2^32, so `--seed 4294967296` repeats `--seed 0`'s chaos (the scenario order differs).
- **Preflight checks the host-side URLs only.** If `DEMO_SITE_URL` and `DEMO_SITE_BROWSER_URL` / `DEMO_SITE_UPSTREAM` disagree (the "four places" note in `.env.example`) it passes and every session fails on the first `goto`.
- **Timing.** `startup_ms` (container create to server ready): 2.3 to 3.1 s on an idle machine, 4 to 7 s at concurrency 4, 10 to 17 s at 12. The PR estimated 1 to 3 s. 12 sessions at concurrency 4 took 37 s.
- **`net_rx_bytes` / `net_tx_bytes` are per-sample deltas** (the first one counts from container start). That is right for summing, but the schema and PLAN do not say so. Worth one line in `packages/schema`.
- **Ctrl+C was exercised through the registered handlers** (`process.emit("SIGINT")` on the real CLI, the real Docker containers). A real console Ctrl+C through `pnpm` and `tsx` on Windows could not be sent from this non-interactive shell (a console control event aimed at a child process had no effect). Please try it once by hand: `pnpm fleet run --sessions 20`, press Ctrl+C, expect exit 130 and an empty `docker ps --filter label=fleetscope.session`.
- **QA-M0-13 (FSTDEP023) is fixed:** the API start log has no deprecation warning, and `deprecations.test.ts` passes.

## Housekeeping

- **BE-ingest's edits to my M0 test files: reviewed and kept.** `migrate.edge.test.ts`: the migration list includes 0006, and the "one statement per migration" rule now also accepts a file whose statements are all `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ... MODIFY SETTING`, which is what the db README says ("idempotent, or one statement per file"). The rule is deliberately narrow (a new kind of statement fails the test and forces a look). The claim behind it, that a half-applied 0006 can be run again, was untested, so I added `migrate.upgrade.integration.test.ts` (it passes). `db.edge.integration.test.ts`: `5 → 6` in two places, correct.
- **QA-M0-03: closed.** The `it.todo` is gone. 12 tests now pin the guarantee at the level where it lives (see the table). QA-M0-06 and QA-M0-09 are covered by the buffer tests (orphans, duplicates). The remaining db-level tests that record the M0 behaviour of `insertEvents` without tokens stay, because that is still what it does.

## Command output (current HEAD, 12 local commits ahead of `origin`, none pushed)

```
pnpm lint        Tasks: 8 successful, 8 total
pnpm typecheck   Tasks: 7 successful, 7 total
pnpm test        schema      4 files  123 passed
                 demo-site   4 files   89 passed
                 db          3 files   43 passed
                 collector   5 files   90 passed | 3 expected fail
                 api         9 files  137 passed | 1 skipped (the opt-in QA_SLOW test)
                 fleet-runner 11 files 140 passed | 5 expected fail | 16 skipped (opt-in e2e)
                 Tasks: 7 successful, 7 total
pnpm test:integration
                 api   4 files   48 passed | 2 expected fail
                 db    4 files  101 passed
                 Tasks: 2 successful, 2 total
FLEET_E2E=1 real-run.e2e.test.ts   12 passed | 3 expected fail   (also the cleanup test: passed)
```

`gh pr checks 4` (run on head `e318b24`; my commits are not pushed):

```
Fleet smoke (Chromium)         pass  2m9s
Integration tests (ClickHouse) pass  46s
Lint, typecheck, unit tests    pass  43s
Secret scan (gitleaks)         pass  6s
GitGuardian Security Checks    pass
Vercel / Vercel Preview Comments  pass
Claude PR review, Claude @mention skipping
```

Before the first push, check that my new unit tests also pass on the Linux runner: the QA-M1-02 tests that depend on how Node reports a refused `localhost` skip themselves where the bug does not show, and the Docker-dependent CLI tests skip when Docker is down. The integration job runs the new proxy and 70,000-event tests against the service container.

## Cleanup done

Stopped exactly the API (:4000) and demo site (:3100) I started; no `fleetscope.session` containers left; ClickHouse running and healthy. I deleted my own rows from the dev database (every `agent_id` starting with `qa`, and my 5 default-agent sessions started after 13:20 UTC; the lead's earlier 21 sessions and the seed data are untouched) and dropped `fleetscope_test_902b9fb6c84c`, a leftover from the M0 QA pass.

## Verdict (first pass): NOT READY

Open blockers: none.

Open majors (need a fix and a re-test):
- **QA-M1-01** (backend-ingest): a valid batch spanning more than 100 days stalls all ingest.
- **QA-M1-02** (backend-fleet): preflight misses a stopped API or demo site on `localhost`.
- **QA-M1-05** (backend-fleet): sessions without container samples when Docker is slow (default concurrency unaffected; the lead may downgrade).

Open minors and nits: QA-M1-03, -04, -06 (decision), -07, -08, -09, -10 (decision), -11.

For the re-test round the `it.fails` tests flip as the engineers fix: QA-M1-01 and -09 in `ingest.abuse.integration.test.ts`; QA-M1-02 in `preflight.test.ts` and `cli.test.ts`; QA-M1-03 and -04 in `collector.http.test.ts`; QA-M1-05 in `stats.load.test.ts`; QA-M1-06, -08 and the e2e half of -03 in `real-run.e2e.test.ts`; QA-M1-07 in `recent-ids.slow.test.ts`. Besides these, merging also needs the reviewer's approval, and the new tests need one green CI run once pushed.
