# QA report: routing by scenario (branch `routing-by-scenario`)

Scope: `--routing fixed|by-scenario` (ADR 0005), `session.started.routed_from` / `sessions.routed_from`
(migration 0009), the routed-session parts of the Browsers, Sessions and Session dashboards, the
solid-line rule in `grafana:check`, `tools/worker-probe.mjs`. Grafana folder permissions: skipped, as agreed.

## Verdict: ready to merge

No open blocker or major bug. Three minor findings (below), none of which block the merge.

## Tests added

| File | What it covers |
|---|---|
| `packages/db/src/routing.numbers.integration.test.ts` (16) | Routed-count numbers, hand-computed, run as the read-only user: Routed sessions stat (real `3 · 50%`, all `4 · 57%`, lightpanda `0 · 0%`, nothing ran gives NULL, empty range gives NULL), per-engine comparison and matrix count the engine that ran, Sessions "Routed from" column and the `routed` variable (running and interrupted routed sessions included), Session "Engine" stat text. The fleet table is at the top of the file. |
| `packages/db/fixtures/dashboards.ts` | `SessionSpec.routedFrom` (written as `routed_from` on `session.started`). |
| `apps/api/src/ingest.routing.integration.test.ts` (15) | Over `POST /v1/events` into real ClickHouse: the three engines are accepted; unknown engine, `""`, wrong case, padded name, number, boolean, array and object give 400 and none of the batch is stored; absent and null give NULL; `routed_from` survives a `session.ended` in a later request and after a flush; a duplicate `session.started` changes nothing. |
| `packages/db/src/migrate.routed-from.integration.test.ts` (2) | 0009 on a database with a running and an ended session (0001-0008 applied first): old rows read NULL, the old running session can still end, a new routed session works, a second run is a no-op, column type is `LowCardinality(Nullable(String))`; the file runs again without error when the ledger forgets it (`ADD COLUMN IF NOT EXISTS`). |
| `infra/grafana/src/design-rules.lines.qa.test.ts` (3, 2 are `it.fails`) | Holes in the solid-line rule: see QA-RT-03. |

## Passed

Real runs (API :4000, demo :3100; every run used its own agent id `qa-routing-*`; no `fleet cleanup`):

- **`by-scenario`, 3 engines, 9 sessions (`qa-routing-a`):** 1 routed session (`heavy-page-crawl`), no Lightpanda `heavy-page-crawl`. In `sessions FINAL`: `engine=chrome-headless-shell`, `routed_from=lightpanda`; every other session `routed_from` NULL. Summary shows `chrome-headless-shell (from lightpanda)` and `routed: 1 of 9 sessions (lightpanda -> chrome-headless-shell 1)`.
- **`--engines lightpanda --scenario heavy-page-crawl --routing by-scenario`, 3 sessions:** all three ran on lightpanda, all three failed (`timeout`, `webWorker: timeout after 3000ms`), `routed_from` NULL, exactly one warning in the log, exit 0.
- **`--engines lightpanda,chromium`, 6 sessions:** the routed session ran on `chromium` (`routed_from=lightpanda`).
- **`--routing fixed`, 9 sessions:** unchanged: lightpanda `heavy-page-crawl` ran and timed out, no `routed_from` anywhere.
- **Bad values:** `bogus`, `BY-SCENARIO`, `--routing=` (empty), `by-scenario,fixed`, missing value, and `fleet traffic --routing nope` all exit 2 with a clear message (`Choose one of: fixed, by-scenario`). Note: through `pnpm fleet ...` the exit code shows as 1, because pnpm wraps every failure as `ELIFECYCLE`; run `node ... src/cli.ts` to see the 2. This is how all flags behave, not specific to routing.
- **`fleet traffic --routing by-scenario --duration 90s`** (rate 6, concurrency 3): 2 batches, 6 sessions, all success, 1 routed, batch line prints `chrome-headless-shell (from lightpanda)`, exit 0, 0 dropped events.
- Data check across all runs: 0 rows with `routed_from = engine`, 0 routed-eligible Lightpanda `heavy-page-crawl` in the by-scenario runs.

Migration 0009: `pnpm db:migrate` on the dev database is a no-op ("migrations up to date", applied 0 skipped 9); the upgrade test above covers an old database.

Dashboards (local Grafana :3001, version 20 of each dashboard):

- The dashboards loaded in Grafana equal the JSON files (panels and variables, all four).
- Routed sessions stat: run through Grafana's `/api/ds/query` and through the test harness, both give the same text as a hand-written count over the dev database (24 h: 4 routed of 1067 ended sessions, real only 4 of 178, sim 0 of 889; the same numbers as `count()` / `countIf` written independently).
- Link target: `/d/fleetscope-sessions?...&var-routed=routed`; Sessions has the `engine`, `source` and `routed` variables the link needs, and `routed` offers value `routed`. The screenshots (`sessions-routed-1440.png`, `session-routed-1440.png`) show only routed rows, and the Session dashboard says "(routed from lightpanda)". `sessions-1440.png` shows "—" in Routed from for sessions that were not routed.
- No `custom.lineStyle` anywhere in the four dashboards; `grafana:check` is green (4 dashboards, 66 queries).
- Not tested: clicking in a real browser (no browser session was driven; evidence is the JSON, the API and the committed screenshots).

`tools/worker-probe.mjs`: `lightpanda/browser:1.0.2` exit 1 (`workers: not supported`, all three kinds `timeout`); `chromedp/headless-shell:156.0.8078.48` exit 0 (all `ok`); no argument exits 2; a missing image exits 1; no probe container is left behind.

Full checks, all green: `pnpm lint`, `pnpm typecheck`, `pnpm test --concurrency=2` (api 271 unit tests plus the other packages), `pnpm test:integration` (db 18 files / 290 tests, plus api). The working tree contained uncommitted changes of the platform engineer in `infra/grafana/src` while this ran.

## Bugs

| ID | Severity | Owner | Where | Summary |
|---|---|---|---|---|
| QA-RT-01 | minor | dashboard | `fleetscope-browsers.json`, panel "Routed sessions" | Share rounds to `0%` for a non-zero count |
| QA-RT-02 | minor | dashboard | same panel's link / description | Stat counts fewer sessions than the page it links to lists |
| QA-RT-03 | minor | platform | `infra/grafana/src/design-rules.ts` | `grafana:check` allows dashed threshold lines |

### QA-RT-01: "4 · 0%"

Steps: dev database, Browsers dashboard, Last 24 hours (or run the query: `round(100 * 4 / 1067)` is 0).
Expected: a non-zero count never reads as 0%: for example `4 · <1%`, or one decimal under 1%.
Actual: `4 · 0%`. It follows the DESIGN.md format (`39 · 4%`, share with no decimals), so it is a design edge, not a deviation, but it reads as a contradiction on the dashboard.
Likely file: the `routed` expression in `infra/grafana/dashboards/fleetscope-browsers.json` (panel id 11). Needs a DESIGN.md line too.

### QA-RT-02: stat versus list

Steps: the fixture in `routing.numbers.integration.test.ts` (3 routed sessions ended, 1 interrupted, 1 running). Browsers shows `3 · 50%`; the link opens Sessions with `routed=routed`, which lists 5 rows.
Expected: either the same number, or the description says the list also contains running and interrupted routed sessions.
Actual: the description explains the stat's denominator ("sessions that ended in the range, interrupted left out") but not that the list is wider. The mismatch is by design (the Sessions list shows every session that ran in the range, like the Engine comparison link does), so it is only a note.
Likely file: panel description in `fleetscope-browsers.json`.

### QA-RT-03: dashed threshold lines pass the check

Steps: set `fieldConfig.defaults.custom.thresholdsStyle.mode` to `dashed` (or `dashed+area`) on a time series and run `designProblems` / `pnpm grafana:check`.
Expected: rejected, because DESIGN.md section 2 says every time series line is solid.
Actual: accepted. The dashboards today use `off` and `area`, so nothing is wrong yet; the rule only has a hole. Pinned with `it.fails` in `infra/grafana/src/design-rules.lines.qa.test.ts`; flip to `it` when fixed.
Likely file: `lineStyleProblems` in `infra/grafana/src/design-rules.ts`.

## Notes (not bugs)

- ADR 0005 says live traffic runs a `fixed` canary every 10th batch. That lives in `tools/live-traffic.ps1` (untracked) and is not part of this branch, so it was not tested.
- The API accepts `routed_from` equal to `engine` (a session "routed" to the engine it was assigned). The runner never sends it; the schema has no cross-field rule. Left as is.
- The simulator does not write `routed_from`; Browsers "Routed sessions" therefore only ever counts real sessions today (dev database: sim 0 of 889).
