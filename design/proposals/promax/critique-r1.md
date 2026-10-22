# Critique of taste v1 (by promax, round 1)

I read `taste/v1/{system,rationale}.md`, both of their HTML files through the screenshots, and both `render-check.md` files. Screenshot names below are `taste/v1/screenshots/<page>-<width>-<theme>.png` unless I say "mine".

Headline: their Overview is the better *composition* (denser, calmer, answers more above the fold: 1083px page height vs my 1224px, with failures beside the charts instead of under them). My strengths are the engine palette, the visible real/sim treatment inside charts, and a more interactive session timeline. Where they are clearly ahead I say so and I plan to adopt it in v2.

## 1. Colors and themes

**Stronger in theirs.**
- True-neutral greys plus **blocked as a hue-less hatched outline** keeps the status hues to three (green, amber, vermillion) and leaves blue, pink and cyan to engines. That is a cleaner separation than my violet "blocked". Their render-check shows only 4 CVD flags at ΔE < 10 against my 9 across both themes. Theirs are headless vs degraded (tritanopia 8.9), headless vs blocked (protan 10.0, deutan 3.1), Lightpanda vs healthy (tritan 9.4) and Chromium vs headless (light, protan 7.9); mine are mostly engine-vs-status overlaps (orange vs amber, pink vs red).
- Whole system maps 1:1 onto shadcn variables with an `ENGINES`/`STATUSES` typed map, so chart, badge and legend cannot drift. I only mapped the neutrals.
- Light theme in `overview-1024-light.png` is calm and consistent; the degraded banner reads well.

**Stronger in mine.**
- The three engine colours separate from *each other* far better under CVD. Mine: lowest engine-vs-engine ΔE is 11.1 (dark) and 9.6 (light, headless vs Lightpanda under tritanopia, which is a rare condition; the common protan/deutan minimum is 11.0); theirs reaches 10.0 (Chromium vs headless-shell, protanopia, dark), 10.2 (headless vs Lightpanda, deuteranopia) and **7.9** (Chromium vs headless-shell, protanopia, light, flagged). Since engines are the thing every chart has to tell apart, that matters.
- Mine passes every rendered text node on AA in both themes. Theirs has one rendered failure: `v0.2.9` in the session header, light theme, drawn in `#139AB2` on `#F5F5F6` = **3.06:1**, which also contradicts their own rule that engine colour is never a label colour.

**Weak spot they share with me:** headless-shell vs blocked-grey under protan/deutan is **3.1** in their dark theme. Hatch saves it where it is used, but a legend swatch or 8px stacked-bar segment loses the hatch.

**Suggestion for them.** Fix `#139AB2` as text (render the version in `--muted`), and push Chromium and headless-shell apart by lightness in the light theme (e.g. a darker navy for Chromium and a lighter magenta for headless-shell, then re-run the CVD check; target ΔE >= 10 for protanopia). Keep the mandatory marker shapes either way.

## 2. Typography

**Stronger in theirs.** A more disciplined scale with one job per size ("status lead 28" only for the fleet word), fixed decimals per metric, and a rule that every change carries a sign. IBM Plex Sans/Mono gives the mockup more character than my Inter, and mono ids truncated to 8 chars is a smart density move. The 28px "Degraded" in `overview-1440-dark.png` is the strongest single element on either Overview, bigger and clearer than my 20px "Fleet degraded".

**Stronger in mine.** A 12px floor everywhere (theirs is 11px for axis, chips, bar labels; contrast passes, but 11px chips and ticks will be hard for long watching sessions). Inter's tabular figures are known to work; they admit Plex's `tnum` is unchecked.

**Suggestion for them.** Raise the 11px tier to 12px (their cards have the room; see the generous axis spacing in `overview-1440-dark.png`) and delete one tier from the scale.

## 3. KPI cards

**Stronger in theirs.** The divided KPI strip is denser and tidier than my seven tiles: no wrapped legends, no collision. Each cell has a sublabel that matters ("of 48 cores, 45%", "80% of capacity" with a true-ratio track) and deltas **name their window** ("vs prior 1 h"). Colour = better/worse, with a hidden "worse" for screen readers: better semantics than my arrow-direction plus colour. At 1024 (`overview-1024-light.png`) it flows 4 + 3 cleanly. In mine, the Sessions card's `741 real · 1,185 sim` line overlaps the split bar by 4px (my render-check), and my 1024 layout leaves the sparkline cards ragged.

**Stronger in mine.** Whole-card links carry a **visible** `↗` at rest, so "every number is a door" is discoverable without hover. The Sessions card shows the real/sim split inline. The success-rate card gets a status-coloured edge.

**Suggestion for them.** Their strip says "every cell is a link" but shows the destination only on hover. Add a small resting affordance (a `↗` or chevron in the corner) so keyboard and touch users can see the door. I would also drop my own sparklines: they have no scale and add noise, so their no-sparkline call is right.

## 4. Charts

**Stronger in theirs.** Their error-rate chart tells a *cause*: the dashed "14:12 Lightpanda v0.2.9 rollout" annotation, 21.4% peak label and alert line are all legible, with nothing colliding. One shared legend above the chart group avoids the wrapped legends I have at 1440 (my render-check: two legends wrap to two lines). Stacked columns with a capacity line answer "are we near capacity" in the chart itself. Lines with an end marker per engine are easy to read. Mine at 1440 has the static tooltip covering the `alert at 10%` label (only "ale" visible), and heavy translucent stacked areas where the amber/pink/blue fills blend into muddy bands.

**Stronger in mine.** Real vs sim is visible *in* the chart (the solid/hatched source strip under Active sessions). Theirs says "charts never blend visually" and then relies on the tooltip alone, so a glance at a mixed chart cannot tell how much is simulated. Mine also gives each chart a table-view button, a spike band, and a tooltip ending in "31 failed sessions, Open", which shows the drill-down destination.

**Suggestion for them.** Add a thin source strip (solid = real, hatched = sim) under the stacked columns, or hatch the sim segment of each column. Also add a "view as table" button; Recharts SVGs are not accessible on their own.

## 5. Tables and lists

**Stronger in theirs.** The By engine table is the better table: a status badge per engine row, active-now, CPU and memory columns, a totals row, all on one line with no wrap. Mine wraps `chrome-headless-shell` to two lines and leaves dead space under the table at 1440. Their Recent failures sits in a right rail next to the charts so it is visible without scrolling, with scenario and reason code on the second line and the source chip right-aligned (`overview-1440-dark.png`); mine is below the fold. Their "Healthy 1,592 / Degraded 136 / Failed 87 / Blocked 27" distribution bar gives the four-state mix at a glance, which I lack.

**Stronger in mine.** My failure rows carry the human-readable message (`IntersectionObserver is not defined`) rather than only the code, and my success column pairs an icon with a bar so status is never colour alone. The `<th scope="row">` and `overflow-x-auto` safety net are in the spec.

**Suggestion for them.** Add a "Top issue" column to the By engine table (e.g. `unsupported_api x59` for Lightpanda). It puts the *reason* for the red row in the same line and shortens the path to the cause.

## 6. Session waterfall

**Stronger in theirs.** Clearly the richer story: browser boot phases (startup, connect) as grey bars, the failing span shaded across every row and both charts, an issue marker labelled in the axis band, and a 2px resource line with sample dots that is honest about the 2 s sampling. The issues panel shows the actual `ReferenceError` text and a compatibility line ("Chromium 97.2%, Lightpanda 41.0% (59 of 144)"), and the CPU trace dropping to ~3% for 8 s supports the "waiting on code that never ran" narrative. Their header omits the global filters on the session page (it is its own scope); mine keeps time range, engine and source controls that do nothing there.

**Stronger in mine.** Mine is more interactive: one hover cursor crossing the waterfall, CPU and memory with live read-outs, a selected-row highlight, a selected-action detail strip, and per-bar redundant encoding (slow = amber + clock + "slow" in the label; failed = stripes + X + "failed"). In theirs a slow action (#8) is just an engine-coloured bar plus a triangle *outside* the bar. My waterfall has real defects though (my render-check): the `end 12.4 s` label collides with the `12 s` tick, the `9.35 s` chip hides the `8 s` tick, and the top y labels of both resource charts are clipped by 7px.

**Shared defect.** Row 11: `screenshot` (72px) overruns its 66px column into `full page` in **both** proposals.

**Suggestion for them.** Colour the *bar* for a slow action amber (keep their trailing icon), so slow actions are spottable in peripheral scan, and add a synced hover cursor with CPU/memory read-outs. Widen the type column to 80px.

## 7. Navigation

**Stronger in theirs.** A fuller sidebar: Saved views (which the ⌘K spec mentions), collector health dot, settings and user, plus breadcrumb in the top bar on the session page. The engine filter's markers and the "real / sim" mix line in the title row are well placed. Theirs stays one-line at 1024 and degrades to an icon rail.

**Stronger in mine.** Whole-page chrome is leaner: no workspace switcher to build. Ingest health and lag are shown in the sidebar footer with a text value, not just a dot. At 1024, my rail keeps only the five product areas, so every icon is distinguishable (`overview-1024-light.png`, mine).

**Suggestion for them.** The "Kestrel Labs / production, eu-west" workspace switcher is not in PLAN.md (no multi-tenancy in scope); make it a static label or drop it to save build time. And at 1024 the two Saved-views entries collapse into identical bookmark icons: show a single icon with a popover, or hide them in the rail.

## Top three suggestions for them

1. **Re-separate the engine palette under protanopia and fix the one AA failure.** Chromium vs headless-shell is ΔE 7.9 in light and 10.0 in dark; `#139AB2` text on `#F5F5F6` is 3.06:1.
2. **Make real vs sim visible inside the charts** (hatched or stripped source share), not only in tooltips and the title line.
3. **Show the drill-down affordance at rest** (KPI cells, chart points) and make the waterfall interactive (slow bar fill, synced cursor with CPU/memory read-outs).

## What I plan to take from them

Blocked as hue-less hatch (or at least un-violet), the right-rail failures list, a status badge per engine row plus a state-distribution bar, windowed deltas, the shared chart legend and rollout annotation, hiding global filters on the session page, inline CSS so the pages render without the CDN, and a fix for every collision my render-check found.
