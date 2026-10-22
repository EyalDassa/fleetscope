# Render check: promax v2

Objective checks only. No style opinions.

## Method

Same scripts as v1 (`render.mjs` with `V=v2`, `tokens-v2.mjs`, `offline2.mjs`): Playwright 1.49.1, headless Chromium 131, viewport height 900, full-page screenshots after `networkidle` + `document.fonts.ready` + 800 ms. Theme forced with `?theme=dark|light` (both proposals now support it). Overlap, spill, clip and SVG-label-clip heuristics and the rendered-contrast sampler are unchanged from v1, except that text with `font-size: 0` is ignored. CVD: Machado 2009 (severity 1.0) in linear sRGB, CIEDE2000 via culori 4.0.1; flag = ΔE < 10. Expected-vs-actual verdicts: "about X" holds within ±2, a range holds inside the range, ">= X" holds at or above X; values above a claim are reported as "better than claimed". Full-page screenshots show the sticky 100vh sidebar ending at y = 900 (screenshot artifact, as in v1).

## Screenshots

- `screenshots/overview-1440-dark.png` (1440 x 1371)
- `screenshots/overview-1440-light.png` (1440 x 1371)
- `screenshots/overview-1024-dark.png` (1024 x 1924)
- `screenshots/overview-1024-light.png` (1024 x 1924)
- `screenshots/session-1440-dark.png` (1440 x 1229)
- `screenshots/session-1440-light.png` (1440 x 1229)
- `screenshots/session-1024-dark.png` (1024 x 2101)
- `screenshots/session-1024-light.png` (1024 x 2101)

## Console, network, offline

- 8/8 runs online: no console errors or warnings (the v1 Tailwind CDN warning is gone), no page errors, no failed requests. Fonts loaded: Inter 400/500/600, JetBrains Mono 400 (and 500 on session).
- With every non-`file:` request blocked, all four page/width combinations render styled; the only blocked host is `fonts.googleapis.com`, text falls back to the system font, no horizontal overflow, no errors:

| Page | Width | Height online | Height offline | scrollWidth offline | Body font (CSS) | Blocked hosts | Errors |
|---|---|---|---|---|---|---|---|
| overview | 1440 | 1371 | 1370 | 1440 | Inter (not loaded, system fallback) | fonts.googleapis.com | none |
| overview | 1024 | 1924 | 1908 | 1024 | Inter (not loaded, system fallback) | fonts.googleapis.com | none |
| session | 1440 | 1229 | 1228 | 1440 | Inter (not loaded, system fallback) | fonts.googleapis.com | none |
| session | 1024 | 2101 | 2079 | 1024 | Inter (not loaded, system fallback) | fonts.googleapis.com | none |

## v1 → v2 comparison

| v1 problem | v2 status | Evidence |
|---|---|---|
| Unstyled without the Tailwind CDN; CDN warning on every load | **Fixed** | Inline CSS; offline table above; 0 console warnings. |
| Waterfall: `end 12.4 s` overlaps the `12 s` tick | **Fixed** | Separate events row; no overlap detected; visible in `session-*` screenshots. |
| Waterfall: `× 9.35 s` chip hides the `8 s` tick (1440) | **Fixed** | Chip sits in the events row above the tick row. |
| Row 11 `screenshot` spills into `full page` | **Fixed** | No spill detected at either width. |
| CPU/Memory top labels `100%` / `80 MB` clipped 7px | **Fixed** | 0 clipped SVG labels. |
| Sessions KPI caption overlaps the split bar by 4px | **Fixed** | Bar 329-337px, caption line box 341-357px (4px gap). |
| Static tooltip covers `alert at 10%` (1440) | **Fixed** | Tooltip in the top-left of the plot; label below the threshold line. |
| Two chart legends wrap (1440) | **Fixed** | One shared one-line legend. |
| `chrome-headless-shell` wraps in the engines table (1440) | **Fixed** | One line at 1440 and 1024. |
| CVD dark Chromium vs Healthy, tritan 8.6 | **Fixed** (10.9) | Above 10; below the claimed >= 12. |
| CVD dark Chromium vs Blocked, protan 5.7 / deutan 3.1 | **Deutan fixed (13.5); protan still under 10 (8.8)** | See CVD section. |
| CVD dark headless vs Degraded, 9.5 / 8.4 / 7.1 / 8.7 | **Fixed** (15.6 / 13.6 / 11.3 / 15.0) | |
| CVD dark headless vs Failed, tritan 8.7 | **Still present** (8.7, unchanged token) | Acknowledged in changes.md. |
| CVD dark Lightpanda vs Failed, tritan 8.3 | **Still present** (8.3, unchanged token) | Acknowledged. |
| CVD light Chromium vs Blocked, protan 9.5 / deutan 6.6 | **Fixed** (16.7 / 14.0) | |
| CVD light headless vs Degraded, protan 9.5 | **Fixed** (17.6) | |
| CVD light Lightpanda vs Degraded, tritan 9.7 | **Fixed** (15.7) | |
| CVD light headless vs Lightpanda, tritan 9.6 | **Still present** (9.6, unchanged tokens) | Acknowledged. |

## New findings at 1024 / 1440

- Horizontal overflow: none on either page, either width, either theme. No text overlaps, spills or clipped SVG labels detected.
- **Overview, Active sessions + Actions per minute row is 4px wider than its column** at both widths: the Actions card's right edge is 1008 vs 1004 for the Error rate card above it (1440) and 1012 vs 1008 page content edge (1024). Cause: the `.pair` grid resolves to `466px 462px` + 12px gap = 940px inside a 936px (1024) container; the `article.card` has `min-width: auto`, so its 462px min-content width forces the overflow.
- Overview at 1440: the right rail (Recent failures) ends at y = 1036, the chart row beside it at y = 1046 (10px mismatch).
- Overview at 1440: the `alert at 10%` label clears the headless-shell dashed line by about 3px (no overlap).
- Session, rows 9 and 10: vertical gridlines pass through the `2.45 s · failed` duration labels (labels have no background). The row 10 label ends about 2px left of the dashed failure line.
- Session: the dashed failure line runs through the JS heap "Not available" placeholder text (also true in v1).

## Token contrast (claimed in system.md / changes.md vs computed)

All 26 pairs within 0.2 of the claim and all pass their target. The new status values match: `ok-fg` 11.61 / 10.18, `warn-fg` 13.03 / 11.14, `blk-fg` 11.93 / 9.58 (dark, on `surface` / own bg); light `warn-fg` 8.56 / 7.63, `blk-fg` 10.38 / 8.59.

| Pair | Need | Dark claimed | Dark actual | Light claimed | Light actual | Result |
|---|---|---|---|---|---|---|
| `fg` on `bg` | 4.5:1 | 16.3 | 16.29 | 16.6 | 16.64 | ok |
| `fg` on `surface` | 4.5:1 | 15.1 | 15.13 | 18 | 18.01 | ok |
| `fg` on `surface-2` | 4.5:1 | 13.8 | 13.79 | 16.2 | 16.18 | ok |
| `fg-muted` on `bg` | 4.5:1 | 8 | 8.02 | 7 | 7.00 | ok |
| `fg-muted` on `surface` | 4.5:1 | 7.5 | 7.45 | 7.6 | 7.58 | ok |
| `fg-muted` on `surface-2` | 4.5:1 | 6.8 | 6.79 | 6.8 | 6.81 | ok |
| `fg-subtle` on `bg` | 4.5:1 | 5.7 | 5.67 | 4.8 | 4.80 | ok |
| `fg-subtle` on `surface` | 4.5:1 | 5.3 | 5.27 | 5.2 | 5.20 | ok |
| `fg-subtle` on `surface-2` | 4.5:1 | 4.8 | 4.80 | 4.7 | 4.67 | ok |
| `on-ink` on `ink` | 4.5:1 | 16.3 | 16.29 | 18 | 18.01 | ok |
| `line-strong` on `bg` | 3:1 | 3.5 | 3.53 | 3.3 | 3.33 | ok |
| `line-strong` on `surface` | 3:1 | 3.3 | 3.28 | 3.6 | 3.61 | ok |
| `ok-fg` on `ok-bg` (v2 value) | 4.5:1 | 10.2 | 10.18 | 5.8 | 5.76 | ok |
| `warn-fg` on `warn-bg` (v2 value) | 4.5:1 | 11.1 | 11.14 | 7.6 | 7.63 | ok |
| `err-fg` on `err-bg` | 4.5:1 | 6.5 | 6.46 | 5.4 | 5.44 | ok |
| `blk-fg` on `blk-bg` (v2 value) | 4.5:1 | 9.6 | 9.58 | 8.6 | 8.59 | ok |
| `ok-fg` on `surface` (v2 value) | 4.5:1 | 11.6 | 11.61 | 6.6 | 6.61 | ok |
| `warn-fg` on `surface` (v2 value) | 4.5:1 | 13 | 13.03 | 8.6 | 8.56 | ok |
| `err-fg` on `surface` | 4.5:1 | 7.1 | 7.12 | 6.6 | 6.57 | ok |
| `blk-fg` on `surface` (v2 value) | 4.5:1 | 11.9 | 11.93 | 10.4 | 10.38 | ok |
| `chromium` on `surface` | 3:1 | 7.7 | 7.74 | 5.2 | 5.19 | ok |
| `headless` on `surface` | 3:1 | 7.9 | 7.93 | 4 | 3.99 | ok |
| `lightpanda` on `surface` | 3:1 | 5.8 | 5.83 | 5.3 | 5.25 | ok |
| `bar` on `surface` | 3:1 | 3.7 | 3.70 | 4 | 3.95 | ok |
| alert threshold line (`warn-fg`) vs `surface` (v2 value) | 3:1 | 13 | 13.03 | 8.6 | 8.56 | ok |
| capacity line (`fg-muted`) vs `surface` (v2 value) | 3:1 | 7.5 | 7.45 | 7.6 | 7.58 | ok |

Claimed CIE L* values (used in system.md 2.4 to reason about CVD) are all within 0.4 of the computed CIELAB values:

| Colour (theme) | Claimed L* | Actual L* (CIELAB D65) |
|---|---|---|
| ok-fg #6EE7A8 (dark) | 84 | 83.6 |
| chromium #56B4E9 (dark) | 70 | 69.8 |
| blk-fg #D9CCFF (dark) | 85 | 84.6 |
| warn-fg #FFD95A (dark) | 88 | 87.8 |
| headless #E69F00 (dark) | 70.5 | 70.6 |
| blk-fg #3D2A9E (light) | 27 | 27.1 |
| chromium #0072B2 (light) | 46 | 46.0 |
| warn-fg #6B4400 (light) | 32 | 32.4 |
| headless #B86E00 (light) | 53 | 53.3 |

## Rendered text contrast (mockups)

**dark**: 892 visible text nodes over both pages and widths, 38 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| session | "128 live" (`span.ct.tnum`) | 12px/400 | `#7D8DA1` on `#17212C` | 4.80 | 4.5 | pass |
| overview | "128 live" (`span.ct.tnum`) | 12px/400 | `#7D8DA1` on `#111821` | 5.27 | 4.5 | pass |
| overview | "×12" (`span.subtle.tnum`) | 13px/400 | `#7D8DA1` on `#111821` | 5.27 | 4.5 | pass |
| overview | "Updated 1 s ago · stream con" (`p.t12.subtle`) | 12px/400 | `#7D8DA1` on `#0B0F14` | 5.67 | 4.5 | pass |
| overview | "Success rate is" (`p.muted`) | 13px/400 | `#9AA9BB` on `#2E2410` | 6.37 | 4.5 | pass |

**light**: 892 visible text nodes over both pages and widths, 38 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| session | "128 live" (`span.ct.tnum`) | 12px/400 | `#5F6E82` on `#F0F3F7` | 4.67 | 4.5 | pass |
| overview | "Updated 1 s ago · stream con" (`p.t12.subtle`) | 12px/400 | `#5F6E82` on `#F4F6F9` | 4.80 | 4.5 | pass |
| overview | "128 live" (`span.ct.tnum`) | 12px/400 | `#5F6E82` on `#FFFFFF` | 5.20 | 4.5 | pass |
| overview | "×12" (`span.subtle.tnum`) | 13px/400 | `#5F6E82` on `#FFFFFF` | 5.20 | 4.5 | pass |
| session | "9.35 s · failed" (`span.badge.b-err`) | 12px/500 | `#B42318` on `#FDE4E1` | 5.44 | 4.5 | pass |

0 rendered text below AA in either theme. Lowest is `fg-subtle` on `surface-2` ("128 live" in the active nav pill): 4.80 dark, 4.67 light. Matches the changes.md prediction. No text is drawn in an engine colour.

## CVD: expected (system.md 2.4 / changes.md) vs actual

19/22 predictions held.

| Pair (theme) | Vision | Expected | Actual | Verdict |
|---|---|---|---|---|
| chromium vs ok-fg (dark) | normal | >= 12 | 38.7 | held |
| chromium vs ok-fg (dark) | protan | >= 12 | 40.0 | held |
| chromium vs ok-fg (dark) | deutan | >= 12 | 37.1 | held |
| chromium vs ok-fg (dark) | tritan | >= 12 | 10.9 | **missed** |
| chromium vs blk-fg (dark) | normal | >= 20 | 27.5 | held |
| chromium vs blk-fg (dark) | protan | 11-14 | 8.8 | **missed** (under 10) |
| chromium vs blk-fg (dark) | deutan | 11-14 | 13.5 | held |
| chromium vs blk-fg (dark) | tritan | >= 20 | 26.8 | held |
| headless vs warn-fg (dark) | normal | about 15 | 15.6 | held |
| headless vs warn-fg (dark) | protan | 12-16 | 13.6 | held |
| headless vs warn-fg (dark) | deutan | 12-16 | 11.3 | **missed** |
| headless vs warn-fg (dark) | tritan | 12-16 | 15.0 | held |
| headless vs err-fg (dark) | tritan | about 8.7 | 8.7 | held (under 10) |
| lightpanda vs err-fg (dark) | tritan | about 8.3 | 8.3 | held (under 10) |
| chromium vs blk-fg (light) | protan | 14-18 | 16.7 | held |
| chromium vs blk-fg (light) | deutan | 14-18 | 14.0 | held |
| headless vs warn-fg (light) | normal | >= 15 | 20.4 | held |
| headless vs warn-fg (light) | protan | >= 15 | 17.6 | held |
| headless vs warn-fg (light) | deutan | >= 15 | 21.4 | held |
| headless vs warn-fg (light) | tritan | >= 15 | 20.2 | held |
| lightpanda vs warn-fg (light) | tritan | about 13 | 15.7 | better than claimed |
| headless vs lightpanda (light) | tritan | about 9.6 | 9.6 | held (under 10) |

changes.md says "Three remain, all tritanopia only". Measured: **four** pairs under 10. The three tritan pairs are as predicted, plus **dark Chromium `#56B4E9` vs Blocked `#D9CCFF` under protanopia, 8.75** (predicted 11-14; flagged by the designer as least certain). System.md 2.4's statement that all engine-vs-engine protan/deutan values are >= 11.0 holds (lowest 11.0, light Chromium vs Lightpanda, protan).

## CVD: full table (v2 palette)

**dark** (engines: chromium #56B4E9, headless #E69F00, lightpanda #CC79A7; status: ok-fg #6EE7A8, warn-fg #FFD95A, err-fg #FF7B7B, blk-fg #D9CCFF)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 53.6 | 50.6 | 54.3 | 53.5 |
| chromium vs lightpanda | 45.5 | 14.1 | 15.5 | 65.3 |
| headless vs lightpanda | 49.0 | 43.4 | 36.7 | 11.1 |
| chromium vs ok-fg | 38.7 | 40.0 | 37.1 | 10.9 |
| chromium vs warn-fg | 54.7 | 51.2 | 54.9 | 42.6 |
| chromium vs err-fg | 50.6 | 33.3 | 42.5 | 74.0 |
| chromium vs blk-fg | 27.5 | **8.8** | 13.5 | 26.8 |
| headless vs ok-fg | 42.0 | 19.4 | 19.7 | 58.1 |
| headless vs warn-fg | 15.6 | 13.6 | 11.3 | 15.0 |
| headless vs err-fg | 35.3 | 19.9 | 13.3 | **8.7** |
| headless vs blk-fg | 48.1 | 48.2 | 47.6 | 27.8 |
| lightpanda vs ok-fg | 67.4 | 38.5 | 24.2 | 60.8 |
| lightpanda vs warn-fg | 55.8 | 47.6 | 39.4 | 21.6 |
| lightpanda vs err-fg | 18.9 | 25.4 | 26.5 | **8.3** |
| lightpanda vs blk-fg | 24.1 | 20.6 | 18.5 | 29.7 |

**light** (engines: chromium #0072B2, headless #B86E00, lightpanda #B0457F; status: ok-fg #0B6B39, warn-fg #6B4400, err-fg #B42318, blk-fg #3D2A9E)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 48.7 | 50.2 | 55.5 | 49.0 |
| chromium vs lightpanda | 41.7 | 11.0 | 18.6 | 59.1 |
| headless vs lightpanda | 44.4 | 42.7 | 32.5 | **9.6** |
| chromium vs ok-fg | 41.2 | 41.6 | 39.2 | 11.8 |
| chromium vs warn-fg | 45.8 | 48.8 | 49.8 | 45.3 |
| chromium vs err-fg | 48.1 | 46.1 | 50.9 | 54.4 |
| chromium vs blk-fg | 26.6 | 16.7 | 14.0 | 21.0 |
| headless vs ok-fg | 43.1 | 12.7 | 22.8 | 52.7 |
| headless vs warn-fg | 20.4 | 17.6 | 21.4 | 20.2 |
| headless vs err-fg | 26.0 | 18.0 | 12.4 | 14.0 |
| headless vs blk-fg | 59.1 | 60.4 | 65.8 | 49.6 |
| lightpanda vs ok-fg | 66.1 | 33.2 | 21.1 | 55.5 |
| lightpanda vs warn-fg | 42.9 | 38.8 | 30.5 | 15.7 |
| lightpanda vs err-fg | 26.5 | 36.3 | 29.4 | 13.4 |
| lightpanda vs blk-fg | 27.2 | 13.1 | 26.2 | 48.2 |

Flagged (ΔE < 10):

- dark: chromium #56B4E9 vs blk-fg #D9CCFF: protan 8.75
- dark: headless #E69F00 vs err-fg #FF7B7B: tritan 8.69
- dark: lightpanda #CC79A7 vs err-fg #FF7B7B: tritan 8.27
- light: headless #B86E00 vs lightpanda #B0457F: tritan 9.59
