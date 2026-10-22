# Fleetscope design system, promax v1

Dark is the default theme. Light is a full second set, not an inversion. Every token below is a CSS variable on `:root` (dark) and `[data-theme="light"]`, and both mockups use exactly these values.

**Contrast method.** Ratios are WCAG 2.x relative-luminance ratios, computed by hand and rounded to one decimal. They are meant to be re-checked by a small script (a unit test over `tokens.ts` is a good Saturday task). AA targets: 4.5:1 for text, 3:1 for non-text UI (lines, bars, focus ring, chart marks).

## 1. Principles

1. **Chrome is neutral, colour is data.** Backgrounds, borders, buttons and the primary action are greys. Hue is reserved for three things: status, engine, and nothing else. So anything coloured on screen means something.
2. **Verdict first, numbers second.** Overview opens with one sentence ("Fleet degraded, because...") and its evidence, before any chart. A session opens with its root cause before its timeline.
3. **Every mark is a door.** KPI cards, chart points, table rows, engine names and issue codes all link to the sessions behind them. Links carry a visible `↗` affordance, never hover-only.
4. **Never colour alone.** Status = colour + icon + word. Engine = colour + shape + line style. Real/sim = outline style + hatch + word.
5. **Honest about gaps.** Unavailable data renders as a labelled hatched placeholder ("Not available for Lightpanda, stored as null"), never as zero or a flat line.

## 2. Colour tokens

### 2.1 Surfaces and text

| Token | shadcn var | Dark | Light |
|---|---|---|---|
| `bg` | `--background` | `#0B0F14` | `#F4F6F9` |
| `surface` | `--card` | `#111821` | `#FFFFFF` |
| `surface-2` (hover, sunken) | `--muted` / `--accent` | `#17212C` | `#F0F3F7` |
| `line` (decorative dividers, card borders) | `--border` | `#243142` | `#DDE3EA` |
| `line-strong` (controls, input outlines) | `--input` | `#5B6B80` | `#7A889B` |
| `fg` | `--foreground` | `#E6EDF5` | `#0F1722` |
| `fg-muted` | `--muted-foreground` | `#9AA9BB` | `#475569` |
| `fg-subtle` (axis ticks, captions) | n/a | `#7D8DA1` | `#5F6E82` |
| `ink` (primary button, selected segment) | `--primary` | `#E6EDF5` | `#0F1722` |
| `on-ink` | `--primary-foreground` | `#0B0F14` | `#FFFFFF` |
| focus ring = `fg`, 2px, offset 2px | `--ring` | `#E6EDF5` | `#0F1722` |

Contrast, text pairs (all pass AA):

| Pair | Dark | Light |
|---|---|---|
| `fg` on `bg` | 16.3 | 16.6 |
| `fg` on `surface` | 15.1 | 18.0 |
| `fg` on `surface-2` | 13.8 | 16.2 |
| `fg-muted` on `bg` | 8.0 | 7.0 |
| `fg-muted` on `surface` | 7.5 | 7.6 |
| `fg-muted` on `surface-2` | 6.8 | 6.8 |
| `fg-subtle` on `bg` | 5.7 | 4.8 |
| `fg-subtle` on `surface` | 5.3 | 5.2 |
| `fg-subtle` on `surface-2` (lowest case) | 4.8 | 4.7 |
| `on-ink` on `ink` | 16.3 | 18.0 |

Non-text: `line-strong` vs `bg` 3.5 / 3.3 and vs `surface` 3.3 / 3.6 (dark / light), so control outlines pass 3:1. `line` is decorative only (card edges are not the sole cue for a card). Focus ring vs `surface` 15.1 / 18.0.

Rule: `fg-subtle` is never used on a status-tinted background; use `fg-muted` there (the selected failed waterfall row does this).

### 2.2 Status

Four states plus a neutral "running". Each has a text/icon colour (`-fg`) and a tinted fill (`-bg`). A badge always shows **icon + word**.

| State | Meaning (maps from event schema) | Icon | Label | Dark fg / bg | Light fg / bg |
|---|---|---|---|---|---|
| Healthy | `session.ended` status `success`, no issues | check-circle | Healthy / Success | `#4BD98E` / `#10281C` | `#0B6B39` / `#DDF5E7` |
| Degraded | succeeded with issues, or running above threshold; fleet success 85-95% | alert-triangle | Degraded | `#F2C14E` / `#2E2410` | `#8A5A00` / `#FDF1D3` |
| Failed | `failed`, `crashed`, `timeout` | x-circle | Failed / Timeout / Crashed | `#FF7B7B` / `#33191B` | `#B42318` / `#FDE4E1` |
| Blocked | `blocked`, `captcha` | ban | Blocked / CAPTCHA | `#B79CFF` / `#231C3A` | `#5B3FC4` / `#ECE7FB` |
| Running | no `session.ended` yet | pulsing dot | Running | `fg-muted` / `surface-2` | same tokens |

Why blocked is violet and not red: blocked is the site saying no, not our fleet breaking. An on-call engineer should be able to separate "we are broken" (red) from "the target pushes back" (violet) without reading. Failed and Blocked also differ in icon (x-circle vs ban).

Contrast of `-fg` on its own `-bg` (text 12px/500):

| State | Dark | Light |
|---|---|---|
| Healthy | 8.7 | 5.8 |
| Degraded | 9.1 | 5.3 |
| Failed | 6.5 | 5.4 |
| Blocked | 7.1 | 5.9 |

`-fg` on `surface` (for icons/text outside a badge): Healthy 9.9 / 6.6, Degraded 10.6 / 5.9, Failed 7.1 / 6.6, Blocked 7.8 / 7.1 (dark / light).

Fleet thresholds (configurable): success rate >= 95% healthy, 85-95% degraded, < 85% failed. The Overview verdict banner takes the worst of: success rate, error spike vs alert line, capacity > 90%.

### 2.3 Engines

Chosen from the Okabe-Ito colour-blind-safe set. Colour is never the only channel: each engine also has a **marker shape** and a **line style**.

| Engine | Marker | Line style | Dark | Light | Contrast vs `surface` (dark / light) |
|---|---|---|---|---|---|
| Chromium | circle | solid | `#56B4E9` | `#0072B2` | 7.7 / 5.2 |
| chrome-headless-shell | rounded square | dashed `7 4` | `#E69F00` | `#B86E00` | 7.9 / 4.0 |
| Lightpanda | diamond | dotted `1.5 3.5` | `#CC79A7` | `#B0457F` | 5.8 / 5.3 |

All three clear 3:1 for graphical objects in both themes. Short name in dense UI: `Chromium`, `headless-shell`, `Lightpanda`; full `chrome-headless-shell` in tables and filters.

Known overlap, handled on purpose: headless-shell orange sits near Degraded yellow, and Lightpanda pink sits near Failed red. They are never used on the same element type: engines appear as small shapes and chart series; status appears only as icon-and-word badges, icons, and banner fills. Where both appear in a row, they are separated by shape and by the word.

### 2.4 Real vs simulated

Neutral on purpose (hue belongs to engine and status).

- **Real** chip: solid 1px outline, filled dot, uppercase "REAL".
- **Sim** chip: **dashed** outline, hollow dot, diagonal hatch fill, uppercase "SIM".
- Charts show source as a hatched/solid strip under the chart (solid = real, hatched = sim). Never merged into one flat number without the split being visible: the Sessions KPI card carries a real/sim split bar and counts.
- Top bar: source filter `All | Real | Sim` plus a `62% sim` chip whenever Sim is included.
- Chart and table headers say "real + simulated" when the filter is All.

### 2.5 Chart-only tokens

| Token | Dark | Light | Contrast vs `surface` |
|---|---|---|---|
| `bar` (neutral OK action bar) | `#5B7491` | `#6B829E` | 3.7 / 4.0 |
| Alert threshold line | `warn-fg`, dotted | same | 10.6 / 5.9 |
| Spike band | `err-fg` at 10% | same | decorative |
| Grid lines | `line` | `line` | decorative |
| Axis labels | `fg-subtle` 12px | | 5.3 / 5.2 |

## 3. Typography

Fonts: **Inter** (UI) and **JetBrains Mono** (IDs, selectors, error codes). `next/font/google`, both variable. All numbers use `font-variant-numeric: tabular-nums` so live-updating values do not jitter.

| Role | Size / line | Weight | Tailwind |
|---|---|---|---|
| Label, caption, axis, badge | 12 / 16 | 400-500 | `text-label` (custom) |
| Body (tables, lists) | 13 / 20 | 400 | `text-body` (custom) |
| Card title | 14 / 20 | 600 | `text-sm font-semibold` |
| Page title, big stat in session header | 20 / 28 | 600 | `text-title` (custom) |
| KPI value | 26 / 30 | 600 | `text-kpi` (custom) |

Minimum size is 12px. Body line-height is 1.5 or more. Units next to a value (`s`, `%`, `GB`) are 12px `fg-muted`.

## 4. Spacing, sizing, radius

- Base unit 4px. Scale: 4, 8, 12, 16, 24. Page padding 16 (xl: 24). Card gap 12. Card padding 12 (KPI) or 16 (everything else). Header-to-body gap 4-8.
- Control height 32 (compact 28). Table row 40. Nav item 36. Waterfall row 28. Badge 20. Large badge (session header) 28. Icon 16 (12 inside badges).
- Dense mode is the default, because this is a monitoring tool. Hit areas on desktop are 28-32px high; below 1024 or on touch, controls grow to 44px.
- Radius: 4 badges/kbd/bars, 6 controls, 8 cards, full only for status dots.
- Shadows: none on cards (borders do the job); only popovers and tooltips (`0 8px 24px` at 45% black in dark, 14% in light).

## 5. Layout

- Sidebar: 216px with labels at >= 1280px; collapses to a 56px icon rail below (labels become `title`/`aria-label`). Top bar: 48px, sticky.
- Top bar order: time range (15m / 1h / 24h / 7d / Custom), engine multi-select, source segmented control, `62% sim` chip, then right-aligned live clock, ⌘K search (icon only below 1280px), theme toggle.
- Overview grid: verdict banner, 7 KPI cards (`grid-cols-7` at xl, 4 columns at 1024 with cost spanning two), 3 chart cards (error rate first, because it carries the story), engine table + recent failures.
- Session grid: header, root-cause banner, then `[timeline | 340px side column]` at xl, stacked below.
- Verified widths: 1440 (primary) and 1024 (rail, no horizontal scroll; tables get `overflow-x-auto` as a safety net).

## 6. Component rules

**Verdict banner.** `warn-bg`/`err-bg`/`ok-bg` fill, 4px inset accent bar in the `-fg` colour, 28px icon, status word at title size, one sentence of evidence in `fg-muted`, three key facts (capacity, engines reporting, failed count), one primary button that links to the failures. Healthy state collapses to a single line.

**KPI card.** Whole card is one `<a>` to a pre-filtered Sessions view. Anatomy top to bottom: label (12 `fg-muted`) with a `↗` icon top-right, value (26 semibold tabular) + unit, delta line (arrow icon + signed number + "vs prev"; arrow shows direction, colour shows good/bad: `ok-fg`/`err-fg`/`fg-muted` for neutral), 24px sparkline in `fg-muted` (status colour only if the metric is breaching). A breaching card gets a 3px left border in the status colour plus the delta text. No gauges, no donut charts. The Sessions card swaps the sparkline for the real/sim split bar. shadcn: `Card` + `a`.

**Chart card.** `Card` with header (title 14 semibold, subtitle 12 `fg-muted` stating unit and bucket), a "view as table" icon button and a "Sessions ↗" link. Interactive legend directly under the header: shape marker + name + current value, toggles series (`aria-pressed`). Plot area 168-212px tall. Y axis: 3-4 ticks, no axis line; X axis: ticks every 10 min, 12px `fg-subtle`. Grid: horizontal only. Spike or threshold annotations are `ReferenceArea` / `ReferenceLine`. Hover tooltip lists series in the same order as the stack and ends with a link row ("31 failed sessions, Open"); clicking a point navigates to Sessions filtered to that bucket. Every chart has `role="img"` plus a text summary, and a table view for screen readers. Stacked areas: 30% fill, 1.75px stroke; lines: 2px, dash per engine. shadcn `Card` + Recharts `AreaChart`/`LineChart`, custom `dot` renderer for engine shapes.

**Table row.** 40px (32 compact), 13px text, numbers right-aligned and tabular, header 12px `fg-subtle`, `border-line` between rows, hover `surface-2`, whole row is a link, row identity cell is `<th scope="row">`. Status cell = badge. Engine cell = shape + name. Source cell = chip. Memory sparkline (Sessions table) is 64x16, `fg-muted`. shadcn `Table`.

**Status badge.** 20px high, 4px radius, 12px/500, icon 12px + word, `-fg` on `-bg`. Variants: `healthy | degraded | failed | blocked | running` (cva). The icon is never omitted; icon-only use in dense cells must carry `aria-label`.

**Timeline bar (action waterfall).** One row per action, 28px. Left gutter (264px; 224px below xl): sequence number, type in mono, target in mono (truncated, full text in `title`). Plot area: bar 14px high, 3px radius, minimum 3px wide, positioned by `left = start/total`, `width = duration/total`. Variants: OK = `bar` neutral; Slow (above the p95 for that target) = `warn-fg` + clock icon + "slow" in the duration label; Failed = `err-fg` with diagonal stripe + X icon + "failed". Duration label sits outside the bar (right, or left when the bar ends past 82%). Selected row = `err-bg` fill. A dashed `err-fg` vertical line marks the failure time through the whole stack. Built as plain divs with percentage positions, not Recharts.

**Shared time axis (session).** The waterfall, CPU chart and memory chart sit in one grid with an identical left gutter and identical horizontal padding (12px), so `x = 12 + (W-24) * t / duration` everywhere. A single hover cursor crosses all rows and updates the CPU and memory read-outs in the gutter. In Recharts: fixed `margin` and `YAxis width={0}` with axis labels moved into the gutter, `syncId` for the two charts, and the same duration domain `[0, durationMs]`.

**Source chip / engine marker / empty-data placeholder.** See 2.3, 2.4 and principle 5.

## 7. Accessibility checklist

- Text >= 4.5:1, graphics and control outlines >= 3:1, in both themes (tables above).
- Status never by colour alone; engines never by colour alone; sim never by colour at all.
- Visible 2px focus ring on every interactive element; segmented controls and legend toggles use `aria-pressed`.
- `prefers-reduced-motion` disables the live-dot pulse and chart transitions.
- Charts: `role="img"` + summary, "view as table" alternative, tooltip content also reachable by keyboard focus on legend and table.
- Light mode is first-class: status `-fg` colours are darkened (not just the dark values reused) so badge text keeps >= 5:1.
