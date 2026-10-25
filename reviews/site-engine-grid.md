# Review: site-engine-grid (Real sites × engines)

Branch `site-engine-grid` vs `main`: 655ebd5 (README snippet `site-engine-matrix` + integration test) and
b0bc77d (Browsers panel "Real sites × engines ↗", id 13). Quick review, timeboxed.

## What I checked and ran

- `pnpm --filter @fleetscope/grafana-tools test`: 28 files, 323 tests passed.
- `pnpm grafana:check`: all 5 dashboards OK; Browsers 17 queries executed (the new panel included, no
  warning for it).
- `vitest --config vitest.integration.config.ts src/site-engine-matrix.integration.test.ts
  src/dashboard-sql.integration.test.ts` against local ClickHouse: 2 files, 41 tests passed.

**SQL correctness.** Filters go through `session-facts` (engine, source, target and site through
`$__conditionalAll`), `done` is ended + in range + not interrupted + `target = 'public'`, and a pair with
no ended session has no row at all. That means the cell is `—` and never `0%`. `success_rate` and `top_cause`
use the same definitions as `compatibility-matrix` (same `argMin(cause, (-n, cause))` tie-break,
`nullIf(any(...), '')` around the LEFT JOIN default). The test covers interrupted-only pairs, the demo
site, sessions before the range, the tie-break, and all three filters. The test runs as the read-only
user. The simulator only ever writes `target = 'demo'` (generate.ts:131), so simulated data can't show up in
a "Real sites" grid.

**Cell text and colours.** The rate is floored before the regex runs. The regexes are anchored and don't
overlap: `100|9[5-9]` is green, `9[0-4]` is amber, `[0-9]|[1-8][0-9]` is red, which matches the compatibility
matrix's 90/95 thresholds. A missing pair is `null` from `groupingToMatrix` (`emptyValue: "null"`), so the
special null mapping turns it into `—` in `#9AA9BB`. `n=` is always shown, so a small sample is visible.

**Links.** `renameByRegex ^site.engine$` → `site` makes `${__data.fields.site}` resolve. The cell links
set `var-engine` and leave out `${engine:queryparam}`, `${target:…}` and `${site:…}`, so nothing overrides them.
They keep `${__url_time_range}` and `${source:queryparam}`. Sessions has `target` and `site` variables. The
Site link keeps the current Engine filter, which is what "all engines" means under Engine = All.

## Findings

No must-fix findings.

### N1. Dead `'—'` branch in the panel label, and the README says NULL is possible (nit, dashboard + backend)
`infra/grafana/dashboards/fleetscope-browsers.json:2806` (last SELECT), `packages/db/README.md:846`.
Every `(site, engine)` group has at least one row of `done`, so `count() ≥ 1` and `success_rate` can never be NULL.
`if(success_rate IS NULL, '—', …)` never fires. If it did fire, the literal string `'—'` wouldn't match the
`null` special mapping and would show in text colour, not `#9AA9BB`. Fix: drop the branch, or return
`NULL` instead of `'—'` so the mapping handles it. In the README, change "NULL (never 0) when there are no
ended sessions" to say the pair has no row (which the next sentence already says).

### N2. The panel's wrapped copy of the snippet isn't checked for drift (nit, platform)
`fleetscope-browsers.json:2806`. `snippet-copies.ts` checks only whole copies marked `-- snippet:`, and
`session-facts.ts` checks only the facts block. The `matrix` CTE ("wrapped in 'matrix'") is identical to the
README block today (I compared them by hand), but nothing in CI will catch it if one of them changes later. I think
the compatibility-matrix panel has the same gap, but I haven't confirmed it. Fix, later: let snippet-copies
check a CTE named in a `-- snippet: <name> as <cte>` marker.

### N3. Empty cells still link (nit, dashboard)
`fleetscope-browsers.json:2707` and the two overrides after it. A `—` cell carries the engine link and
opens an empty Sessions list. That's harmless and honest. Optionally add "— cells open an empty list" to the
description, or leave it as is.

### N4. One session at 100% is green (nit, design call)
Public sites shows "Not enough data" below 3 Chromium sessions. This grid colours `100% · n=1` green.
The `n=1` in the text keeps it honest, so this isn't must-fix. If the lead wants the two panels to match, add a grey
mapping when n < 3 (for example, compute the label's colour bucket in SQL). Leaving it is fine.

## Verdict

**Approve** (nits N1–N4 optional, none blocking).
