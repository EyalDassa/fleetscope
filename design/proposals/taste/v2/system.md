# Fleetscope design system (Taste, v2)

Quiet, dense monitoring tool. Dark is the default theme (true neutral greys), light is a full second theme. Colour is reserved for data (three engines) and status (healthy, degraded, failed; blocked is deliberately hue-less). Dials unchanged: VISUAL_DENSITY 8, DESIGN_VARIANCE 4, MOTION_INTENSITY 2.

**How the numbers were produced.** Contrast ratios are hand-computed WCAG 2.x values; v1's were all confirmed by the render helper (26/26 within 0.2), so the method holds. Colour-vision (CVD) values for v2 are **hand estimates**: I simulated the worst pairs with the Machado 2009 matrices by hand and estimated CIEDE2000 from lightness (L*) and chroma gaps. The render helper will give the real numbers; where I expect a miss I say so.

## 1. Principles

1. **Answer first, evidence next.** The fleet status is the largest thing on Overview, next to the one finding and the one job ("Review 114 failures").
2. **Colour is data or status, never chrome.** Sidebar, top bar, buttons, cards are grey. Hues: three engines, three statuses.
3. **Never colour alone.** Status = icon + label + tint (blocked: icon + label + outline + hatch). Engine = colour + marker shape + line dash + name. Source = word + border style + a hatched share inside every chart.
4. **Every number is a door.** KPI cells, rows and chart points open the sessions behind them; the destination arrow is visible at rest.
5. **Honest empties.** Zero prints `0`, missing is a dash, an unsupported metric is a dashed "Not available" frame with the reason.

## 2. Color tokens

shadcn mapping in section 6.

### 2.1 Neutrals (unchanged from v1)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ground` | `#0B0B0C` | `#F5F5F6` | page, sidebar, top bar |
| `--surface` | `#121214` | `#FFFFFF` | cards, tables |
| `--raised` | `#1A1A1D` | `#EFEFF1` | hover row, kbd, popovers |
| `--active` | `#1E1E22` | `#E9E9EC` | active nav, selected segment |
| `--border` | `#26262A` | `#E3E3E7` | card and row edges (decorative) |
| `--control` | `#63636A` | `#8A8A92` | control borders (3:1) |
| `--text` | `#F2F2F3` | `#111113` | primary |
| `--muted` | `#B0B0B6` | `#55555C` | labels, secondary |
| `--faint` | `#8E8E95` | `#67676F` | meta, axes, placeholders |
| `--grid` | `#26262A` | `#E6E6EA` | chart grid (decorative) |

**Text contrast (need 4.5:1)**, ground / surface / raised / active:

| Pair | Dark | Light |
|---|---|---|
| `--text` | 17.6 / 16.7 / 15.5 / 14.9 | 17.3 / 18.9 / 16.4 / 15.6 |
| `--muted` | 9.1 / 8.7 / 8.0 / 7.7 | 6.8 / 7.4 / 6.4 / 6.1 |
| `--faint` | 6.0 / 5.7 / 5.3 / 5.1 | 5.1 / 5.6 / 4.9 / 4.6 |

Primary button: 17.6 dark, 18.9 light. Control border vs surface: 3.1 dark, 3.4 light. Focus ring: 16.7 / 18.9.

**Rule (new, from the v1 AA failure): engine colours are never text colours.** They are used on markers, line samples, bars and fills only. Version strings and names are `--text` or `--muted`. In v1 the Lightpanda version string inherited the engine colour and measured 3.06:1 in light.

### 2.2 Status

| State | Meaning | Icon | Label |
|---|---|---|---|
| healthy | succeeded cleanly | `circle-check` | Healthy |
| degraded | succeeded with a retry, a slow action (over its p95) or a logged issue | `triangle-alert` | Degraded |
| failed | `failed`, `timeout`, `crashed` | `circle-x` | Failed |
| blocked | `blocked` (bot wall, captcha) | `ban` | Blocked |

| Token | Dark text/fill | Dark tint bg | Light text/fill | Light tint bg |
|---|---|---|---|---|
| `--healthy` | `#3FC07A` | `#12281C` | `#17683F` | `#DDF3E6` |
| `--degraded` | **`#F2BC48`** (was `#E8A93A`) | `#2B2110` | `#8A5A00` | `#FBF0D6` |
| `--failed` | `#F4694B` | `#2D1912` | `#B8321A` | `#FCE5DF` |
| `--blocked` (outline, icon, hatch only) | **`#7E7E86`** (was `#A6A6AE`) | none | `#3D3D44` | none |

`--on-failed` (label on a solid failed bar): `#0B0B0C` dark (6.5), `#FFFFFF` light (6.0). New `--on-degraded` (label on a slow bar): `#0B0B0C` dark (11.3), `#FFFFFF` light (5.9).

**Contrast, text on surface / on tint:** healthy 8.1 / 6.7 dark, 6.8 / 5.8 light. degraded **10.8 / 9.1** dark (was 9.1 / 7.7), 5.9 / 5.2 light. failed 6.2 / 5.5 dark, 6.0 / 5.0 light.

**Blocked, decided deliberately: stays hue-less.** It is "not a clean outcome and not our fault", which is neither a success nor a breakage, so a neutral reads as its own category. It is never grey text on grey: the badge is an **outlined** chip with the `ban` icon, an ink label (`--text`, 16.7 dark / 18.9 light) and a `--blocked` outline. Wherever it is a fill (distribution bar, legends) it is **hatched**, with a minimum segment width of 8px so the hatch always shows. `--blocked` is only used for outline, icon and hatch (non-text, needs 3:1): 4.65 dark on surface, 10.8 light. In v1 the dark grey (`#A6A6AE`) sat at the same lightness as the headless-shell pink and collapsed to ΔE 3.1 under deuteranopia; v2 moves it down to a darker grey so lightness, not hue, separates them.

Status thresholds (proposal, an open question for Eyal): success >= 95% Healthy, 90 to 95% Degraded, < 90% Failed; success counts healthy + degraded.

### 2.3 Engines (changed: lightness ladder)

Engines separate by **hue, lightness and shape**. In dark the ladder is Chromium (darkest blue) < headless-shell (mid pink) < Lightpanda (lightest cyan). In light the same order runs dark to light.

| Engine | Marker | Line | Dark | Light | Non-text contrast on surface (dark / light) |
|---|---|---|---|---|---|
| Chromium | circle | solid | **`#3A7FD6`** (was `#4C9BE6`) | **`#174C96`** (was `#1A5FB4`) | 4.6 / 8.4 |
| chrome-headless-shell | square | dashed `7 4` | `#D98AB8` | **`#C8559C`** (was `#B8408A`) | 7.4 / 4.0 |
| Lightpanda | diamond | dash-dot `9 3 2 3` | **`#96E6F3`** (was `#6FD6E6`) | **`#17A0BA`** (was `#139AB2`) | 13.3 / 3.1 |

Approx. CIE L*: dark Chromium 53, headless-shell 67, Lightpanda 87. Light Chromium 33, headless-shell 53, Lightpanda 61.
Known limit: Lightpanda light is 3.1:1 on `--surface` (passes 3:1) but 2.7:1 on a hovered `--raised` row; it is always paired with a name there. It cannot be darker without colliding with headless-shell under deuteranopia.

### 2.4 CVD check (expected values, dark and light; helper to confirm)

Target: engine-vs-engine and engine-vs-status CIEDE2000 >= 10 under protanopia (P), deuteranopia (D), tritanopia (T).

| Pair (theme) | v1 measured (worst of P/D/T) | v2 hand estimate | What changed |
|---|---|---|---|
| headless vs blocked (dark) | 3.1 (D) | **~13 (D), ~12 (P)** | blocked darker: lightness gap 15 L* |
| headless vs degraded (dark) | 8.9 (T) | **~12 (T)** | amber lighter: simulated T colours rose-pink vs salmon, gap ~12 |
| Lightpanda vs healthy (dark) | 9.4 (T) | **~12 (T)** | Lightpanda lighter: gap 18 L* |
| Chromium vs headless (dark) | 10.0 (P) | **>= 20 (P)** | Chromium darker: gap 14 L* |
| headless vs Lightpanda (dark) | 10.2 (D) | **~14 (D)** | Lightpanda lighter: gap 21 L* |
| Chromium vs healthy (dark) | 10.0 (T) | **~12 (T)** | gap 15 L* |
| Chromium vs headless (light) | 7.9 (P) | **~15 (P)** | gap 20 L* |
| headless vs Lightpanda (light) | 10.6 (D) | **~12 (D)** | chroma gap in D, L* gap only 8 |
| headless vs degraded (light) | 11.2 (T) | ~12 (T) | n/a, was passing |

**Where I may still miss:** (1) headless vs Lightpanda in light under deuteranopia (~12, hand estimate on a thin margin); (2) any T pair involving the amber, because tritanopia collapses blue-yellow. Cues that cover a miss: headless-shell is a square with a dashed line, Lightpanda a diamond with a dash-dot line, Chromium a circle with a solid line; status is always a triangle/circle icon plus a word, in badges that are never the same element type as an engine marker.

### 2.5 Real vs simulated

| Source | Treatment |
|---|---|
| `real` | chip "real": solid 1px `--control` border, `--muted` text |
| `sim` | chip "sim": **dashed** 1px `--control` border, `--text` text |

**In charts (new in v2):** every time chart carries a 6px **source strip** under its x labels. Each one-minute cell is split: solid `--faint` for the real share, diagonal hatch (`--faint` lines) for the sim share. A key ("real, sim") sits in the shared legend row, and the tooltip adds "Source real 66%, sim 34%". The title row keeps the mix line ("1,214 real, 628 sim, 34%"). When the filter is `sim` only, the whole canvas gets a dashed outline and a notice "Simulated data only". Default filter is an open question (see rationale).

## 3. Typography

IBM Plex Sans + IBM Plex Mono (ids, selectors, error codes, waterfall types). Fallback Inter. **12px floor** (changed from 11px). Numbers use `font-variant-numeric: tabular-nums`; v1's render showed digits aligned, still confirm in M0.

| Role | Size / line / weight |
|---|---|
| status lead | 28 / 32 / 600 |
| KPI value | 22 / 28 / 500 |
| page title | 20 / 26 / 600 (session id in mono) |
| card title, brand | 14 / 20 / 600 |
| body, cells, nav, buttons | 13 / 20 / 400 |
| label, meta, axis, chip, kbd, bar label | 12 / 16 / 400-500 |
| mono ids and codes | 12 / 16 / 400 |

Six sizes (v1 had eight). Units are a 12px `--muted` suffix. Fixed decimals per metric, a sign on every change, every delta names its baseline ("vs prior 1 h").

## 4. Spacing, radius, elevation, motion

4px base. One gutter of 12px. Card padding 16. Canvas padding 24 (16 under 1100px). Heights: top bar 48, nav row 32, control 28, table row 40, waterfall row 28, badge 20, chip 20. Radius: card 8, control 6, badge and chip 4. No resting shadows; shadow only on popover, palette, tooltip. Motion: 100ms colour change on hover; no entrances; charts update in place (`isAnimationActive={false}`). Sidebar 232px (56px icon rail under 1100px), Overview rail 400px, Session rail 360px.

## 5. Component rules

**KPI strip.** One card split by 1px dividers; label 12, value 22/500, unit 12 muted, subline 12 with its baseline. Every cell is a link and shows a faint `arrow-up-right` at rest (top right). **A breaching cell** (metric moved the bad way past its threshold) gets a 2px `--failed` top rule; colour on a delta means better or worse, never up or down; a hidden "worse" for screen readers. No icons, no sparklines. Count follows the grid: 7 at 1440, 4 + 3 under 1100px.

**Chart card.** Header: title (14/600) left; current value and a 24px "View as table" icon button right. Plot 132 to 168px; 4 to 6 horizontal gridlines; no y-axis line; ticks 12px `--faint`; x labels every 10 min, end unlabeled; lines 2px with **dash by engine** and an end marker; stacked columns with 1px surface seams; one dashed reference line with label; at most one event annotation. **One shared legend** for the chart group: line sample + marker + name per engine, plus the source key. Tooltip: time, one row per series, source split, "Click to open sessions".

**Table row.** Header 12 muted, no fill, one rule; rows 40px, 1px `--border` between; identity widest; numeric columns right aligned, tabular, unit suffix; engine cell = marker + name (+ version muted); one status mark per row; totals row under a `--control` rule, computed from the rows above; **Top issue** column (mono code + count). Under 1100px the CPU and Memory columns hide.

**Failure row (list).** Three lines: status badge, session id, time; reason code (mono) + message; engine marker + name, scenario, source chip right.

**Status badge.** 20px, radius 4, 12/500, 14px icon + label. healthy/degraded/failed: tint + same-hue text. blocked: outline `--blocked`, ink label, `ban` icon. Never icon-only.

**Timeline bar.** Row 28, bar 14, radius 2, minimum 3px. OK = engine colour; **slow = `--degraded` fill** with a triangle in the label column; failed = `--failed` with a circle-x in the label column and the reason inside the bar. Label column 280px: seq (20), type in mono (**80px**, was 66), target (ellipsis). Duration label after the bar (before it past 82%); inside it when the bar is >= 2 s. Browser phases are `--faint` bars. Shared x axis: waterfall and resource charts live in one grid, 2 s vertical gridlines, failing span shaded 8% `--failed` across all rows, issue line in `--failed`, one crosshair with a tooltip (running action, CPU, memory). Axis header has two lines: events above, ticks below. Unsupported metrics are a dashed "Not available" frame.

**Navigation.** Sidebar: mark + name, five pages, "Saved views" with **distinct icons** (trending-down for "Lightpanda regressions", ringed dot for "Real traffic only"), collector health at the bottom. No workspace switcher, no user row, no settings (not in PLAN.md section 7). Counts carry their noun ("4 open"). Under 1100px: 56px icon rail with a 1px separator before the saved views.

## 6. shadcn token mapping

```css
:root, :root[data-theme="dark"] {
  --background:#0B0B0C; --card:#121214; --popover:#1A1A1D; --muted:#1A1A1D; --accent:#1E1E22;
  --border:#26262A; --input:#63636A; --ring:#F2F2F3;
  --foreground:#F2F2F3; --muted-foreground:#B0B0B6; --faint:#8E8E95;
  --primary:#F2F2F3; --primary-foreground:#0B0B0C; --destructive:#F4694B;
  --healthy:#3FC07A; --healthy-bg:#12281C; --degraded:#F2BC48; --degraded-bg:#2B2110;
  --failed:#F4694B; --failed-bg:#2D1912; --blocked:#7E7E86; --on-failed:#0B0B0C; --on-degraded:#0B0B0C;
  --engine-chromium:#3A7FD6; --engine-headless:#D98AB8; --engine-lightpanda:#96E6F3;
}
:root[data-theme="light"] {
  --background:#F5F5F6; --card:#FFFFFF; --popover:#FFFFFF; --muted:#EFEFF1; --accent:#E9E9EC;
  --border:#E3E3E7; --input:#8A8A92; --ring:#111113;
  --foreground:#111113; --muted-foreground:#55555C; --faint:#67676F;
  --primary:#111113; --primary-foreground:#FFFFFF; --destructive:#B8321A;
  --healthy:#17683F; --healthy-bg:#DDF3E6; --degraded:#8A5A00; --degraded-bg:#FBF0D6;
  --failed:#B8321A; --failed-bg:#FCE5DF; --blocked:#3D3D44; --on-failed:#FFFFFF; --on-degraded:#FFFFFF;
  --engine-chromium:#174C96; --engine-headless:#C8559C; --engine-lightpanda:#17A0BA;
}
```

Engines and statuses live in one typed map (`ENGINES`, `STATUSES`: colour, marker, dash, icon, label) next to the zod enums. Recharts: `Line strokeDasharray`, custom `dot`/`activeDot` by marker, a custom `<Customized>` source strip under each chart.

## 7. Open questions
Moved to `rationale.md` ("Open questions for Eyal"): status thresholds, default source filter, whether `blocked` counts as a failure in the success rate.
