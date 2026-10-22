# Changes, Taste v1 to v2

Sources: `promax/critique-r1.md`, `taste/v1/render-check.md`, and the lead's revision notes. Verdicts are **accepted**, **rejected** or **compromise**. All colour numbers below that say "est." are hand simulations (Machado 2009 matrices applied by hand, CIEDE2000 estimated from L* and chroma gaps); the helper will give the real values. Contrast ratios are hand-computed (v1's all checked out).

## A. Render-check problems (v1)

| Problem | Verdict | What changed |
|---|---|---|
| `v0.2.9` in Lightpanda colour fails AA (3.06:1, light, session header) | **Accepted** | Root cause: `.eng` wrapper carried the engine colour onto the version text, contradicting my own rule. Engine colour now lives only on marker, line and bar elements (`e-*` classes on the `svg`/path), names and versions are `--text` / `--muted`. The rule is now written in `system.md` 2.1. Expected: 0 rendered text nodes below AA. |
| Row 11 `screenshot` spills its 66px column | **Accepted** | Type column 66px to 80px (the word needs 72px), label column 264px to 280px so the target keeps about 150px. Plot at 1440 is 492px (was 512). |
| CVD: dark headless `#D98AB8` vs blocked grey, deuteranopia ΔE 3.1 (protan 10.0) | **Accepted** | Blocked grey `#A6A6AE` to `#7E7E86`. In v1 it sat at the same lightness as the pink (L* about 68), so under deuteranopia both collapse to the same blue-grey (I simulated headless as about (162,167,182) vs the old grey (166,166,174)). Now 15 L* apart. Est. ~13 (D), ~12 (P). |
| CVD: dark headless vs degraded, tritanopia 8.9 | **Accepted** | Dark degraded `#E8A93A` to `#F2BC48` (L* 73 to 79). Simulated tritanopia: headless becomes rose (227,138,154), the new amber salmon (255,171,164); est. ~12. |
| CVD: dark Lightpanda vs healthy, tritanopia 9.4 | **Accepted** | Lightpanda `#6FD6E6` to `#96E6F3` (L* 80 to 87) against healthy L* 70. Est. ~12. |
| CVD: light Chromium vs headless, protanopia 7.9 | **Accepted** | Light Chromium `#1A5FB4` to `#174C96` (darker), light headless `#B8408A` to `#C8559C` (lighter): L* gap 6 to 20. Est. ~15. |
| Borderline: dark Chromium vs headless (protan 10.0) and Chromium vs healthy (trit 10.0) | **Accepted** | Dark Chromium `#4C9BE6` to `#3A7FD6` (L* 62 to 53), headless stays at 67. Chromium vs headless est. above 20 (P); Chromium vs healthy est. ~12 (T). |
| Side effect I introduced: headless vs Lightpanda in light under deuteranopia | **Compromise** | Light Lightpanda `#139AB2` to `#17A0BA`, which is as light as 3:1 allows. Est. ~12 (D) but the L* gap is only 8, so it relies on a chroma gap. Cue if the helper reports below 10: square with dashed line vs diamond with dash-dot line. |
| Lowest margins: Lightpanda light on surface 3.34 | **Accepted with cost** | It drops to 3.10 (still passes 3:1). On a hovered `--raised` row it is 2.7. It always sits next to its name, and hover is transient. Documented in `system.md` 2.3. |
| `.sr` spans reported as clipped | **Rejected** (intended) | Visually hidden text is the accessible "worse", "failed", "slow" cue. |
| Other lowest margins (faint on active light 4.63, failed on failed-bg light 4.96, control dark 3.14) | **Rejected** (pass) | They pass AA with a margin. I did not trade them away. |

## B. Promax critique points

### 1. Colors and themes
- Blocked hue-less is "cleaner" (their praise): **kept**, see the decision in section C.
- Shared weak spot: headless vs blocked 3.1, and hatch lost in small swatches: **accepted**, see A, plus the hatch rule: blocked segments get a minimum width of 8px, a 1px outline and a 1.5px hatch, and legend swatches are 12 by 8px.
- Suggestion: stop using the Lightpanda colour as text: **accepted** (A).
- Suggestion: push Chromium and headless apart in light by lightness: **accepted** (A).
- shadcn mapping and a typed `ENGINES`/`STATUSES` map: **retained**; the mapping now covers every token including `--on-degraded` (system.md section 6).

### 2. Typography
- Raise the 11px tier to 12px and delete a tier: **accepted.** Axis ticks, chips, kbd, bar labels, waterfall ticks and counts are 12px. 12.5px and 15px are gone. Scale: 28 / 22 / 20 / 14 / 13 / 12 (six sizes, was eight).
- Plex's `tnum` unchecked: **kept** the pair. The v1 screenshots showed aligned digits; fallback to Inter remains in system.md.

### 3. KPI cards
- Show the door at rest: **accepted.** Each overview KPI cell has a faint arrow-up-right in the corner (5.7:1), which turns to ink on hover.
- Their status-edge on a breaching card: **compromise.** Success rate and p95 latency get a 2px `--failed` top rule, because those two breach their thresholds. No left bar (rare), no tint, nothing on healthy cells.
- Real/sim split inside a KPI cell: **rejected.** The mix is already in the title row, and now also in every chart. A caption inside a cell collided with the bar in their render-check.
- Sparklines: not applicable (I have none; they agree).

### 4. Charts
- Real vs sim must be visible in the chart, not only in tooltips: **accepted** (also the lead's note). Every chart has a 6px strip under its x axis: each minute is split into a solid real share and a hatched sim share, a legend key sits in the shared legend row, and the tooltip adds "Source real 66%, sim 34%". The data are seeded around 1,214 real of 1,842 (65.9%). I considered hatching the sim part of each column, but at 5px per column the hatch does not read; a strip works for lines and columns alike.
- "View as table" button: **accepted.** A 24px icon button in every chart header.
- Engine identity by dash (from their v1, which I praised in my critique): **accepted.** Chromium solid, headless-shell dashed `7 4`, Lightpanda dash-dot `9 3 2 3` (not dotted, so the line carrying the spike keeps its weight). The legend shows a line sample, the marker and the name.
- Tooltip with a drill-down: already had "Click to open sessions".

### 5. Tables and lists
- Add a Top issue column to By engine: **compromise.** Done (`timeout x13`, `captcha x14`, `unsupported_api x48`). To make room under 1100px the CPU and Memory columns hide there (they are in the KPI strip).
- Failure rows should carry the human message: **accepted.** Rows are now three lines: badge, id, time; code plus message ("IntersectionObserver is not defined"); engine, scenario, source chip. The list shows 5 rows instead of 6 so the rail still matches the chart column.
- "Mine wraps `chrome-headless-shell` / dead space under my table": not a defect of v1 (render-check found neither); no change.

### 6. Session waterfall
- Slow action bar amber: **accepted.** A slow bar is filled `--degraded` (label in `--on-degraded`), keeping the triangle in the label column.
- Synced cursor with CPU and memory read-outs: **already there** (v1), kept.
- Type column to 80px: **accepted** (A).
- Added from their v1: a "checkout-form on each engine" card (211/217, 198/204, 59/144 with status badges). The issue text no longer repeats the numbers.
- Removed the "Raw events" tab (not in PLAN.md section 7; network, issues and screenshots are).

### 7. Navigation
- Workspace switcher is not in PLAN.md: **accepted.** Removed, with its subtitle ("Kestrel Labs, production"). For the same reason I also removed the user row and the Settings link.
- Saved-views icons are identical at 1024: **accepted.** "Lightpanda regressions" is a trending-down icon; "Real traffic only" is a ringed dot (solid ring means real, matching the real/sim language). The 1024 rail gets a 1px separator before them.
- Ingest health in the footer with a text value: kept.

## C. Lead's notes

- **Blocked: decided to stay hue-less and hatched.** Reasons: (1) the promax critique and render-check agree that three status hues plus neutral is cleaner; their violet cost them a ΔE of 3.1 against Chromium blue under deuteranopia, so a fourth hue is not free; (2) "blocked" means "the site refused us", which is not success and not our breakage, so a neutral state fits; (3) it is never grey on grey: outlined chip, `ban` icon, ink label (16.7:1), and a hatch wherever it is a fill, with an 8px minimum. Risk acknowledged: at a glance it reads quieter than the other three states, which I think is right for a state that is usually not actionable. If Eyal wants it louder, the alternative is promax's lightness-fixed violet.
- **Palette recomputation:** done by hand, tables in `system.md` 2.3 and 2.4. Where I may miss: headless vs Lightpanda in light under deuteranopia (est. 12, thin margin) and tritanopia pairs involving amber. Non-colour cues cover them (marker shape, dash pattern, icon plus label).
- **Thresholds, default source filter:** now listed under "Open questions for Eyal" in `rationale.md`.

## D. What I expect the helper to report

- Rendered text contrast: 0 failures in both themes (the Lightpanda version text is now `--muted`: 7.4 on surface in light, 8.7 in dark).
- Overflow and spill: none, including row 11. One thing to watch: the failure-row message truncates with an ellipsis at 400px, which is intended.
- Token contrast: new engine values 4.6 / 7.4 / 13.3 (dark) and 8.4 / 4.0 / 3.1 (light) on surface, degraded 10.8 (dark), blocked outline 4.65 (dark).
- CVD flags: down from 4 to at most 1 or 2 (candidates listed above).
