# Lead notes after feedback round 1

Inputs read: `design/BRIEF.md`, PLAN.md sections 1, 5 and 7, both `v1` folders, both `critique-r1.md`, both `v2` folders (system.md, rationale.md, changes.md, render-check.md, all 16 v2 screenshots). The numbers below come from `render-check.md`. Where a designer's own estimate disagrees with it, the render check wins.

## Where the two designs now agree (no more work needed)

The Overview pages are now almost the same layout. Put `promax/v2/screenshots/overview-1440-dark.png` beside `taste/v2/screenshots/overview-1440-dark.png` and the structure matches block for block.

- **Verdict first.** A banner with a 28px status word, one sentence of evidence that includes the most telling number, a four-state distribution bar with counts and icons, and one primary button ("Review N failures").
- **KPI strip.** One card split into 7 cells by 1px dividers. Every cell is a link with an arrow you can see without hovering. Every delta says "vs prior 1 h", and its colour means better or worse, not up or down. A breaching cell gets an edge cue. The strip goes 4 + 3 at 1024.
- **Charts.** One shared engine legend above the chart group. Error rate gets the widest card and a dashed alert line at 10%. Active sessions are stacked per-minute columns against a dashed capacity line. Every chart has a "view as table" button, and the tooltip ends in a link to the sessions.
- **Right rail.** "Recent failures" sits beside the charts at 1440 and moves below them at 1024. Each row has three lines: badge and id, reason code plus the human message, engine plus scenario plus source chip.
- **By engine table.** A status badge on every row, a totals row computed from the rows above, a Top issue column, `chrome-headless-shell` on one line, and columns that hide at 1024 so nothing scrolls sideways.
- **Session page.** Global filters are hidden, with breadcrumb, ⌘K and theme left in the top bar. A root-cause banner sits above the timeline. Waterfall, CPU and memory share one x axis with a two-row axis header, a shaded failing span and an issue line through every row. The type column is 80px. Slow bars are amber and failed bars are red. Unsupported JS heap is a "Not available" frame. A "checkout-form on each engine" card shows the comparison.
- **Rules.** 12px minimum text size. Engine colour is never text colour. Status is always icon + word. Engines are always colour + marker shape + line style. No workspace switcher, user row or settings. Inline CSS, and both mockups render offline.
- **Objective quality.** Both mockups have 0 rendered text nodes below AA in both themes, no horizontal overflow at 1440 or 1024, and every claimed contrast value matched the helper to within 0.2.

## Real disagreements left

| # | Topic | promax v2 | taste v2 | Facts from render-check |
|---|---|---|---|---|
| 1 | Blocked status | Violet hue, `ban` icon, word | Hue-less outline, `ban` icon, ink word, hatched where it is a fill | promax: dark Chromium vs Blocked protan **8.75** (only protan/deutan flag). taste: no blocked flag, but its hatch also means "sim" in its own source strip |
| 2 | Engine palette | Okabe-Ito: blue, orange, pink | Lightness ladder: blue, pink, cyan | promax engine vs engine: every protan/deutan pair >= 11.0, the only miss is tritan 9.6 (light). taste: light headless vs Lightpanda **deutan 8.71**, and Lightpanda light on a hovered row is **2.70:1** (non-text, below 3:1) |
| 3 | Fonts and KPI weight | Inter + JetBrains Mono, KPI 26/600 | IBM Plex Sans/Mono, KPI 22/500 | Both pass. Plex `tnum` is still unverified, and 26px sits close to the 28px status word |
| 4 | Waterfall OK bars | Neutral slate bar | Engine-coloured bar, plus boot-phase rows | promax: gridlines and the failure line cross the `2.45 s · failed` labels. taste at 1024: Issues come before the waterfall, so the waterfall starts at y = 1101 |
| 5 | Real/sim in charts | Source strip only under Active sessions | Source strip under every time chart | Not disputed. taste covers more |
| 6 | Error-rate annotation | Spike band + "Spike 14:21-14:28 · 31 failed". Rejects a rollout marker (no deploy event) | "14:12 Lightpanda v0.2.9 rollout" marker + labelled peak | PLAN section 5: `session.started` carries `engine_version`, so "new version first seen" can be derived without a deploy event |
| 7 | Saved views | ⌘K only | Sidebar section with distinct icons | PLAN section 7 puts saved views in ⌘K |
| 8 | Minor layout defects | Chart pair 4px wider than its column. Rail ends 10px above the charts. "Raw events" tab is not in PLAN | Resource caption runs into the plot. Failure line crosses the "Not available" text (promax has this too) | All objective |

What I would have asked each designer for a v3:

1. **Blocked.** promax: show a non-colour fix for the 8.75 protan pair. taste: explain how a hatched blocked and a hatched sim stay distinct in one system.
2. **Engine palette.** taste: fix deutan 8.71 and the 2.70:1 hover without breaking the ladder. promax: no action.
3. **Fonts and KPI weight.** Both: agree one KPI size that leaves the status word clearly dominant.
4. **Waterfall bars.** promax: give duration labels a background. taste: put the waterfall before Issues at 1024.
5. to 8. Small fixes a developer can make from a written rule.

## Call: **close**

Reasons:

1. **What is left is either a taste call or a fix I can write as a rule.** No open item needs a new mockup. Each of the items numbered 2 to 8 above has a clear answer from the render-check facts or from PLAN, and the blocked choice (item 1) is a judgement call that a v3 would not settle any better. The two layouts already converged in round 1.
2. **Both CVD problem lists are short, and one palette is clearly safer where it matters most.** Engines are what every chart has to tell apart. promax's engine-vs-engine pairs all pass protan/deutan, while taste's only flag is a deutan engine-vs-engine pair (deuteranomaly is the most common CVD). So I take promax's measured palette **as a whole**: all 26 token pairs and the 0 rendered failures stay valid, and I do not have to trust an unmeasured mix.
3. **Time.** The deadline is this weekend. Another round costs a critique + revise + render-check cycle and would most likely move a few colour values. Frontend work is blocked until Eyal approves.

The closing decision, scores and final system are in `design/DECISIONS.md` and `design/DESIGN.md`. Open questions for Eyal are at the end of DECISIONS.md.

### How each open item is resolved (summary, details in DECISIONS.md)

| # | Resolution |
|---|---|
| 1 | **Violet blocked (promax).** In this combined system hatch means "simulated" and nothing else, so a hatched blocked would give one pattern two meanings. The remaining protan 8.75 pair is engine vs status. Those two never share a mark type: status is always a badge with icon + word, engine is always a shape marker + name, and blocked is never drawn as a series in an engine chart. Accepted and documented. Eyal can still ask for a quieter blocked (open question). |
| 2 | **promax engine palette**, with taste's dash-dot line for Lightpanda (a dotted line loses weight on the series that usually carries the spike). |
| 3 | **Inter + JetBrains Mono** (promax: known-good tabular figures, shadcn default). **KPI value 22/600** (taste's size, so the 28px status word stays the clear lead). |
| 4 | **Neutral OK bars (promax).** Lightpanda pink beside a failed red bar would be a hue collision. No boot rows (startup and connect go in the stat strip). Duration labels sit on a surface-coloured pill drawn above the gridlines and the failure line. At 1024 the timeline comes before Issues. |
| 5 | **Source strip under every time chart (taste).** |
| 6 | **Optional version marker, labelled "Lightpanda v0.2.9 first seen"** (derived from `engine_version`, so it is honest that we saw the version, not a deploy). Cut first if behind. Spike band kept. |
| 7 | **No sidebar saved views (promax).** ⌘K only, as PLAN says. |
| 8 | Written as rules in DESIGN.md: `min-w-0` on every grid child, rail and charts stretch to one height, no "Raw events" tab, captions stay in their column, "Not available" frames sit above chart lines. |
