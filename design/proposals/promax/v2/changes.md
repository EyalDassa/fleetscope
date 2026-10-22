# Changes, promax v1 to v2

Sources: `taste/critique-r1.md` (their critique of v1), `promax/v1/render-check.md` (objective facts), and the lead's notes (inline CSS, recompute CVD ΔE, pick a position on blocked, no workspace switcher). I could not render v2 either; every layout fix below is reasoned from the render-check measurements, and the expected values in the last section are what I expect the helper to find.

## A. Lead notes

| Note | Result |
|---|---|
| Inline CSS, no Tailwind CDN | **Accepted.** Both files have one inline `<style>` with the tokens and a small hand-written component stylesheet. The only external request is Google Fonts, with `system-ui` fallback. The shadcn/Tailwind mapping stays in `system.md`. |
| Fix every collision and clipping problem | **Accepted.** See section C. |
| Recompute contrast and CVD ΔE after the palette change | **Accepted.** `system.md` 2.1-2.4. Contrast recomputed by hand for every changed token; ΔE for changed pairs is a hand estimate from L* gaps (I have no ΔE tool), marked as such, with the pairs I am least sure of called out. |
| Pick deliberately on blocked | **Decision: keep a hue (violet), retuned.** Justified in `system.md` 2.2 and below in B1. |
| No workspace switcher / out-of-plan features | **Accepted.** Nothing added. I also rejected their suggestion to add one (B-nav). |

## B. Taste's critique of v1

### Colors and themes
1. **"Blocked has its own hue, reads better than their grey outline."** **Accepted, kept**, with a deliberate answer to the brief. Violet stays because (a) blocked must read as its own state at a glance and grey is already the colour of "running", chips and disabled UI; (b) hatch is my sim marker, so reusing it would give one pattern two meanings; (c) the real defect was lightness, not hue. Their hue-less idea that I *did* take: blocked is never red, and its non-colour cues (the `ban` icon and the word) are first-class.
2. **"Light theme fully re-derived."** No action; kept. In v2 I re-derived light `warn` (`#6B4400`) and `blk` (`#3D2A9E`) again for the same CVD reason.
3. **"Headless orange next to Degraded yellow (ΔE 9.5, 7.1 deuteranopia), Chromium blue vs Blocked violet (3.1 deutan). Fix by lightness: blk toward `#D4C4FF`, warn toward `#FFD76A`."** **Accepted.** Dark `blk-fg` `#B79CFF` to `#D9CCFF` (with a deeper `blk-bg` `#2B2159`), dark `warn-fg` `#F2C14E` to `#FFD95A`, dark `ok-fg` `#4BD98E` to `#6EE7A8` (fixes Chromium vs Healthy under tritanopia). Light `warn-fg` `#8A5A00` to `#6B4400`, `blk-fg` `#5B3FC4` to `#3D2A9E`. Their alternative (move Degraded to an orange-red state and let headless keep amber) is **rejected**: it puts Degraded next to Failed, which is a worse confusion than the one it removes.
4. **"I also have a flagged pair (headless pink vs blocked grey, deutan 3.1)."** Noted; not applicable to my palette. See C-CVD below.

### Typography
5. **"Make the chart subtitle one line; keep legends and table headers nowrap; `chrome-headless-shell` and the `p95 latency` header wrap."** **Accepted.** One-line subtitles, `white-space: nowrap` on legends, headers, engine names and badges; Engine column min-width 240px; table headers are one line.
6. **"Fewer sizes and a single lead (28px status word); 26px/600 KPIs plus sparklines make the strip heavy."** **Compromise.** Took the 28px status lead (it is a clear improvement over my 20px "Fleet degraded"). Kept KPI values at 26/600 (readable from across a room, one size for 7 cells) but removed the sparklines from five cells, so the strip is lighter.
7. **"Chart cards spend about 110px before the plot."** **Accepted.** Header is now title + one-line subtitle + inline "now" values: about 44px. Legend is shared, not per card.

### KPI cards
8. **"Breaching card gets a 3px left border; whole-card link with visible arrow; real/sim split bar on Sessions."** Already in v1; kept. The breach cue is now `inset 3px` on the two breaching cells.
9. **"Drop sparklines from the six cards that are not breaching."** **Accepted** (compromise on the count: the Active cell shows a capacity track, Sessions the real/sim bar, CPU/memory/cost one-line facts; sparklines remain only on Success rate and p95 latency, the two breaching cells).
10. **"Name one baseline everywhere ('vs prior 1 h')."** **Accepted.** Every delta reads "vs prior 1 h".
11. **"One divided container, about 100px tall."** **Accepted.** KPIs are now one card with 1px dividers, cells about 104px. I kept the always-visible `↗` that theirs lacks.
12. **"Remove the `-mt-1` that collides the split-bar caption."** **Accepted.** Removed; the caption has its own 4px offset.

### Charts
13. **"Widen Error rate to at least half the row; one shared legend with live values; move the static tooltip off the threshold label."** **Accepted.** Error rate spans the whole 764px left column (about 65% of the row) at 260px tall. One shared toggle legend sits above the chart group; live values are shown as marker-plus-number in each card header (the shape identifies the engine, so it needs no extra text). The tooltip is pinned in the empty top-left of the plot, and the `alert at 10%` label moved below its line at the left.
14. **"Their error chart has an annotated cause (14:12 rollout) and a labelled peak."** **Compromise.** Added a spike annotation in a reserved row above the plot ("Spike 14:21-14:28 · 31 failed") and a labelled peak via the tooltip. I did **not** add a rollout/deploy marker: the event schema in PLAN section 5 has no deploy event, so it would be a feature outside the plan. The banner names the cause from issue data instead (71 of 89 Lightpanda failures are `unsupported_api`).
15. **"Take dash styles and tooltip drill-down row; stacked areas."** Already in v1; kept. Also took their **capacity line**: Active sessions is now stacked columns against a dashed `capacity 200` line, so "are we near capacity" is answered inside the chart. Added engine-shaped end markers on the error lines (also theirs).
16. **Real/sim inside charts.** Kept the source strip; they did not dispute it.

### Tables
17. **"Inline success bar and human error message in failures list."** Already in v1; kept.
18. **"Status badge per engine row and totals row."** Kept; the totals row now also carries a status badge.
19. **"Table stretches to the failures rail and leaves about 130px of blank card; first column squeezed."** **Accepted.** Failures moved to a right rail beside the charts (400px, as in their layout), so the table is full width below and keeps its own height. Added Active, CPU and Top issue columns to use the width; Active and CPU hide below 1280px so there is no horizontal scroll at 1024.
20. **Right-rail failures list** (from my own critique of theirs). **Accepted**, with three lines per row (badge/id/source/time; engine and scenario; code and message).

### Session waterfall
21. **"Give the axis header two rows so the failure chip and end label never sit on a tick."** **Accepted.** Events row on top (failure chip, `end 12.4 s`, hover tag), tick row below.
22. **"Widen the type column to 80px or shorten to `shot`."** **Accepted** (80px; I kept the real action type name `screenshot` so the UI matches the API).
23. **"Add 8px top padding to the resource SVGs."** **Accepted** (16px, so the `100%` and `80 MB` labels sit fully inside).
24. **"Failing span shaded across waterfall and resource rows; issue line through all rows."** **Accepted.** Added a shaded band (6.90-11.90 s) beside the dashed line at 9.35 s, across every row and both charts.
25. **"Bars use the engine colour so the session is identifiably Lightpanda."** **Rejected.** That describes their bars; mine stay neutral. State needs to pop (slow amber, failed stripes), and the session's engine is already in the header and in the CPU and memory series (pink diamond).
26. **Browser boot phases as grey bars** (from my own critique of theirs). **Rejected.** The panel is "action waterfall" in PLAN section 7; startup and connect times are in the Details card and don't change what a developer does next. Adding them would also shift every action's offset.
27. **Sample dots on resource lines.** **Accepted** (they were honest about 0.5 s sampling): 2.5px dots at the real sample times.
28. **Root cause adds the CPU reading.** New: "CPU stayed under 15% from 6.5 s to 9.5 s: the page was waiting, not working", derived from the plotted samples.

### Navigation
29. **"Add the workspace scope."** **Rejected.** Not in PLAN section 7 and the lead said no; it is also build time with no user in the plan.
30. **"Saved views in the sidebar (ties to ⌘K)."** **Rejected.** PLAN puts saved views in the ⌘K palette; sidebar entries add scope, and at 1024 two bookmark icons are indistinguishable.
31. **"Drop the outline on the active item (use the filled pill)."** **Accepted.** Active item is a filled pill, no inset ring.
32. **"Label counts with their noun."** **Accepted.** "128 live" on Sessions, "5 open" on Insights. Ingest status line kept in the sidebar footer.
33. **"Top bar keeps the full filter set on every page so context never disappears."** **Compromise.** On Overview the full set stays. On the session page I hide time range, engine and source: they are inert there (a session is a single scope), and the same session identity is carried by the header chips (Real) and engine marker. The top bar there shows breadcrumb, ⌘K and theme.

### Their top three
- Fix waterfall collisions: **done** (21-23, C below).
- Resolve CVD collisions by lightness: **done** (3).
- Rebalance Overview charts: **done** (13).

## C. Render-check problems from promax v1

| Problem (v1 render-check) | Status | Fix |
|---|---|---|
| Page renders unstyled without the Tailwind CDN; console warning | **Accepted, fixed** | Inline CSS, no CDN, no console warning. |
| `end 12.4 s` overlaps the `12 s` tick | **Fixed** | Two-row axis header. |
| `9.35 s` chip covers the `8 s` tick | **Fixed** | Chip lives in the events row, tick row stays clear. |
| `screenshot` spills into `full page` | **Fixed** | Type column 80px (gutter 264px, 248px below 1280px). |
| CPU/Memory top y labels clipped by 7px | **Fixed** | 16px top padding in the SVG. |
| Sessions KPI caption overlaps split bar | **Fixed** | `-mt-1` removed; own spacing. |
| Static tooltip covers `alert at 10%` | **Fixed** | Tooltip pinned in the empty top-left; label below the line. |
| Legends wrap to two lines at 1440 | **Fixed** | One shared nowrap legend. |
| `chrome-headless-shell` wraps in the table | **Fixed** | nowrap, 240px minimum column. |
| Overflow at 1024, token contrast, rendered text contrast | Were already clean | Kept: no new text/background pair is below 4.5:1 (recomputed for the retuned tokens). Lowest remains `fg-subtle` on `surface-2` (the "128 live" count in the active nav pill): 4.80 dark, 4.67 light. |

**CVD flags from the v1 render check** (9 pairs under ΔE 10):

| Flagged pair | v2 outcome |
|---|---|
| dark Chromium vs Healthy (tritan 8.6) | **Fixed** by `ok-fg` lightness (expected >= 12). |
| dark Chromium vs Blocked (protan 5.7, deutan 3.1) | **Fixed by lightness, least certain** (expected about 11-14). |
| dark headless vs Degraded (9.5 / 8.4 / 7.1 / 8.7) | **Fixed** (expected 12-16 under CVD, about 15 normal). |
| dark headless vs Failed (tritan 8.7) | **Not reached** (about 8.7). Covered by marker shape + line style (engine) and icon + word (status). |
| dark Lightpanda vs Failed (tritan 8.3) | **Not reached** (about 8.3). Same cues. |
| light headless vs Lightpanda (tritan 9.6) | **Not reached** (9.6, unchanged). Square vs diamond, dashed vs dotted, names. |
| light Chromium vs Blocked (protan 9.5, deutan 6.6) | **Fixed** by a deeper `blk-fg` (expected about 14-18). |
| light headless vs Degraded (protan 9.5) | **Fixed** by a deeper `warn-fg` (expected >= 15). |
| light Lightpanda vs Degraded (tritan 9.7) | **Fixed** (expected about 13). |

Three remain, all tritanopia only.

## D. What I expect the helper to find in v2

- No horizontal overflow at 1440 or 1024; no overlapping or clipped text on either page; `scrollWidth` equals the viewport.
- Renders offline with the layout intact (only fonts fall back); no console warnings.
- Rendered text contrast: 0 below AA in both themes; lowest around 4.7-4.8 (`fg-subtle` on `surface-2`).
- Token pairs: the changed ones are `ok-fg` 11.6 / 10.2, `warn-fg` 13.0 / 11.1, `blk-fg` 11.9 / 9.6 (dark, on `surface` / own bg) and light `warn-fg` 8.6 / 7.6, `blk-fg` 10.4 / 8.6.
- CVD: see section C. If a protan or deutan pair lands under 10, the first thing I would check is dark Chromium vs Blocked.
- Things I could not verify and would look at first in screenshots: the pinned tooltip's clearance from the Lightpanda baseline at 1440, and the two-column failures list at 1024.

## E. Summary of rejections

Workspace switcher (out of scope); sidebar saved views (⌘K covers it); engine-coloured OK bars in the waterfall; browser boot-phase rows; a rollout/deploy marker (no such event in the schema); moving Degraded to orange-red (would collide with Failed); hue-less hatched Blocked (reasoning in `system.md` 2.2).
