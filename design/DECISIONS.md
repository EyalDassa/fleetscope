# Design decisions: Fleetscope dashboard

Status: **proposed, waiting for Eyal's approval.** Frontend work starts only after approval.
The design sprint closed after feedback round 1. The reasoning is in `design/rounds/r1-lead-notes.md`.
Final versions compared: `design/proposals/promax/v2` and `design/proposals/taste/v2`.
Every contrast and colour-vision (CVD) number below comes from the helper's `render-check.md`. Hand estimates are marked "est.".

## 1. Decision per area

| Area | Winner | One-sentence reason |
|---|---|---|
| Color tokens and themes | **combined**: promax values, taste structure | promax's whole palette was measured together (26/26 token pairs pass, 0 rendered text failures in both themes), and taste's complete shadcn mapping plus a typed `ENGINES`/`STATUSES` map is the better way to ship it. |
| Status and engine colors | **promax** (+ taste's dash-dot for Lightpanda) | Every engine-vs-engine protan/deutan pair is ≥ 11.0, while taste's only flag is an engine-vs-engine deutan pair (8.71); violet blocked keeps hatch free to mean "simulated" and nothing else. |
| Typography | **combined**: promax fonts, taste KPI size | Inter + JetBrains Mono have known-good tabular figures and are the shadcn default, and a 22px KPI value keeps the 28px status word as the clear lead. |
| Spacing | **promax** | The two scales are the same (4px base, 12 gutter, 16 card padding, 40px rows, 28px waterfall rows); promax's collapse breakpoint of 1280px is Tailwind's `xl`, so no custom breakpoint is needed. |
| Navigation shell | **promax** | Five product areas, counts with a noun, collector status in the footer, a sim-share chip next to the source filter, saved views in ⌘K only (as PLAN section 7 says). |
| KPI cards | **combined** | Taste's lighter cell (22px, no sparklines), plus promax's status-coloured 3px breach edge, real/sim split bar on Sessions and capacity track on Active. |
| Chart cards | **taste** (+ promax's tooltip link row and spike band) | Source strip under every chart, dash per engine, compact plots and one annotation answer more per pixel; promax adds the clearest drill-down cue ("3 failed this minute, Open"). |
| Tables | **taste** (+ promax's source chip and `th scope`) | Reason code and message on the second line of each failure row, a Top issue column, no inline bars; the hollow/filled dot on promax's chip is a shape cue, not only a border style. |
| Session waterfall | **promax** (+ taste's issues panel and stat strip) | Neutral OK bars let slow and failed bars stand out, the selected row and its detail strip tell the story, and the timeline stays above Issues at 1024; taste's issue text ("Follows from unsupported_api: the handler never ran") is the best "why". |
| Empty and error states | **taste** (+ lead-defined states) | "Zero prints 0, missing is a dash, unsupported is a dashed Not available frame" is the clearest honest-data rule; neither mockup drew loading, error or disconnected states, so DESIGN.md defines them. |

Coherence check: **one palette** (promax v2 values, both themes), **one type scale** (28 / 22 / 20 / 14 / 13 / 12), **one spacing scale** (4 / 8 / 12 / 16 / 24), **one meaning per pattern** (hatch = simulated, dashed frame = not available, stripes are not used).

## 2. Scores (final versions, 1 to 5)

Columns: **G** answers at a glance · **D** density without clutter · **Dr** drill-down clarity · **A** accessibility · **B** easy to build with shadcn/ui + Recharts by Saturday. "–" means the criterion does not apply to that area.

| Area | promax G | D | Dr | A | B | taste G | D | Dr | A | B |
|---|---|---|---|---|---|---|---|---|---|---|
| Color tokens and themes | 4 | 4 | – | 5 | 4 | 4 | 4 | – | 4 | 5 |
| Status and engine colors | 5 | 4 | – | 4 | 4 | 4 | 4 | – | 3 | 4 |
| Typography | 4 | 3 | – | 5 | 5 | 5 | 5 | – | 4 | 4 |
| Spacing | 4 | 4 | – | 4 | 5 | 4 | 5 | – | 4 | 4 |
| Navigation shell | 4 | 4 | 4 | 4 | 5 | 4 | 4 | 4 | 4 | 4 |
| KPI cards | 5 | 3 | 5 | 5 | 4 | 4 | 5 | 4 | 4 | 5 |
| Chart cards | 4 | 3 | 5 | 4 | 4 | 5 | 5 | 4 | 5 | 4 |
| Tables | 4 | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| Session waterfall | 5 | 4 | 5 | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| Empty and error states | 3 | – | – | 4 | 4 | 4 | – | – | 4 | 5 |
| **Sum** | **42** | **33** | **23** | **44** | **44** | **43** | **41** | **20** | **40** | **44** |

What drives the scores:
- **promax A (accessibility) is higher** because of colour vision: its 4 remaining flags are 1 engine-vs-status protan pair (8.75) and 3 tritanopia pairs (8.27 to 9.59). Taste has 1 flag, but it is engine vs engine under deuteranopia (8.71). Taste also has one non-text value below 3:1: Lightpanda light on a hovered row, 2.70:1.
- **taste D (density) is higher.** At 1440 its Overview is 1121px tall against promax's 1371px. Its plots are 132 to 168px, and its KPI strip has no sparklines.
- **promax Dr (drill-down) is higher.** It has the tooltip link row, the "Jump to action #9" and "Similar sessions · 24" buttons, and the selected-action detail strip.
- **Typography:** promax's 26/600 KPI value sits too close to the 28px status word (D 3). Plex's `tnum` was never verified (taste A 4, B 4).
- **Waterfall:** promax loses a point on A because gridlines and the failure line cross the `2.45 s · failed` labels. Taste loses on G at 1024, where the waterfall starts at y = 1101, below Issues.

## 3. Key judgement calls

1. **Blocked is violet (promax), not a hue-less outline (taste).** Both systems already use hatch to mean "simulated", so a hatched blocked would give one pattern two meanings. A grey badge also looks like "running" or disabled UI. The cost is one CVD pair: dark Chromium `#56B4E9` vs Blocked `#D9CCFF` under protanopia, ΔE 8.75. I accept it because the two never share a mark type. Status is always a badge with icon + word; an engine is always a shape marker + name; blocked is never plotted as a series in an engine chart. Eyal can ask for the quieter version (open question 4).
2. **The palette is taken whole from promax v2.** I did not mix taste's neutrals with promax's hues. Mixing would make every measured contrast and ΔE value unverified, two days before the deadline.
3. **Failed waterfall bars are solid red, not striped.** Each bar keeps an X icon and the word "failed". This keeps the rule "hatch and stripes mean simulated, nothing else".
4. **Version marker, not "rollout".** Taste's "14:12 Lightpanda v0.2.9 rollout" claims a deploy event the schema doesn't have. promax was right about that, but `session.started.engine_version` lets us honestly show "Lightpanda v0.2.9 first seen". It is optional and the first thing to cut.
5. **Issues is an always-visible side panel on the session page, not a tab.** Both designers did this, and it shortens "why did it fail" to zero clicks. Tabs are Timeline, Network and Screenshots. promax's "Raw events" tab is dropped because it is not in PLAN.
6. **Status and reason are separate.** Badges show only Healthy, Degraded, Failed, Blocked (plus a neutral "Running" dot). `timeout` and `crashed` are Failed badges with the reason code in mono beside them. promax v2 had a separate "Timeout" badge, which would make a fifth state.

## 4. How the feedback rounds changed the designs

**v1 → v2 (round 1).** Each designer critiqued the other and answered every point in `changes.md`. The helper's render checks gave both of them objective defects to fix.

- **Convergence on Overview.** promax took taste's composition: right-rail failures, one divided KPI strip, deltas that name their window ("vs prior 1 h"), the 28px status word, one shared legend, a capacity line in Active sessions, and a status badge per engine row. Taste took promax's evidence features: human error messages in failure rows, a Top issue column, arrows on KPI cells that show without hovering, "view as table" buttons, dash styles per engine, and a real/sim source strip inside the charts. By v2 the two Overviews are almost block-for-block the same.
- **Collisions fixed.** promax v1 had 9 render-check layout problems: the `end 12.4 s` label on a tick, the failure chip on the `8 s` tick, `screenshot` spilling its column, clipped y labels, the KPI caption overlapping its bar, the tooltip covering the alert label, wrapped legends, a wrapped engine name, and an unstyled page without the CDN. All are fixed in v2. Taste's one AA failure (engine colour used as text, 3.06:1) and the shared `screenshot` spill are fixed.
- **Colour vision.** promax went from 9 flagged pairs to 4 by moving status colours in lightness. Taste went from 4 to 1, but its re-laddered engine palette created a new deutan flag (headless vs Lightpanda, 10.6 → 8.71) and pushed Lightpanda light to 2.70:1 on hover. That trade is why the final palette is promax's.
- **Scope trimmed toward PLAN.** Taste removed the workspace switcher, user row, Settings link and "Raw events" tab. promax declined to add them. Both moved open product questions (thresholds, default source filter) to Eyal instead of guessing.
- **Round 2 skipped.** What was left was either a judgement call (blocked hue, font) or a written rule (label backgrounds, `min-w-0`, panel order at 1024). With the weekend deadline, the lead closed rather than spend another critique, revise and render-check cycle.

## 5. Open questions for Eyal

1. **Status thresholds.** promax proposed 95/85 and taste 95/90. **Default in DESIGN.md:** success ≥ 95% is Healthy, 90 to 95% is Degraded, below 90% is Failed, for the fleet and for each engine. The fleet verdict is the worst of: success rate, the error rate crossing the 10% alert line, and capacity above 90%. OK?
2. **Does `blocked` count against the success rate?** **Default:** yes. Success rate = (healthy + degraded) / ended sessions, so blocked counts as not successful, as in both mockups.
3. **Default source filter.** **Default:** `All`, with the sim share always visible (top-bar chip, source strips, chips on rows). The alternative is `Real` by default.
4. **Blocked colour.** Violet (decided) or taste's quieter hue-less outline with a `ban` icon? Violet is louder at a glance and costs one protan pair at ΔE 8.75.
5. **Version marker on Error rate** ("Lightpanda v0.2.9 first seen", derived from `engine_version`). Keep it as a stretch item, or drop it now?
6. **Issues as an always-visible side panel** instead of a tab on Session detail (PLAN section 7 says "network and issues tabs"). OK to update PLAN to match?

**Answered by Eyal on 2026-10-22:** approved DESIGN.md with every default above. Thresholds 95/90; blocked counts against the success rate; the default source filter is `All`, with the sim share always visible; blocked stays violet; the version marker stays as a stretch item (first to cut); Issues is an always-visible side panel, and PLAN section 7 is updated to match.
