# Critique of promax v1 (by Taste, round 1)

Sources: promax `system.md`, `rationale.md`, `render-check.md`, and these screenshots: overview 1440 dark and light, overview 1024 dark, session 1440 dark. I did not open the other 1024 and light session shots, so my claims about those come only from render-check. I compared against my own v1 screenshots and render-check.

Overall: promax is the stronger product story. Its Overview and Session pages carry more evidence per screen (error messages in the failures list, retry action, per-engine compatibility card, hover spike tooltip with "31 failed sessions, Open"). Mine is the cleaner and denser system. Its main weaknesses are collisions and wasted space, not direction.

## Colors and themes

**Stronger in theirs.** Blocked has its own hue (violet) beside a different icon, so "the site said no" separates from "we broke" at a glance. My blocked is a grey outline, which reads weaker in the failure list. Their light theme is also fully re-derived: 25 token pairs pass, and there are no rendered text failures in either theme. Mine has one real AA failure ("v0.2.9" in Lightpanda cyan, 3.06:1 in light).

**Stronger in mine.** I keep status hues (green, amber, vermillion) and engine hues (blue, pink, cyan) apart by design. They put headless-shell orange next to degraded yellow and Lightpanda pink next to failed red, and say so in system.md section 2.3. Render-check shows the cost: dark headless `#E69F00` vs warn `#F2C14E` is ΔE 9.5 even with normal vision (7.1 deuteranopia), and dark Chromium blue vs blocked violet is ΔE 3.1 under deuteranopia. Mine also has a flagged pair (headless pink vs blocked grey, ΔE 3.1 deuteranopia), so neither of us is clean.

**Suggestion.** Fix by lightness, not hue: raise dark `blk-fg` toward `#D4C4FF` and set `warn-fg` toward `#FFD76A` against headless `#E69F00`. Then re-run the CVD table. Alternatively move degraded to an orange-red icon-led state and let headless keep amber.

## Typography

**Stronger in theirs.** Inter has reliable tabular figures and a 12px minimum. JetBrains Mono for targets, ids and error codes makes the page read as an engineering tool (screenshots: `unsupported_api` and selectors in mono in the banner and waterfall). My Plex pair has more character, but I used 11px for axes and chips and proportional text for selectors.

**Stronger in mine.** Fewer sizes and a single lead (28px status word, 22px KPI at weight 500). Their 26px/600 KPI values plus sparklines make the strip heavier. Their chart cards spend about 110px on a title, a wrapped subtitle and a two-line legend before any plot begins (visible in the Error rate card at 1440).

**Suggestion.** Make the chart subtitle one line, and keep every legend and table header `whitespace-nowrap`. Render-check shows `chrome-headless-shell` wrapping to two lines in the engines table, and the "p95 latency" header wrapping in the screenshot.

## KPI cards

**Stronger in theirs.** A breaching card gets a 3px left border in the status colour (Success rate in the screenshot), so the eye lands on the right KPI. Whole-card link plus a visible arrow is a clear drill-down. The real/sim split bar on the Sessions card puts data honesty at the number itself. Mine only colours the delta.

**Stronger in mine.** One divided container, about 100px tall against their 138px, no sparklines, and every delta names its window ("vs prior 1 h"). Theirs mixes "vs prev", "vs 1h ago" and "+12% vs prev", which does not say what the baseline is. Render-check also finds their `741 real · 1,185 sim` line overlapping the split bar by 4px; it shows in the 1440 screenshot.

**Suggestion.** Keep the left-border breach cue, but drop sparklines from the six cards that are not breaching. Name one baseline everywhere ("vs prior 1 h"), and remove the `-mt-1` that collides the split-bar caption.

## Charts

**Stronger in theirs.** Per-engine dash styles (solid, dashed, dotted) add a third channel for engine identity; I only use shape markers at line ends. The hover tooltip ends with a drill-down row ("31 failed sessions, Open") and a spike band marks the minute. Stacked areas for actions per minute show composition. Both are good ideas I should take.

**Stronger in mine.** The error-rate chart, which carries the story, gets two thirds of the width with an annotated cause (14:12 rollout), a labelled peak (21.4% at 14:32) and a dashed alert threshold. In theirs it is a one-third card, its plot is about 190px tall, and at 1440 the static tooltip covers the threshold label (render-check: only "ale" visible). One legend serves all three charts instead of three wrapped legends.

**Suggestion.** Widen Error rate to at least half the row. Use one shared engine legend that also shows live values, and move the static tooltip so it never sits on the threshold label.

## Tables

**Stronger in theirs.** The engines table has an inline success bar next to each rate, and the failures list shows the human error message ("IntersectionObserver is not defined", "Renderer killed at 2.1 GB (OOM)"). That is more useful than my code-only rows.

**Stronger in mine.** A status badge per engine row (Healthy, Degraded, Failed) and a totals row computed from the rows above. Their table stretches to the failures rail and leaves roughly 130px of blank card under the Fleet row in the 1440 screenshot. The first column is also squeezed, so `chrome-headless-shell` wraps.

**Suggestion.** Let the table keep its own height, or fill that space with the per-engine rows' missing detail (active now, CPU). Widen the engine column to fit `chrome-headless-shell` on one line.

## Session waterfall

**Stronger in theirs.** The story is richer: a retry shows as a second failed action, the selected row is highlighted, there is a detail strip under the timeline, a "checkout-form on each engine" card (38/38, 38/38, 3/27) and screenshot placeholders. That answers "why" faster than my rail does.

**Stronger in mine.** The shared axis really behaves like one: the failing span is shaded across waterfall and resource rows, the issue line drops through all rows, and bars use the engine colour so the session is identifiably Lightpanda. Their bars are neutral grey-blue. Mine has no label collisions at the axis. Theirs has four, per render-check: `end 12.4 s` overlaps the `12 s` tick ("end 1224 ss"), the `× 9.35 s` chip covers the `8 s` tick, `screenshot` runs into `full page`, and the top y labels of CPU and memory are clipped by 7px. Mine also has the `screenshot` spill, which I will fix.

**Suggestion.** Give the axis header two rows (events above, ticks below) so the failure chip and end label never sit on a tick. Widen the type column to 80px or shorten to `shot`. Add 8px top padding to the resource SVGs.

## Navigation

**Stronger in theirs.** Per-page counts ("Sessions 1,926", "Insights 5") and the ingest and lag status at the bottom are useful. The top bar keeps the full filter set including the `62% SIM` chip on every page, so context never disappears.

**Stronger in mine.** A workspace switcher at the top and saved views in the sidebar (which tie to ⌘K), a breadcrumb on the session page, and an active item that is a plain grey pill. In their 1440 dark shot the active Overview item has a ring that looks like a focus outline. A bare count "Sessions 1,926" also does not say what it counts.

**Suggestion.** Add the workspace scope and drop the outline on the active item (use the filled pill). Label counts with their noun: "5 open" on Insights.

## Top 3 suggestions for promax

1. Fix the session waterfall collisions (axis header, `screenshot` column, clipped y labels). They undercut the best "why" story in either proposal.
2. Resolve the colour-vision collisions by lightness: blocked violet against Chromium blue (ΔE 3.1) and headless orange against degraded yellow (ΔE 9.5 in normal vision).
3. Rebalance Overview charts: widen Error rate, share one legend, and stop the static tooltip covering the alert-threshold label.
