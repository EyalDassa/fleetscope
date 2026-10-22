# Fleetscope design system (Taste, v1)

Style direction: a quiet, dense monitoring tool. Dark is the default theme (true neutral greys, no navy or slate), light is a full second theme. Colour is reserved for data (the three engines) and for status (four states). Chrome stays grey. Dials: VISUAL_DENSITY 8, DESIGN_VARIANCE 4, MOTION_INTENSITY 2.

All contrast ratios below were computed by hand from the WCAG 2.x relative-luminance formula. Run them through a checker in M0 before the tokens are frozen. Non-text ratios (engine colors, control borders) target 3:1, text targets 4.5:1.

## 1. Principles

1. **Answer first, evidence next.** The fleet status ("Degraded") is the largest thing on Overview, with the one finding beside it and the one job (review the failures) one click away. Charts and tables explain it, they do not compete with it.
2. **Colour is data or status, never chrome.** The sidebar, top bar, buttons and cards are grey. The only hues on screen are the three engine colors and the four status colors.
3. **Never color alone.** Status = icon + label + tint. Engine = color + marker shape (circle, square, diamond) + name. Source = text + border style (solid = real, dashed = sim).
4. **Every number is a door.** KPI cells, table rows, chart points and failure rows are links to the sessions behind them. Hover shows the destination.
5. **Honest empties.** A zero prints as `0`, a missing value as a grey dash, a metric an engine cannot report as "Not available" in a dashed frame with the reason. Never a fake value.

## 2. Color tokens

Token names map onto the shadcn/ui CSS variables (section 6), so `bg-card`, `text-muted-foreground`, `border-border` work unchanged.

### 2.1 Neutrals

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ground` (shadcn `background`) | `#0B0B0C` | `#F5F5F6` | page, sidebar, top bar |
| `--surface` (`card`) | `#121214` | `#FFFFFF` | cards, tables, popovers' base |
| `--raised` (`muted`, `popover`) | `#1A1A1D` | `#EFEFF1` | hover row, segmented track, kbd |
| `--active` (`accent`) | `#1E1E22` | `#E9E9EC` | active nav item, selected row |
| `--border` | `#26262A` | `#E3E3E7` | card and row edges (decorative, about 1.2:1 by design) |
| `--control` (`input`) | `#63636A` | `#8A8A92` | borders of buttons, inputs, segmented controls (3:1 non-text rule) |
| `--text` (`foreground`) | `#F2F2F3` | `#111113` | primary text, values |
| `--muted` (`muted-foreground`) | `#B0B0B6` | `#55555C` | labels, secondary text |
| `--faint` | `#8E8E95` | `#67676F` | meta, axis text, placeholders |
| `--grid` | `#26262A` | `#E6E6EA` | chart gridlines (decorative) |

**Contrast, text pairs (WCAG AA needs 4.5:1)**

| Pair | Dark: ground / surface / raised / active | Light: ground / surface / raised / active |
|---|---|---|
| `--text` | 17.6 / 16.7 / 15.5 / 14.9 | 17.3 / 18.9 / 16.4 / 15.6 |
| `--muted` | 9.1 / 8.7 / 8.0 / 7.7 | 6.8 / 7.4 / 6.4 / 6.1 |
| `--faint` | 6.0 / 5.7 / 5.3 / 5.1 | 5.1 / 5.6 / 4.9 / 4.6 |

Primary button: fill `--text`, label `--ground`: 17.6 (dark), 18.9 (light, `#FFFFFF` label on `#111113`).
Control border vs surface: dark `#63636A` 3.1, light `#8A8A92` 3.4 (WCAG 1.4.11).
Focus ring: 2px `--text`, 2px offset: 16.7 dark, 18.9 light.

### 2.2 Status colors (each = icon + label + tint)

| State | Meaning | Icon (lucide) | Label |
|---|---|---|---|
| healthy | succeeded cleanly | `circle-check` | Healthy |
| degraded | succeeded, but with a retry, a slow action (over its p95) or a logged issue | `triangle-alert` | Degraded |
| failed | `failed`, `timeout`, `crashed` (the reason is a second field) | `circle-x` | Failed |
| blocked | `blocked`: bot wall or captcha. Not our fault, still not a success | `ban` | Blocked |

| Token | Dark text | Dark tint bg | Light text | Light tint bg |
|---|---|---|---|---|
| `--healthy` | `#3FC07A` | `#12281C` | `#17683F` | `#DDF3E6` |
| `--degraded` | `#E8A93A` | `#2B2110` | `#8A5A00` | `#FBF0D6` |
| `--failed` | `#F4694B` | `#2D1912` | `#B8321A` | `#FCE5DF` |
| `--blocked` | `#A6A6AE` | none (outline + hatch) | `#3D3D44` | none (outline + hatch) |

Chart fills for failed/healthy/degraded reuse the "text" column. `--on-failed` (label on a solid failed bar): dark `#0B0B0C` (6.5), light `#FFFFFF` (6.0).

**Contrast (text on its own surface / on its tint)**

| Token | Dark on surface / on tint | Light on surface / on tint |
|---|---|---|
| healthy | 8.1 / 6.7 | 6.8 / 5.8 |
| degraded | 9.1 / 7.7 | 5.9 / 5.2 |
| failed | 6.2 / 5.5 | 6.0 / 5.0 |
| blocked | 7.7 / n.a. | 10.8 / n.a. |

Blocked is deliberately the only status without a hue: it is drawn as a **neutral outline chip with the `ban` icon and a diagonal hatch** wherever it is a fill (stacked bars, legend swatches). Hatch = "not a clean outcome and not ours". This keeps four states readable with no more than three status hues (green, amber, vermillion), and leaves pink/blue/cyan to the engines.

Fleet and engine status (proposal, to confirm with backend): success rate >= 95% Healthy, 90-95% Degraded, < 90% Failed. "Success" counts healthy + degraded sessions.

### 2.3 Engine colors

Chosen so the three differ in hue **and** lightness, away from the status hues (no green, no amber, no red-orange), and always paired with a marker shape.

| Engine | Marker | Dark | Light | Contrast on card (non-text needs 3:1) |
|---|---|---|---|---|
| Chromium | circle | `#4C9BE6` | `#1A5FB4` | 6.4 dark, 6.3 light |
| chrome-headless-shell | square | `#D98AB8` | `#B8408A` | 7.4 dark, 5.1 light |
| Lightpanda | diamond | `#6FD6E6` | `#139AB2` | 11.1 dark, 3.3 light |

Lightness (dark): Chromium mid-dark blue, headless-shell mid pink, Lightpanda light cyan, so the pairs that fall together under protan/deutan (blue vs pink) still separate by shape, and cyan separates from both by lightness. Colours were picked from the Okabe-Ito family and reasoned, not run through a simulator: verify with a CVD simulator in M0.
Engine color is used as text only in the legend dot and marker, never as the label color (labels are `--text`). Series order is fixed everywhere: Chromium, chrome-headless-shell, Lightpanda (bottom to top in stacks).

### 2.4 Real vs simulated

| Source | Treatment |
|---|---|
| `real` | chip "real": 1px solid `--control` border, `--muted` text (8.7 dark / 7.4 light on surface) |
| `sim` | chip "sim": 1px **dashed** `--control` border, `--text` text (16.7 / 18.9) |

Rules: every session row, failure row and header shows its chip. Every aggregate view with `source=all` shows a mix line in the title row ("1,214 real, 628 sim", with the sim share). When the filter is `sim`, the whole canvas gets a dashed 1px outline and a persistent notice "Simulated data only". Charts never blend visually: when mixed, the tooltip lists the split.

## 3. Typography

One text family plus one mono for identifiers. Next.js: `next/font/google` `IBM_Plex_Sans` (400, 500, 600) and `IBM_Plex_Mono` (400, 500). Fallback `Inter`. Sentence case everywhere; the only uppercase is the `kbd` hint. Numbers use `font-variant-numeric: tabular-nums` (check in M0 that it changes digit widths; if not, switch to Inter).

| Role | Size / line / weight | Use |
|---|---|---|
| status lead | 28 / 32 / 600 | the fleet status word on Overview only |
| KPI value | 22 / 26 / 500 | KPI strip, session header strip |
| page title | 20 / 26 / 600 | h1 (session id is mono 20/600) |
| card title | 14 / 20 / 600 | chart and table card headers |
| body, cells, nav | 13 / 20 / 400 | table cells, list rows, nav |
| label, meta | 12 / 16 / 400 | KPI labels, sublines, deltas, legends |
| axis, chip, kbd | 11 / 14 / 400-500 | axis ticks, source chip, bar labels. Floor is 11px |
| mono ids | 12 / 16 / 400 | session ids, error codes, selectors, timestamps in the waterfall |

Weights in use: 400, 500, 600. Units are a 12px `--muted` suffix next to the value ("1.84 s"). Fixed decimals per metric: percentages 1, latency 2 (s) or 0 (ms), cost 2 (fleet) or 4 (session), counts 0 with thousands separators. Every change carries a sign.

## 4. Spacing, radius, elevation, motion

- 4px base. **One gutter: 12px** between cards, 12px inside rails. Card padding 16. Canvas padding 24 (20 top). Section gaps 16.
- Heights: top bar 48, nav row 32 (34 pitch), control 28, table row 40, list row 52-56, waterfall row 28.
- Radius: card 8, control 6, chip/badge 4 (full pill only for the live dot). Nested radii step down.
- No shadows on resting surfaces. A shadow (0 8px 24px rgba(0,0,0,.35) dark, .12 light) only on popover, command palette and tooltip.
- Motion: colour/background change on hover at 100ms. No entrance animations, no chart animation. Live updates replace values in place (the Recharts `isAnimationActive={false}`).
- Widths: sidebar 232 (56 icon rail under 1100px), right rail 400 (Overview) / 360 (Session). Content max about 1160 at 1440.

## 5. Component rules

### KPI strip (not tiles)
One `Card` split into equal columns by 1px dividers; no icons, no sparklines. Per cell: label (12 muted), value (22/500 text) with a 12px muted unit suffix, subline (12): a delta **with its window** ("+0.31 s vs prior 1 h") or a capacity statement ("of 48 cores, 45%"). Delta colour = good/bad, never up/down: bad direction `--failed`, good direction `--healthy`, neutral metrics (volume, cost) `--muted`. Zero or undefined change is a grey dash. Bad deltas also carry a visible arrow and a visually hidden "worse". The whole cell is a link (hover `--raised`). Count follows the grid: 7 columns at 1440, 4 + 3 under 1100px. Capacity KPIs add a 2px track at the true ratio.

### Chart card
`Card` with header: title (14/600) left, current value or finding (12 muted) right. Plot 112-150px tall. Gridlines: 4-5 horizontal 1px `--grid`, no y-axis line, 1px baseline in `--faint`. Y ticks round and above the max, 11px `--faint`. X labels flat, one step (10 min), end unlabeled. Lines 2px straight segments, no smoothing, no fill; stacked columns have 1px `--surface` seams, square corners. One end marker per line (the engine's shape). Reference lines 1px dashed with a label (alert threshold, capacity). One event annotation per chart at most (1px dashed vertical, 12px label in a reserved row above the plot). Engine legend lives once above the chart group, not in each card. Tooltip: bare box, time then one row per series (marker, name, value), footer "Click to open sessions". Recharts: `LineChart`, `BarChart stackId`, `ReferenceLine`, custom `Tooltip content`, custom `activeDot` by engine shape.

### Table row
Header 12px `--muted`, no fill, one 1px rule under it. Rows 40px (52-56 two-line lists), 1px `--border` rule between rows, no zebra. Identity column widest, left aligned; every numeric column right aligned, tabular, with the unit as a muted suffix. One status mark per row (badge). Row hover `--raised`, selected `--active`; the row is a link and its name cell gets the link affordance. Totals row on top of a 1px `--control`-weight rule, values computed from the rows above. IDs in mono at 12px, truncated to 8 characters plus the "ses_" prefix, copy icon on hover. Two-line cells: line 2 at 12px muted, 20px under line 1.

### Status badge
Height 20, radius 4, padding 0 6px, 12px/500, 14px outline icon + label, `gap 4`. Tint background and same-hue text for healthy, degraded, failed. Blocked: 1px outline, no fill, `ban` icon, text `--blocked`. A compact variant (icon + label, no tint) is used inside dense rows; an icon-only variant is forbidden (the label is always present, only visually hidden under 640px).

### Timeline bar (waterfall)
Row 28px, bar 14px tall, radius 2 (bars are data, near-square). Left label column 244px fixed (seq, type in mono, target truncated); plot to the right shares one x-axis with the resource charts below. Bar fill = engine color for a successful action; failed = `--failed` fill with `--on-failed` label inside ("timeout, 8,000 ms"); degraded/slow = engine fill plus a trailing triangle-alert and "slow, p95 1,900 ms" in `--degraded`. Minimum bar width 3px. Duration label after the bar (12px tabular), inside the bar only when it would run past the plot edge. Browser phases (startup, connect) are neutral grey bars. Vertical gridlines every 2 s; the failing span is shaded across every row and chart (6% of `--failed`); an issue marker is a 1px `--failed` vertical line with its kind label in the axis band. Resource rows (CPU, memory) are 2px lines with 4px sample dots (they are 2 s samples, so dots are honest). A metric the engine cannot report (JS heap on Lightpanda) is a dashed empty frame saying "Not available" and why.

### Engine marker, source chip, filters
- Engine marker: 10px SVG (circle, square, diamond) in the engine color, always followed by the name.
- Source chip: section 2.4.
- Top bar controls (28px): time range segmented (15m, 1h, 24h, 7d, Custom), engine multi-select popover (three checkboxes with markers), source segmented (All, Real, Sim), search field with `⌘K` hint, theme toggle. shadcn: `ToggleGroup`, `Popover` + `Checkbox`, `Command` dialog. All state in URL search params.
- Command palette (`⌘K`): groups Sessions (by id), Pages, Saved views. Result rows 36px.

## 6. shadcn/ui token mapping (globals.css)

```css
:root[data-theme="dark"], :root {
  --background:#0B0B0C; --card:#121214; --popover:#1A1A1D; --muted:#1A1A1D; --accent:#1E1E22;
  --border:#26262A; --input:#63636A; --ring:#F2F2F3;
  --foreground:#F2F2F3; --muted-foreground:#B0B0B6; --faint:#8E8E95;
  --primary:#F2F2F3; --primary-foreground:#0B0B0C; --destructive:#F4694B;
  --healthy:#3FC07A; --healthy-bg:#12281C; --degraded:#E8A93A; --degraded-bg:#2B2110;
  --failed:#F4694B; --failed-bg:#2D1912; --blocked:#A6A6AE; --on-failed:#0B0B0C;
  --engine-chromium:#4C9BE6; --engine-headless:#D98AB8; --engine-lightpanda:#6FD6E6;
  --radius:8px;
}
:root[data-theme="light"] {
  --background:#F5F5F6; --card:#FFFFFF; --popover:#FFFFFF; --muted:#EFEFF1; --accent:#E9E9EC;
  --border:#E3E3E7; --input:#8A8A92; --ring:#111113;
  --foreground:#111113; --muted-foreground:#55555C; --faint:#67676F;
  --primary:#111113; --primary-foreground:#FFFFFF; --destructive:#B8321A;
  --healthy:#17683F; --healthy-bg:#DDF3E6; --degraded:#8A5A00; --degraded-bg:#FBF0D6;
  --failed:#B8321A; --failed-bg:#FCE5DF; --blocked:#3D3D44; --on-failed:#FFFFFF;
  --engine-chromium:#1A5FB4; --engine-headless:#B8408A; --engine-lightpanda:#139AB2;
}
```

Engine and status keys live in one typed map (`ENGINES`, `STATUSES`) next to the zod enums, so a chart, a badge and a legend can never disagree.

## 7. Open questions for the lead

1. Status thresholds (95 / 90) and the definition of "degraded" need a backend decision; the UI is built so they are config.
2. Default source filter: this proposal defaults to **All** with a permanent mix line, instead of defaulting to Real.
3. Session pages hide the global time/engine/source filters (a session is its own scope); search and theme stay.
