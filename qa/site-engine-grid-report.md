# QA: site x engine grid (targeted)

Branch `site-engine-grid`, commits 655ebd5 and b0bc77d. Local ClickHouse and local Grafana 13.2.4, real Chrome through playwright-core. No real-site traffic.

## Verdict: NOT READY (1 major bug open)

## Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | Number, n and top cause equal a hand count from `sessions FINAL` | Pass. Panel SQL (macros substituted) run as `grafana_ro` over the whole day and over 06:05-06:09:40. mdn x chrome-headless-shell is 66% n=3 site_layout (2 of 3; the failed session has a failed action with `site_layout`). wikipedia x chromium is 75% n=4 site_layout. Narrow range gives 50% n=2 for both, and the hand count agrees. All other cells match. |
| 2 | A pair with no sessions shows a dash, not 0% | Pass. Rendered in real Grafana over a narrow range, no fixture needed: govuk x chromium and 8 other cells show a grey dash (#9AA9BB). Static test covers `emptyValue: "null"` and the null/nan mappings. The snippet test already proves there is no row for such a pair. |
| 3 | A cell link opens Sessions for exactly that site and engine | **FAIL, QA-SEG-01.** |
| 4 | Thresholds 95 / 90 | Pass. 94.9 is floored to 94% and is amber; 89.9 is red. Colours verified for every whole percent 0..100. In ClickHouse `floor` equals integer division for every k/n with n up to 200, so no float edge. Real Grafana colours seen: green rgb(110,231,168), red rgb(255,123,123). |
| 5 | `pnpm grafana:check` | Green: 5 dashboards, 2 alert groups, 92 queries. |

## Bug

### QA-SEG-01 (major, owner dashboard): link `var-site` is empty, so Sessions is not filtered to the site
- Steps: open `/d/fleetscope-browsers?from=...&to=...&var-source=real`, click the cell "66% n=3 site_layout" (mdn x chrome-headless-shell). Script: `node qa/scripts/site-engine-grid-click.mjs <png>` (local Grafana on :3001).
- Expected: `.../fleetscope-sessions?...&var-source=real&var-target=public&var-site=mdn&var-engine=chrome-headless-shell`, and a list of mdn sessions only.
- Actual: `...&var-target=public&var-site=&var-engine=chrome-headless-shell`. Site is empty, the Site variable is blank, and the list shows chrome-headless-shell sessions of every public site (python-docs among them). The same empty `var-site=` is in every cell link and in the site-column link, for all 15 cells.
- Cause: the link uses `${__data.fields.site}`. After `groupingToMatrix` plus `renameByRegex` the first column is the field `site\engine`, renamed only in display, so the name `site` does not resolve. Not verified: fixing by a field index (`${__data.fields[0]}`) or by dropping the rename. Retest with the script after the fix.
- Fine in the same links: no duplicated `var-site` / `var-engine` / `var-target`, the time range (`__url_time_range`) and `var-source` are kept, `var-engine` is the clicked column.
- Likely file: `infra/grafana/dashboards/fleetscope-browsers.json` (panel 13, overrides `links`).
- Minor note: the site column link carries `var-engine=$__all` (the literal) when Engine is All. That works but is untidy.

## Tests added
- `infra/grafana/src/site-engine-grid.qa.test.ts` (6 tests, pass): threshold colours for 0..100, the 94.9 and 89.9 cases, floor in SQL, dash mappings and `emptyValue`, and one `var-site` / `var-engine` / `var-target` per link with range and source kept. It cannot see QA-SEG-01, because the problem is how Grafana resolves the field at run time.
- `qa/scripts/site-engine-grid-click.mjs`: the live reproduction of QA-SEG-01. Re-run it after the fix; the printed URL must contain `var-site=mdn`.
- Not added: a fixture for the dash cell (the narrow range in real Grafana did it with no clean-up needed).
