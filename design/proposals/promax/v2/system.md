# Fleetscope design system, promax v2

Dark is the default theme. Light is a full second set, not an inversion. Every token is a CSS variable on `:root` (dark) and `[data-theme="light"]`. Both mockups are plain HTML with inline CSS (no Tailwind CDN), so they render offline; in the real app the same variables are exposed to Tailwind through `theme.extend.colors` (`bg: "var(--bg)"`, and so on) and to shadcn through the mapping in section 2.1.

**What changed from v1:** status colours `ok`, `warn`, `blk` retuned by *lightness* so they separate from the engine colours under colour-vision deficiency; light-theme `warn` and `blk` deepened; blocked kept as a hue (decision explained in 2.2); 12px floor kept; status word at 28px; KPI strip; shared chart legend; windowed deltas. Engine colours are unchanged because they were the strongest part of v1 (engine-vs-engine).

**Contrast method.** WCAG 2.x relative-luminance ratios, computed by hand and rounded to one decimal. In v1 the render helper confirmed every claimed ratio to within 0.2. AA targets: 4.5:1 for text, 3:1 for non-text (outlines, bars, focus ring, chart marks).

## 1. Principles

1. **Chrome is neutral, colour is data.** Backgrounds, borders, buttons and the primary action are greys. Hue is reserved for status and engine.
2. **Verdict first, numbers second.** Overview opens with one sentence ("Degraded, because...") and a four-state distribution bar. A session opens with its root cause before its timeline.
3. **Every mark is a door.** KPI cells, chart points, table rows, engine names and issue codes link to the sessions behind them, with a visible `↗` at rest, never hover-only.
4. **Never colour alone.** Status = colour + icon + word. Engine = colour + marker shape + line style. Real/sim = outline style + dot + word.
5. **Honest about gaps.** Unavailable data is a labelled hatched placeholder ("Not available for Lightpanda, stored as null"), never a zero.

## 2. Colour tokens

### 2.1 Surfaces and text (unchanged from v1)

| Token | shadcn var | Dark | Light |
|---|---|---|---|
| `bg` | `--background` | `#0B0F14` | `#F4F6F9` |
| `surface` | `--card` | `#111821` | `#FFFFFF` |
| `surface-2` (hover, sunken) | `--muted` / `--accent` | `#17212C` | `#F0F3F7` |
| `line` (decorative) | `--border` | `#243142` | `#DDE3EA` |
| `line-strong` (control outlines) | `--input` | `#5B6B80` | `#7A889B` |
| `fg` | `--foreground` | `#E6EDF5` | `#0F1722` |
| `fg-muted` | `--muted-foreground` | `#9AA9BB` | `#475569` |
| `fg-subtle` (axis, captions) | n/a | `#7D8DA1` | `#5F6E82` |
| `ink` (primary button, selected segment) | `--primary` | `#E6EDF5` | `#0F1722` |
| `on-ink` | `--primary-foreground` | `#0B0F14` | `#FFFFFF` |
| focus ring = `fg`, 2px, offset 2px | `--ring` | `#E6EDF5` | `#0F1722` |

Text contrast (dark / light), confirmed by the v1 render check: `fg` on `bg` 16.3 / 16.6, on `surface` 15.1 / 18.0, on `surface-2` 13.8 / 16.2. `fg-muted` on `bg` 8.0 / 7.0, `surface` 7.5 / 7.6, `surface-2` 6.8 / 6.8. `fg-subtle` on `bg` 5.7 / 4.8, `surface` 5.3 / 5.2, `surface-2` 4.8 / 4.7. `on-ink` on `ink` 16.3 / 18.0. `line-strong` vs `bg` 3.5 / 3.3, vs `surface` 3.3 / 3.6 (control outlines pass 3:1). Focus ring vs `surface` 15.1 / 18.0.

Rule: `fg-subtle` is never used on a status-tinted fill or on a chart area fill; use `fg-muted` there (the selected waterfall row and the CPU/memory tick labels do).

### 2.2 Status

Four states plus a neutral "running" (pulsing dot, no badge fill). A badge always shows **icon + word**.

| State | Maps from | Icon | Dark fg / bg | Light fg / bg |
|---|---|---|---|---|
| Healthy | `success`, no issues | check-circle | `#6EE7A8` / `#10281C` | `#0B6B39` / `#DDF5E7` |
| Degraded | success with a retry, slow action or logged issue | alert-triangle | `#FFD95A` / `#2E2410` | `#6B4400` / `#FDF1D3` |
| Failed | `failed`, `crashed`, `timeout` | x-circle | `#FF7B7B` / `#33191B` | `#B42318` / `#FDE4E1` |
| Blocked | `blocked`, `captcha` | ban | `#D9CCFF` / `#2B2159` | `#3D2A9E` / `#ECE7FB` |

**Blocked keeps a hue (decision).** I considered the other proposal's hue-less hatched outline and rejected it for three reasons. (1) The brief requires blocked to read as its own state at a glance; a grey badge is the same visual family as "running", "real/sim" chips and disabled UI, so it is the least salient state although it is the most *actionable* kind of non-success for an on-call engineer. (2) Hatch is already my sim marker; reusing it for blocked would make one pattern mean two things. (3) A hue costs nothing at AA once its *lightness* is moved away from Chromium's blue, which is where the v1 problem actually was (blocked violet vs Chromium blue, deuteranopia ΔE 3.1). What I took from them: blocked is never red ("we are broken" vs "the site said no") and, as in theirs, its non-colour cues are the `ban` icon and the word.

Contrast of `-fg` on its own `-bg` (text 12px/500), dark / light: Healthy 10.2 / 5.8, Degraded 11.1 / 7.6, Failed 6.5 / 5.4, Blocked 9.6 / 8.6. `-fg` on `surface`: Healthy 11.6 / 6.6, Degraded 13.0 / 8.6, Failed 7.1 / 6.6, Blocked 11.9 / 10.4.

Fleet thresholds (configurable): success >= 95% Healthy, 85-95% Degraded, < 85% Failed. The Overview verdict takes the worst of success rate, error spike vs the alert line, and capacity above 90%. Distribution bar on Overview counts sessions by the four states (success splits into healthy and degraded).

### 2.3 Engines (unchanged)

Okabe-Ito colour-blind-safe hues, plus a marker shape and a line style, so colour is never the only channel.

| Engine | Marker | Line | Dark | Light | vs `surface` (dark / light) |
|---|---|---|---|---|---|
| Chromium | circle | solid | `#56B4E9` | `#0072B2` | 7.7 / 5.2 |
| chrome-headless-shell | rounded square | dashed `7 4` | `#E69F00` | `#B86E00` | 7.9 / 4.0 |
| Lightpanda | diamond | dotted `1.5 3.5` | `#CC79A7` | `#B0457F` | 5.8 / 5.3 |

Engine colour is never used as a text colour (the v1 AA failure in the other proposal was exactly that). Short names in dense UI: `Chromium`, `headless-shell`, `Lightpanda`; the full `chrome-headless-shell` where there is room, never wrapped (`white-space: nowrap`).

### 2.4 Colour-vision check: engine vs engine and engine vs status

CIEDE2000 under Machado 2009 simulation. "Measured" values are from the v1 render check (tokens unchanged). "Expected" values are my hand estimates from the lightness (L*) gaps I introduced and **must be confirmed by the helper**; I mark the ones I am least sure of.

Engine vs engine (tokens unchanged, measured). Dark: Chromium-headless 53.6 / 50.6 / 54.3 / 53.5 (normal / protan / deutan / tritan); Chromium-Lightpanda 45.5 / 14.1 / 15.5 / 65.3; headless-Lightpanda 49.0 / 43.4 / 36.7 / **11.1**. Light: Chromium-headless 48.7 / 50.2 / 55.5 / 49.0; Chromium-Lightpanda 41.7 / 11.0 / 18.6 / 59.1; headless-Lightpanda 44.4 / 42.7 / 32.5 / **9.6**. All protan and deutan values are >= 11.0; the only value under 10 is tritanopia, light theme, headless vs Lightpanda (9.6).

Engine vs status, pairs that were flagged in v1 and what v2 expects:

| Pair | v1 measured (normal / protan / deutan / tritan) | Change | v2 expected |
|---|---|---|---|
| dark Chromium vs Healthy | 40.6 / 41.7 / 39.1 / **8.6** | `ok-fg` `#4BD98E` to `#6EE7A8` (L* 78 to 84; Chromium 70) | all >= 12 |
| dark Chromium vs Blocked | 24.7 / **5.7** / **3.1** / 25.3 | `blk-fg` `#B79CFF` to `#D9CCFF` (L* 70 to 85), deeper `blk-bg` | normal >= 20, protan/deutan about 11-14 (**least certain**), tritan >= 20 |
| dark headless vs Degraded | **9.5** / **8.4** / **7.1** / **8.7** | `warn-fg` `#F2C14E` to `#FFD95A` (L* 80 to 88; headless 70.5) | normal about 15, CVD 12-16 |
| dark headless vs Failed | 35.3 / 19.9 / 13.3 / **8.7** | none | tritan stays about 8.7 |
| dark Lightpanda vs Failed | 18.9 / 25.4 / 26.5 / **8.3** | none | tritan stays about 8.3 |
| light Chromium vs Blocked | 23.0 / **9.5** / **6.6** / 16.4 | `blk-fg` `#5B3FC4` to `#3D2A9E` (L* 37 to 27; Chromium 46) | protan/deutan about 14-18 |
| light headless vs Degraded | 12.0 / **9.5** / 11.9 / 11.9 | `warn-fg` `#8A5A00` to `#6B4400` (L* 42 to 32; headless 53) | all >= 15 |
| light Lightpanda vs Degraded | 44.2 / 40.0 / 29.9 / **9.7** | same change | tritan about 13 |

**Where I do not reach 10**, all under tritanopia (about 0.01% of men): dark headless vs Failed (about 8.7), dark Lightpanda vs Failed (about 8.3), light headless vs Lightpanda (9.6). Non-colour cue that covers each: engines always carry a marker shape (circle / square / diamond) and, in charts, a line style (solid / dashed / dotted); status always carries an icon and a word; the two never share a shape. If the helper finds a protan/deutan pair under 10 after this round, the planned fix is a further lightness move of `blk-fg` (dark) or Chromium's light value, not a new hue.

Status vs status was not part of the helper's check and is not guaranteed by colour: Healthy (green) and Degraded (yellow) collapse for deutan viewers; icon (check vs triangle) and the word are what separate them.

### 2.5 Real vs simulated

Neutral on purpose (hue belongs to engine and status).

- **Real** chip: solid 1px outline, filled dot, uppercase "REAL".
- **Sim** chip: dashed outline, hollow dot, diagonal hatch fill, uppercase "SIM".
- Charts: a thin strip under the Active sessions chart shows the share per minute, solid = real, hatched = sim. The Sessions KPI shows a real/sim split bar and counts ("741 real · 1,185 sim").
- Top bar: source filter `All | Real | Sim` plus a `62% sim` chip whenever Sim is included. Chart and table headers say "real + simulated" when the filter is All.

### 2.6 Chart-only tokens

| Token | Dark | Light | vs `surface` |
|---|---|---|---|
| `bar` (neutral OK action bar) | `#5B7491` | `#6B829E` | 3.7 / 4.0 |
| Alert threshold line | `warn-fg`, dotted | same | 13.0 / 8.6 |
| Capacity line | `fg-muted`, dashed | same | 7.5 / 7.6 |
| Spike / failing-span band | `err-fg` at 8-10% | same | decorative |
| Axis labels | `fg-subtle` 12px (`fg-muted` over area fills) | | 5.3 / 5.2 |

## 3. Typography

**Inter** (UI) and **JetBrains Mono** (IDs, selectors, error codes); `next/font/google`, both variable; system-ui fallback so the mockups degrade gracefully offline. Numbers use `font-variant-numeric: tabular-nums`. Minimum size 12px.

| Role | Size / line | Weight | Use |
|---|---|---|---|
| Status lead | 28 / 32 | 600 | the fleet status word on Overview only (new in v2) |
| KPI value | 26 / 30 | 600 | KPI strip |
| Page title, session header stats | 20 / 28 | 600 | h1, header stats |
| Card title | 14 / 20 | 600 | chart/table headers |
| Body | 13 / 20 | 400 | tables, lists |
| Label, caption, axis, badge | 12 / 16 | 400-500 | everything small |

Chart subtitles are one line. Legends, table headers and engine names are `white-space: nowrap`; columns are sized so nothing wraps at 1024 or 1440.

## 4. Spacing, sizing, radius

- 4px base: 4, 8, 12, 16, 24. Page padding 24 (16 below 1280). Card gap 12. Card padding 12 (KPI cell) or 16.
- Control 32 (compact 28). Table row 40. Nav item 36. Waterfall row 28. Badge 20 (28 in the session header). Icon 16 (12 in badges).
- Radius: 4 badges/kbd/bars, 6 controls, 8 cards. Shadows only on popovers and tooltips.
- Desktop hit areas are 28-32px; on touch they grow to 44px.

## 5. Layout

- Sidebar 216px with labels at >= 1280px; 56px icon rail below. Active item is a filled pill (no outline ring). Counts carry a noun ("128 live", "5 open"). Footer: collector status line. No workspace switcher (not in PLAN section 7).
- Top bar 48px sticky. Overview: time range, engine multi-select, source segmented control, `62% sim` chip, live clock, ⌘K, theme. **Session page: filters are hidden** (a session is its own scope); the bar shows breadcrumb, ⌘K and theme.
- Overview at 1440: verdict banner; one divided 7-cell KPI strip; left column (shared legend, Error rate card full column width, then Active sessions + Actions per minute side by side) and a 400px right rail with Recent failures; Engines table full width below. At 1024: rail drops below the charts and becomes a two-column list; KPI strip becomes 4 + 3 (cost spans two); table hides the Active and CPU columns.
- Session: header, root-cause banner, then `[timeline | 340px side column]`, stacked below 1280px.
- Verified widths: 1440 and 1024, no horizontal scroll.

## 6. Component rules

**Verdict banner.** `warn-bg`/`err-bg`/`ok-bg` fill, 4px inset accent in the `-fg` colour, 32px icon, status word at 28px, one sentence of evidence (with the single most telling number), a four-state distribution bar with counts and icons, capacity and engines-reporting line, one ink button to the failures.

**KPI strip.** One card, 7 cells separated by 1px lines (`gap:1px` on a `line` background). Each cell is one link to a pre-filtered Sessions view, with a visible `↗`. Anatomy: label (12 muted), value (26/600) with 12px muted unit, delta line (arrow icon + signed number + "vs prior 1 h": **one baseline everywhere**, colour = better/worse, never up/down), then one footer line: capacity track (Active), real/sim split bar (Sessions), sparkline (only on the two breaching cells), or a one-line fact (CPU, memory, cost). A breaching cell has a 3px left border in the status colour. No gauges or donuts. shadcn: `Card` + a grid of `a`.

**Chart card.** Header: title (14/600) with a one-line subtitle, "now" values as engine marker + number (shape identifies the engine), "view as table" and "open sessions" icon buttons. **One shared legend** above the chart group toggles engines in all charts (`aria-pressed`) and carries the "click any point" hint. Plot 176-260px. Y axis 3-4 ticks, X ticks every 10 min, horizontal grid only. Reserved 26px row above the Error rate plot for the spike annotation. Reference lines have their own label that never collides: threshold label sits below the line at the left, capacity label below the line at the right. The tooltip is pinned in the empty top-left of the plot (never over a label or line) and ends with a link row ("3 failed this minute, Open"). Active sessions are per-minute stacked **columns** (honest buckets) against a capacity line; Actions per minute are stacked areas (24% fill); Error rate is lines with a dash style per engine and an end marker shape. Recharts: `LineChart`, `BarChart stackId`, `AreaChart`, `ReferenceLine`, `ReferenceArea`, custom `Tooltip content`, custom `dot`.

**Table row.** 40px, 13px, numbers right-aligned and tabular, header 12px `fg-subtle`, rows are links, identity cell is `<th scope="row">`. The Engines table has a **status badge per row** and a totals row; it keeps its own height and never wraps names. shadcn `Table`.

**Status badge.** 20px, 4px radius, 12/500, icon 12px + word, `-fg` on `-bg`. Variants `healthy | degraded | failed | blocked` (cva). Never icon-only.

**Timeline bar (action waterfall).** Row 28px. Left gutter 264px (248 below 1280px): sequence number, type in mono in an **80px column** (fits `screenshot`), target in mono (truncated, full text in `title`). Bar 14px, 3px radius, min 3px wide, positioned `left = start/total`, `width = duration/total`. OK = neutral `bar`; Slow = `warn-fg` + clock + "slow"; Failed = `err-fg` + stripes + X + "failed". Duration label outside the bar (flips to the left past 82% of the axis). Selected row = `err-bg`. A shaded band marks the failing span (6.90-11.90 s) and a dashed line marks the first failure, through every row and chart. Plain divs with percentage positions.

**Shared time axis (session).** Axis header has **two rows**: an events row (failure chip, `end 12.4 s`, hover tag) above the tick row, so labels can never sit on a tick. Waterfall, CPU and memory share one grid, identical gutter and 12px padding: `x = 12 + (W-24) * t / duration`. Resource SVGs have 16px top padding so the top tick label is never clipped. CPU and memory are 2px lines with 2.5px dots at the real 0.5 s sample times. One hover cursor crosses all rows and updates the CPU and memory read-outs. In Recharts: fixed `margin`, `YAxis width={0}` with labels moved to the gutter, `syncId`, same domain `[0, durationMs]`.

## 7. Accessibility checklist

- Text >= 4.5:1 and graphics/control outlines >= 3:1 in both themes (tables above).
- Status never by colour alone; engines never by colour alone; sim never by colour at all.
- Visible 2px focus ring; segmented controls and legend toggles use `aria-pressed`; drill-down `↗` is visible at rest.
- `prefers-reduced-motion` disables the live-dot pulse and transitions.
- Charts: `role="img"` + summary, "view as table" alternative.
- Light mode is first-class: status `-fg` colours are re-derived (not reused) so badge text stays >= 5:1.
