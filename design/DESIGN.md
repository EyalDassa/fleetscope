# Fleetscope design system (DESIGN.md)

Status: **proposed, waiting for Eyal's approval.** Once approved, this file is the source of truth for the UI (CLAUDE.md).
Decisions and scores: `design/DECISIONS.md`. Visual reference mockups (open them in a browser):

| What to look at | Mockup |
|---|---|
| Overview layout, verdict banner, KPI strip, top bar, sidebar | `design/proposals/promax/v2/overview.html` |
| Chart cards (lines with dash per engine, source strip, compact plots), By engine table, failure rows | `design/proposals/taste/v2/overview.html` |
| Session page: banner, waterfall, shared axis, resource charts, side column | `design/proposals/promax/v2/session.html` |
| Session stat strip and Issues panel content | `design/proposals/taste/v2/session.html` |

Where a mockup and this file disagree, **this file wins**. Example: promax's mockup still shows stripes on failed bars, a "Timeout" badge and a "Raw events" tab, and this file removes all three.

Stack: Next.js App Router, Tailwind **v4** (CSS-first config, already set up in `apps/web/app/globals.css`), shadcn/ui, Recharts, lucide-react icons, `next-themes`.

---

## 1. Principles

1. **Verdict first, evidence second.** Overview opens with one word (Healthy / Degraded / Failed) and one sentence of evidence. A session opens with its root cause before its timeline.
2. **Chrome is neutral, colour is data.** Backgrounds, borders, buttons and the primary action are greys. Hue is spent only on **status** and **engine**.
3. **Never colour alone.** Status = colour + icon + word. Engine = colour + marker shape + line style + name. Real/sim = chip style + dot shape + word, and hatch for sim in charts.
4. **Every number is a door.** KPI cells, chart points, table rows, issue codes and counts link to the sessions behind them (a pre-filtered `/sessions?...` URL). The door is visible without hovering (`↗` or `→`).
5. **Honest data.** Simulated data is always labelled. Zero prints `0`. A ratio with no denominator prints `—`. A metric the engine can't provide is "Not available" with the reason. Never estimate it, never draw it as zero.

**One meaning per pattern:** **hatch = simulated**, and nothing else is hatched or striped. A **dashed frame = not available.** **Violet = blocked.** Engine colours never mean status, and status colours never mean an engine.

---

## 2. Color tokens

Every value below was measured by the render helper (`design/proposals/promax/v2/render-check.md`): 26/26 token pairs pass, and 0 rendered text nodes are below AA in either theme. **Do not change a value without re-running the contrast and CVD check** (section 9).

### 2.1 Neutrals

| Token | shadcn variable | Dark | Light | Use |
|---|---|---|---|---|
| `bg` | `--background` | `#0B0F14` | `#F4F6F9` | page, sidebar, top bar |
| `surface` | `--card`, `--popover` (light) | `#111821` | `#FFFFFF` | cards, tables |
| `surface-2` | `--muted`, `--accent`, `--secondary`, `--popover` (dark) | `#17212C` | `#F0F3F7` | hover row, active nav pill, selected segment bg, kbd |
| `line` | `--border` | `#243142` | `#DDE3EA` | decorative card/row edges, grid lines |
| `line-strong` | `--input` | `#5B6B80` | `#7A889B` | control outlines (≥ 3:1) |
| `fg` | `--foreground`, `--ring` | `#E6EDF5` | `#0F1722` | primary text, focus ring |
| `fg-muted` | `--muted-foreground` | `#9AA9BB` | `#475569` | labels, secondary text, units |
| `fg-subtle` | `--subtle` (custom) | `#7D8DA1` | `#5F6E82` | axis ticks, meta, captions |
| `ink` | `--primary` | `#E6EDF5` | `#0F1722` | primary button fill, selected segment |
| `on-ink` | `--primary-foreground` | `#0B0F14` | `#FFFFFF` | text on `ink` |

Measured text contrast (dark / light): `fg` ≥ 13.8 / 16.2 on every surface. `fg-muted` ≥ 6.8 / 6.8. `fg-subtle`: 5.7 / 4.8 on `bg`, 5.3 / 5.2 on `surface`, 4.8 / 4.67 on `surface-2` (the lowest pair in the system). `line-strong` ≥ 3.28 / 3.33.
**Rule:** `fg-subtle` is never placed on a status tint or a chart area fill. Use `fg-muted` there.

### 2.2 Status

| State | Maps from (schema, PLAN section 5) | Icon (lucide) | Dark fg / bg | Light fg / bg |
|---|---|---|---|---|
| Healthy | `session.ended.status = success`, no retry, no slow action, no issue | `CircleCheck` | `#6EE7A8` / `#10281C` | `#0B6B39` / `#DDF5E7` |
| Degraded | `success` with a retry, an action over its p95, or any `issue` | `TriangleAlert` | `#FFD95A` / `#2E2410` | `#6B4400` / `#FDF1D3` |
| Failed | `failed`, `timeout`, `crashed` | `CircleX` | `#FF7B7B` / `#33191B` | `#B42318` / `#FDE4E1` |
| Blocked | `blocked` (bot wall, CAPTCHA) | `Ban` | `#D9CCFF` / `#2B2159` | `#3D2A9E` / `#ECE7FB` |
| Running | no `session.ended` yet | pulsing dot | `fg-muted`, no fill | `fg-muted`, no fill |

Measured: `-fg` on its own `-bg` ≥ 6.5 dark / 5.4 light. `-fg` on `surface` ≥ 7.1 / 6.6.
- Exactly **four status words** (plus Running). `timeout` and `crashed` are **Failed** with the reason code beside the badge in mono. They are never their own badge.
- Fleet and engine thresholds (open question 1 for Eyal, these are the defaults): success ≥ 95% Healthy, 90 to 95% Degraded, < 90% Failed. Success rate = (healthy + degraded) / ended sessions. The fleet verdict is the **worst** of: success rate, error rate above the 10% alert line, and capacity above 90%.
- Healthy (green) and Degraded (yellow) are close under deutan vision. The icon (check vs triangle) and the word separate them, which is why badge icons are 14px, not 12px.

### 2.3 Engines

Okabe-Ito colour-blind-safe hues. Each engine always has the same colour, marker and line style, everywhere.

| Engine (API name) | Label in UI | Marker | Line (`strokeDasharray`) | Dark | Light |
|---|---|---|---|---|---|
| `chromium` | Chromium | circle | solid | `#56B4E9` | `#0072B2` |
| `chrome-headless-shell` | chrome-headless-shell | rounded square | `7 4` | `#E69F00` | `#B86E00` |
| `lightpanda` | Lightpanda | diamond | `9 3 2 3` (dash-dot) | `#CC79A7` | `#B0457F` |

Measured non-text contrast on `surface` (dark / light): 7.74 / 5.19, 7.93 / 3.99, 5.83 / 5.25. On a hovered `surface-2` row the light values are about 4.5 / 3.6 / 4.6 (lead estimate; QA confirms in the token test).

- **Engine colours are never text colours.** Names and versions are `fg` / `fg-muted`.
- Always write the full API name `chrome-headless-shell`, with `white-space: nowrap`, and size columns so it fits. The UI uses the same names as the API and MCP.
- CVD (measured, CIEDE2000 under Machado 2009 simulation): every engine-vs-engine protanopia/deuteranopia pair is ≥ 11.0. Accepted flags, all covered by shape + word:
  - dark Chromium vs Blocked, protan 8.75
  - dark headless vs Failed, tritan 8.69
  - dark Lightpanda vs Failed, tritan 8.27
  - light headless vs Lightpanda, tritan 9.59

  Engine and status never share a mark type (marker vs badge), and no status is plotted as a series inside an engine chart.

### 2.4 Chart-only tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bar` | `#5B7491` | `#6B829E` | neutral OK bar in the waterfall (3.70 / 3.95 on surface) |
| alert line | `--degraded` | same | dotted, error-rate threshold |
| capacity line | `--muted-foreground` | same | dashed, Active sessions |
| spike / failing span | `--failed` at 10% opacity | same | `ReferenceArea`, decorative |
| grid | `--border` | same | horizontal grid only |

### 2.5 Real vs simulated

| Element | Real | Sim |
|---|---|---|
| Chip (20px, 12px uppercase 500) | 1px **solid** `line-strong` outline, **filled** dot, `REAL` | 1px **dashed** `line-strong` outline, **hollow** dot, hatched bg, `SIM` |
| Source strip (6px, under every time chart's x axis) | solid `fg-subtle` share per minute | hatched `fg-subtle` share per minute |
| Top bar | n/a | `62% sim` chip (dashed) beside the source filter whenever the filter includes sim |
| Sim-only filter | n/a | page canvas gets a 1px dashed outline and a notice "Simulated data only" |

Hatch (the only hatch in the app):
```css
.hatch { background-image: repeating-linear-gradient(135deg, var(--subtle) 0 1px, transparent 1px 4px); }
```

---

## 3. CSS variables and Tailwind v4 config

Theme switching: `next-themes` with `attribute="class"`, `defaultTheme="dark"`, `enableSystem={false}`. `:root` holds light (the shadcn convention) and `.dark` holds dark. Dark is the default on first load.

Paste into `apps/web/app/globals.css`:

```css
@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

:root {
  --radius: 8px;
  /* neutrals (light) */
  --background: #F4F6F9; --foreground: #0F1722;
  --card: #FFFFFF; --card-foreground: #0F1722;
  --popover: #FFFFFF; --popover-foreground: #0F1722;
  --primary: #0F1722; --primary-foreground: #FFFFFF;
  --secondary: #F0F3F7; --secondary-foreground: #0F1722;
  --muted: #F0F3F7; --muted-foreground: #475569;
  --accent: #F0F3F7; --accent-foreground: #0F1722;
  --destructive: #B42318;
  --border: #DDE3EA; --input: #7A889B; --ring: #0F1722;
  --subtle: #5F6E82;
  --sidebar: #F4F6F9; --sidebar-foreground: #0F1722;
  --sidebar-accent: #F0F3F7; --sidebar-accent-foreground: #0F1722;
  --sidebar-border: #DDE3EA; --sidebar-ring: #0F1722;
  --sidebar-primary: #0F1722; --sidebar-primary-foreground: #FFFFFF;
  /* status (light) */
  --healthy: #0B6B39;  --healthy-bg: #DDF5E7;
  --degraded: #6B4400; --degraded-bg: #FDF1D3;
  --failed: #B42318;   --failed-bg: #FDE4E1;
  --blocked: #3D2A9E;  --blocked-bg: #ECE7FB;
  /* engines (light) */
  --engine-chromium: #0072B2; --engine-headless: #B86E00; --engine-lightpanda: #B0457F;
  --chart-1: var(--engine-chromium); --chart-2: var(--engine-headless); --chart-3: var(--engine-lightpanda);
  --bar: #6B829E;
}

.dark {
  --background: #0B0F14; --foreground: #E6EDF5;
  --card: #111821; --card-foreground: #E6EDF5;
  --popover: #17212C; --popover-foreground: #E6EDF5;
  --primary: #E6EDF5; --primary-foreground: #0B0F14;
  --secondary: #17212C; --secondary-foreground: #E6EDF5;
  --muted: #17212C; --muted-foreground: #9AA9BB;
  --accent: #17212C; --accent-foreground: #E6EDF5;
  --destructive: #FF7B7B;
  --border: #243142; --input: #5B6B80; --ring: #E6EDF5;
  --subtle: #7D8DA1;
  --sidebar: #0B0F14; --sidebar-foreground: #E6EDF5;
  --sidebar-accent: #17212C; --sidebar-accent-foreground: #E6EDF5;
  --sidebar-border: #243142; --sidebar-ring: #E6EDF5;
  --sidebar-primary: #E6EDF5; --sidebar-primary-foreground: #0B0F14;
  --healthy: #6EE7A8;  --healthy-bg: #10281C;
  --degraded: #FFD95A; --degraded-bg: #2E2410;
  --failed: #FF7B7B;   --failed-bg: #33191B;
  --blocked: #D9CCFF;  --blocked-bg: #2B2159;
  --engine-chromium: #56B4E9; --engine-headless: #E69F00; --engine-lightpanda: #CC79A7;
  --bar: #5B7491;
}

@theme inline {
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring);
  --color-subtle: var(--subtle);
  --color-sidebar: var(--sidebar); --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-accent: var(--sidebar-accent); --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border); --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-primary: var(--sidebar-primary); --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-healthy: var(--healthy);   --color-healthy-bg: var(--healthy-bg);
  --color-degraded: var(--degraded); --color-degraded-bg: var(--degraded-bg);
  --color-failed: var(--failed);     --color-failed-bg: var(--failed-bg);
  --color-blocked: var(--blocked);   --color-blocked-bg: var(--blocked-bg);
  --color-engine-chromium: var(--engine-chromium);
  --color-engine-headless: var(--engine-headless);
  --color-engine-lightpanda: var(--engine-lightpanda);
  --color-bar: var(--bar);

  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-jetbrains-mono), ui-monospace, monospace;

  /* type scale: 6 sizes, nothing else */
  --text-status: 28px; --text-status--line-height: 32px;
  --text-kpi: 22px;    --text-kpi--line-height: 28px;
  --text-title: 20px;  --text-title--line-height: 28px;
  --text-card: 14px;   --text-card--line-height: 20px;
  --text-body: 13px;   --text-body--line-height: 20px;
  --text-label: 12px;  --text-label--line-height: 16px;

  --radius-sm: calc(var(--radius) - 4px); /* 4: badges, chips, kbd, bars */
  --radius-md: calc(var(--radius) - 2px); /* 6: controls */
  --radius-lg: var(--radius);             /* 8: cards */
}

body { @apply bg-background text-foreground font-sans text-body; font-variant-numeric: tabular-nums; }
.hatch { background-image: repeating-linear-gradient(135deg, var(--subtle) 0 1px, transparent 1px 4px); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
```

Fonts in `app/layout.tsx`: `next/font/google` `Inter({ variable: "--font-inter" })` and `JetBrains_Mono({ variable: "--font-jetbrains-mono" })`. Both are self-hosted at build time.

Tailwind usage: `bg-card`, `text-muted-foreground`, `text-subtle`, `bg-failed-bg text-failed`, `border-input`, `text-kpi font-semibold`, `text-label`, `rounded-lg` (card), `rounded-md` (control), `rounded-sm` (badge).

### 3.1 One typed map for engines and statuses

Put this in `apps/web/lib/visual.ts`. Charts, badges, legends and filters read **only** from here, so they cannot drift. The keys come from the zod enums in `packages/schema`. Do not redefine them.

```ts
export const ENGINES = {
  chromium:               { label: "Chromium",              color: "var(--engine-chromium)",   marker: "circle",  dash: undefined },
  "chrome-headless-shell": { label: "chrome-headless-shell", color: "var(--engine-headless)",   marker: "square",  dash: "7 4" },
  lightpanda:             { label: "Lightpanda",            color: "var(--engine-lightpanda)", marker: "diamond", dash: "9 3 2 3" },
} as const; // satisfies Record<Engine, EngineVisual>, with Engine taken from @fleetscope/schema

export const STATUSES = {
  healthy:  { label: "Healthy",  icon: CircleCheck,   fg: "text-healthy",  bg: "bg-healthy-bg" },
  degraded: { label: "Degraded", icon: TriangleAlert, fg: "text-degraded", bg: "bg-degraded-bg" },
  failed:   { label: "Failed",   icon: CircleX,       fg: "text-failed",   bg: "bg-failed-bg" },
  blocked:  { label: "Blocked",  icon: Ban,           fg: "text-blocked",  bg: "bg-blocked-bg" },
} as const;
```

---

## 4. Typography

**Inter** for UI, **JetBrains Mono** for session ids, selectors, action types, error codes and versions in tables. The minimum size is **12px**. All numbers use `tabular-nums`.

| Token | Size / line | Weight | Used for (only) |
|---|---|---|---|
| `text-status` | 28 / 32 | 600 | the fleet status word on Overview, nothing else |
| `text-kpi` | 22 / 28 | 600 | KPI values (Overview strip and session stat strip) |
| `text-title` | 20 / 28 | 600 | page title (h1), session id in mono |
| `text-card` | 14 / 20 | 600 | card and chart titles, brand |
| `text-body` | 13 / 20 | 400 (500 for emphasis) | tables, lists, nav, buttons, banner sentence |
| `text-label` | 12 / 16 | 400 / 500 | labels, axis ticks, chips, badges, units, captions |

- Units are a 12px `text-muted-foreground` suffix: `36.2 cores`, `1.84 s`.
- Fixed decimals per metric: rates 1 decimal (`91.6%`), latency 2 decimals in s (`1.84 s`) or integer ms under 1 s in the waterfall (`842 ms`), cost 2 decimals (`$8.73`), or 4 for a single session (`$0.0004`).
- Every change carries a sign and names its window: `+0.31 s vs prior 1 h`.
- Chart subtitles, legends, table headers, engine names and badges are **one line** (`whitespace-nowrap`).

---

## 5. Spacing, sizing, layout

- **Spacing scale** (4px base): 4, 8, 12, 16, 24. Card gap 12. Card padding 16 (12 inside KPI cells). Page padding 24 (16 below `xl`).
- **Heights:** top bar 48, control 32 (`h-8`; compact 28 inside the top-bar segmented controls), nav item 36, table row 40, waterfall row 28, badge and chip 20, icon 16 (14 in badges).
- **Radius:** card 8, control 6, badge, chip, kbd and bar 4. Shadows only on popover, tooltip and the ⌘K palette.
- **Breakpoint:** one breakpoint, Tailwind `xl` (1280px). Both 1440 and 1024 must render with **no horizontal scroll**.
- **Grid rule:** every grid and flex child that contains a chart or a table gets `min-w-0`, and every grid track uses `minmax(0,1fr)`. This prevents the 4px overflow seen in promax v2. Sibling columns stretch to one height (`items-stretch`).

### 5.1 Shell

- **Sidebar:** 216px with labels at `xl` and above, a 56px icon rail below. Items: Overview, Sessions (`128 live`), Browsers, Usage & cost, Insights (`5 open`). Counts always carry a noun. The active item is a filled `surface-2` pill with no ring. The footer shows collector status as text ("Collector live · last event 0.8 s ago"). No workspace switcher, user row, settings or saved views (saved views live in ⌘K).
- **Top bar (48px, sticky):**
  - Overview and list pages: time range segmented control (`15m 1h 24h 7d Custom`), engine multi-select (with markers), source segmented control (`All | Real | Sim`) and the `% sim` chip on the left; a `Live · hh:mm:ss` indicator, ⌘K search and theme toggle on the right.
  - **Session page:** filters are hidden. Breadcrumb `Overview > Sessions > s_9Kd2xQ`, ⌘K and theme only.
  - All filter state lives in URL search params.

### 5.2 Overview (`/`)

At `xl`, top to bottom:
1. **Title row:** h1 "Overview", a range sentence ("Last 1 hour · 13:42–14:42 · all engines · real + simulated"), and on the right "Updated 1 s ago · stream connected".
2. **Verdict banner** (section 6.1).
3. **KPI strip,** 7 cells (6.2).
4. **Two columns** `grid-cols-[minmax(0,1fr)_400px]`:
   - Left: shared legend, Error rate (full column width), then Active sessions and Actions per minute side by side.
   - Right: the Recent failures rail (6 rows + "View all N failures").
5. **By engine table,** full width.

Below `xl`: the KPI strip becomes 4 + 3, the rail moves below the charts as a two-column list, and the table hides CPU and Memory.

### 5.3 Session detail (`/sessions/[id]`)

Header → root-cause banner → stat strip → `[timeline card | 340px side column]`.
- Side column order: Issues, "<scenario> on each engine", Details.
- Tabs on the timeline card: **Timeline | Network | Screenshots** (no "Raw events").
- Below `xl` everything stacks in this order: header, banner, stat strip, **timeline**, Issues, engine comparison, Details. The timeline comes before Issues.

---

## 6. Components

### 6.1 Verdict banner (Overview)
- `-bg` fill of the fleet status and a 4px inset left edge in the `-fg` colour.
- 32px status icon, the status word in `text-status`, one sentence of evidence in `text-body` with the single most telling number in 600 weight. Example: "Success rate is **91.6%**, 3.4 pts below the prior hour (target 95%). Lightpanda errors peaked at **28.4% at 14:25**; 71 of its 89 failures are `unsupported_api`."
- On the right: the **four-state distribution bar**: 8px tall, segments `healthy / degraded / failed / blocked` filled with each `-fg`, a 2px gap between segments, and each non-zero segment at least 4px wide. Under the bar: counts with icons ("Healthy 1,642 · Degraded 122 · Failed 111 · Blocked 51") and a line "Capacity 128 / 200 slots (64%) · engines reporting 3 / 3".
- One primary (`ink`) button: "Review 162 failures ↗", which opens Sessions filtered to failed + blocked in range.
- When the fleet is Healthy the banner stays, but slim: the word, one sentence, and the bar.

### 6.2 KPI strip
- One shadcn `Card`. Cells sit in a grid with `gap-px bg-border` so the 1px dividers come from the gap. Each cell is a single `<a>` to a pre-filtered Sessions view.
- Cells: Active now, Sessions (range), Success rate, p95 action latency, CPU in use, Memory, Est. cost (range).
- Cell anatomy, top to bottom:
  1. Label (`text-label text-muted-foreground`) with `↗` (`ArrowUpRight` 14px, `text-subtle`, `text-foreground` on hover/focus) top right. The arrow is always visible.
  2. Value `text-kpi font-semibold` + unit suffix.
  3. Delta line: arrow icon + signed value + "vs prior 1 h". Colour means **better/worse** (`text-healthy` / `text-failed`), with a hidden `<span class="sr-only">worse</span>`. A neutral change (e.g. session count) is `text-muted-foreground`.
  4. One footer line, at most:
     - capacity track (Active)
     - real/sim split bar, solid + hatched, with "741 real · 1,185 sim" 4px below it (Sessions)
     - a one-line fact ("0.28 cores / session", "≈ $210 / day")
- **Breaching cell:** `shadow-[inset_3px_0_0_var(--failed)]` (or `--degraded` if the breach is a degraded-level breach). No tint, no sparkline.
- **Don't** add sparklines, gauges or donuts.

### 6.3 Chart card
- Header (one line): title `text-card` + one-line subtitle on the left. On the right: "now" values as engine marker + number (the marker identifies the engine), then a 24px "View as table" icon button (`Table2`) and an "Open sessions" `↗` icon button.
- **One shared legend** above the chart group: line sample + marker + name per engine (toggle buttons with `aria-pressed`, filtering all three charts), the source key (`■ real ▨ sim`), and the hint "Click any point to open the sessions behind it".
- Plot heights: **Error rate 200px**, Active sessions and Actions per minute **160px**.
- Axes: horizontal grid only, 3 to 5 y ticks, x ticks every 10 min for 1 h (scale with the range), ticks `text-label` in `--subtle`, no axis lines.
- Charts:
  - **Error rate:** `LineChart`, one 2px line per engine with its dash and an end marker (custom `dot` on the last point only). Alert `ReferenceLine` at 10%, dotted, `--degraded`, label "alert 10%" below the line at the left. Spike `ReferenceArea` with a label in a reserved 24px row above the plot ("Spike 14:21–14:28 · 31 failed"). Peak label at the max point ("28.4% at 14:25"). **At most one event marker:** optional "Lightpanda v0.2.9 first seen" (dashed vertical `ReferenceLine`, derived from `session.started.engine_version`, cut first if behind).
  - **Active sessions:** `BarChart` with `stackId`, per-minute columns, 1px `--card` stroke seams, dashed capacity `ReferenceLine` labelled "capacity 200" under the line at the right.
  - **Actions per minute:** `LineChart`, same encoding as Error rate (lines, not stacked areas).
- **Source strip:** a 6px row under the x axis of every time chart. Each minute is split into a solid `--subtle` real share and a hatched sim share. Build it as a sibling div row aligned to the plot's left/right margins (simpler than a Recharts `Customized`).
- **Tooltip:** `Tooltip content={<FleetTooltip/>}`, `isAnimationActive={false}`. Rows: time; one row per engine (marker + name + value, sorted by value); "Source real 66%, sim 34%"; then a link row "3 failed this minute · Open ↗". The tooltip must never cover a reference-line label; use `position`/`allowEscapeViewBox` to pin it to the top-left of the plot when the cursor is in the right half.
- Clicking a point opens `/sessions?from=…&to=…&engine=…&status=failed` for that minute.
- Live updates: SSE throttled to 1/s, `isAnimationActive={false}` everywhere, update in place.

### 6.4 Tables (shadcn `Table`)
- Rows 40px, `text-body`, 1px `--border` between rows. Header `text-label text-subtle`, no fill, `whitespace-nowrap`. Numbers right-aligned and tabular with the unit suffix muted. The identity cell is `<th scope="row">`. The whole row is a link (`→` on hover; the first cell is a real `<a>` for keyboard users).
- **By engine table:**

  | Column | Content |
  |---|---|
  | Engine | marker + name + version in mono `fg-muted` |
  | Status | badge |
  | Active now | number |
  | Sessions | number |
  | Success rate | number |
  | p95 latency | number |
  | CPU | number |
  | Memory | number |
  | Cost | number |
  | Top issue | mono code + `×48` in `fg-muted` |

  A totals row ("All engines", with its own badge) sits under a `line-strong` rule and is computed from the rows above. Below `xl`, CPU and Memory are hidden.
- **Recent failures row** (rail and Sessions-style lists):
  1. Status badge, session id (mono), time on the right.
  2. Reason code (mono, 500) + human message (truncate with ellipsis, full text in `title`).
  3. Engine marker + name, scenario, then the REAL/SIM chip on the right.

### 6.5 Status badge
- 20px tall, `rounded-sm`, `text-label font-medium`, 14px icon + word, `-fg` on `-bg`. Build it as a cva variant: `healthy | degraded | failed | blocked`. On the session page header it is 28px tall with `text-body`.
- **Never icon-only, never word-only.**

### 6.6 Engine marker
- A 10px SVG (circle / rounded square / diamond) in the engine colour, always followed by the name, except in a chart header "now" value, where the shared legend names it.

### 6.7 Session header and stat strip
- Header: status badge (28px), session id in `text-title` mono + copy button, engine marker + name + version, REAL/SIM chip. A meta line in `text-label text-muted-foreground`: started, ended, agent, scenario, region, provider. On the right: "Copy link" (secondary) and "Explain this session" (primary, `Sparkles` icon).
- **Stat strip:** the **same component as the KPI strip**, with 6 cells:
  - Duration, sub "ended by action_timeout"
  - Actions, sub "10 ok, 1 failed"
  - Startup, sub "connect 41 ms"
  - Peak CPU, sub "at 4 s, container"
  - Peak memory, sub "at 6 s, JS heap not available"
  - Cost, sub "23 requests, 1.2 MB"

### 6.8 Root-cause banner (session)
- `failed-bg` with a 4px inset `--failed` edge and a `CircleX` icon.
- Bold first line: "Failed at 9.35 s: action #9 `click button.checkout-submit`".
- Then 1–2 sentences: the error code + message, where it was thrown, what the resources show ("CPU stayed under 15% from 6.5 s to 9.5 s: the page was waiting, not working"), and the cross-engine fact ("Chromium completed this scenario in 211 of 217 runs over 24 h").
- Buttons: "Jump to action #9" and "Compatibility matrix ↗".
- Blocked sessions use `blocked-bg`, degraded sessions `degraded-bg`, and healthy sessions get no banner.

### 6.9 Action waterfall and shared time axis
- **Gutter:** 264px (248 below `xl`): sequence number (20px, `fg-subtle`), action type in mono in an **80px** column (fits `screenshot`; always the API `action_type` name), target in mono with ellipsis and the full text in `title`.
- **Axis header, two rows:** an events row (failure chip "✕ 9.35 s · failed", "end 12.4 s", hover time tag) **above** the tick row. Labels never sit on a tick.
- **Rows:** 28px. Bar 14px, `rounded-sm`, minimum 3px wide. Each bar is positioned with `left = start/total`, `width = duration/total` (plain divs with percentages).
  - **OK:** `--bar` (neutral, not the engine colour).
  - **Slow** (over its p95): `--degraded` fill + `Clock` icon + label "2.95 s · slow".
  - **Failed:** **solid** `--failed` fill + `X` icon + label "2.45 s · failed". **No stripes** (hatch means sim).
- **Duration label:** outside the bar, on the right (flipped to the left past 82% of the axis). It sits on a `--card` pill (`px-1 rounded-sm`) drawn **above** gridlines and the failure line, so no line crosses a label.
- **Selected row:** `failed-bg` (or `surface-2` for an OK row). A detail strip under the timeline repeats the selected action: badge, `#9 click button.checkout-submit`, `6.90 → 9.35 s · 2.45 s`, error code, "See issue".
- **Failure overlay:** a shaded failing span (`--failed` at 10%) plus a dashed `--failed` line at the first failure, across every row and both resource charts.
- **Resource rows:** CPU (% of one core), Memory (MB), and JS heap (CDP), sharing the waterfall's x scale.
  - Recharts `LineChart` with `syncId="session"`, `XAxis type="number" domain={[0, durationMs]} hide`, fixed `margin={{ left: 12, right: 12, top: 16 }}`, `YAxis` hidden and its tick labels rendered in the gutter.
  - 2px line + 2.5px dots at the **real** sample times. `connectNulls={false}`. Light area fill at 15%.
  - The gutter shows "CPU · peak 62% at 3.0 s".
- **One hover cursor** crosses all rows and updates the CPU and memory read-outs in the gutter.
- **Unsupported metric** (e.g. JS heap on Lightpanda): a dashed `line-strong` frame filling the row with `text-label text-muted-foreground` "Not available: Lightpanda has no CDP Performance.getMetrics (stored as null)". The frame has a `--card` background and sits above the failure line.
- **No** boot-phase rows. Startup and connect live in the stat strip.

### 6.10 Issues panel (session side column)
- One block per issue:
  - Line 1: status badge for the kind + code in mono, with "+5.74 s, action 10" on the right.
  - Line 2: the raw message in a mono `surface-2` block.
  - Line 3: one plain sentence explaining it.
  - Then links: "48 sessions with this issue in the last hour →" and "Compatibility matrix for checkout-form →".
- When a second issue is caused by the first, add a `→` line: "Follows from unsupported_api: the handler never ran."
- **"<scenario> on each engine" card:** one row per engine with marker + name, `successes / runs` over 24 h, and a status badge with the rate.

### 6.11 Empty, loading, error and degraded-data states
Neither mockup drew these, so they are defined here. Keep them small.

| Situation | Show | Never |
|---|---|---|
| Loading | shadcn `Skeleton` blocks with the final heights (KPI cell 104, plots 200/160, rows 40) | spinners inside cards; layout shift |
| Count with no events | `0` | `—` or an empty cell |
| Ratio or percentile with no denominator | `—` with `title="No sessions in range"` | `0%`, `NaN` |
| Chart with no data in range | the card frame + centred `text-body text-muted-foreground` "No sessions in this range" + a "Show 24 h" link button | an empty axis with no message |
| Metric the engine can't provide (`null`) | the dashed "Not available: <reason>" frame; gaps in lines (`connectNulls={false}`) | zero, interpolation, hatch |
| Recent failures empty | `CircleCheck` in `--healthy` + "No failures in the last 1 h" | hiding the rail |
| One card's API call fails | inside that card: `CircleX` `--failed` + "Couldn't load error rate" + request id in mono + "Retry" button; other cards keep working | a full-page error |
| SSE stream disconnected | the top bar `Live` dot becomes hollow `fg-muted` with "Paused, retrying"; the sidebar footer line uses `--degraded` text "Live updates paused"; data stays with "Updated 2 min ago" | clearing the data |
| Sim-only filter | dashed canvas outline + "Simulated data only" notice | presenting it as real |
| Unknown session id | a 404 card: "Session s_xxx not found (it may be older than 30 days)" + "Back to Sessions" | a blank page |

---

## 7. Do and don't

| Do | Don't |
|---|---|
| `<Badge variant="failed"><CircleX/> Failed</Badge>` + `<code>timeout</code>` | `<Badge>Timeout</Badge>` (a fifth status) |
| Engine name in `text-foreground`, marker in engine colour | `<span style={{color: ENGINES.lightpanda.color}}>v0.2.9</span>` (engine colour as text: the v1 AA failure) |
| `ENGINES[e].color` / `var(--engine-lightpanda)` | hard-coded `#CC79A7` in a component |
| Hatch only for simulated data | hatched blocked segments, striped failed bars, hatched "Not available" frames |
| `chrome-headless-shell` with `whitespace-nowrap` and a sized column | abbreviating it in tables or wrapping it to two lines |
| "−3.4 pts vs prior 1 h" in `text-failed` with sr-only "worse" | "▼ 3.4" in red with no baseline |
| `↗` visible at rest on every linked KPI cell | hover-only affordances |
| `grid-cols-[minmax(0,1fr)_400px]` + `min-w-0` on chart cards | `grid-cols-2` with a card whose min-content overflows (promax v2's 4px overflow) |
| Duration label on a `--card` pill above gridlines | labels with no background crossed by the failure line |
| `isAnimationActive={false}` on live charts | entrance animations on SSE updates |
| "Not available: … (stored as null)" | `0 MB` for a JS heap the engine can't report |
| `fg-muted` on status tints and area fills | `fg-subtle` on a tint (falls below 4.5:1 on some fills) |

---

## 8. Accessibility checklist
- Text ≥ 4.5:1, and graphics and control outlines ≥ 3:1, in both themes (section 2, measured).
- Status is never shown by colour alone, engines are never shown by colour alone, and sim is never shown by colour at all.
- Visible 2px focus ring (`ring-2 ring-ring ring-offset-2 ring-offset-background`). Segmented controls and legend toggles use `aria-pressed`. The ⌘K palette is shadcn `Command`.
- Charts: `role="img"` + an `aria-label` summary ("Error rate by engine, last hour. Lightpanda peaked at 28.4% at 14:25."), plus the "View as table" alternative (a shadcn `Dialog` with a `Table`).
- `prefers-reduced-motion` disables the live-dot pulse and transitions.
- Hit areas: 28–32px on desktop.

## 9. What QA checks (so the palette can't drift)
- **Token test** (vitest, `apps/web`): parse the variables in `globals.css`, then:
  - assert every text pair in section 2 is ≥ 4.5:1 and every non-text pair is ≥ 3:1, in both themes, including engine colours on `surface-2` (hovered row);
  - assert CIEDE2000 ≥ 10 under protan/deutan simulation for all engine-vs-engine pairs;
  - log (do not fail on) the four accepted flags in 2.3;
  - also log status-vs-status pairs, which no one has measured yet.
- **Playwright:** Overview and Session at 1440 and 1024 in both themes. Assert `scrollWidth === clientWidth`, no "Raw events" tab, a REAL/SIM chip on every failure row, and that the session waterfall comes before Issues at 1024.
