# Render check: promax v1

Objective checks only (rendering, layout, contrast, colour-vision simulation). No style opinions.

## Method

- Playwright 1.49.1, headless Chromium 131, deviceScaleFactor 1, viewport height 900, full-page screenshots. Waited for `networkidle`, `document.fonts.ready` and 800 ms.
- Theme: loaded in default dark, light obtained by clicking the `#theme` toggle (sets `data-theme="light"` on `<html>`).
- Overflow: `documentElement.scrollWidth > innerWidth`, plus elements whose right edge is past the viewport. Spill/clip: text-bearing elements with `scrollWidth > clientWidth`. Overlap: client rects of text nodes from different elements intersecting by more than 15% of the smaller box (hidden `<details>`/`<dialog>` content excluded). SVG `<text>` clipped by an `overflow:hidden` SVG.
- Rendered contrast: every visible text node, computed `color` (SVG: `fill`) with ancestor opacity, against the alpha-composited ancestor background. Large text = 24px, or 18.66px bold.
- Token contrast: WCAG 2.x relative luminance from the hex values in `system.md`. Flag = claimed value off by more than 0.2, or below 4.5:1 (text) / 3:1 (non-text).
- CVD: Machado et al. 2009 matrices at severity 1.0, applied in linear sRGB; ΔE = CIEDE2000 (culori 4.0.1). Flag = ΔE < 10 (bold).
- Note: both sidebars are `position: sticky; height: 100vh`, so in the full-page screenshots the sidebar background stops at y = 900. That is a screenshot artifact, not a layout bug.

## Screenshots

- `screenshots/overview-1440-dark.png` (1440 x 1224)
- `screenshots/overview-1440-light.png` (1440 x 1224)
- `screenshots/overview-1024-dark.png` (1024 x 1954)
- `screenshots/overview-1024-light.png` (1024 x 1954)
- `screenshots/session-1440-dark.png` (1440 x 1247)
- `screenshots/session-1440-light.png` (1440 x 1247)
- `screenshots/session-1024-dark.png` (1024 x 2082)
- `screenshots/session-1024-light.png` (1024 x 2082)

## Console and network

- 8/8 runs (2 pages x 2 widths x 2 themes): one console warning, `cdn.tailwindcss.com should not be used in production`. No page errors, no failed requests, no HTTP errors.
- Fonts loaded: Inter 400/500/600, JetBrains Mono 400 (500 on session).
- **The styling depends on the Tailwind Play CDN at runtime.** With external requests blocked, `overview.html` renders unstyled (body font Times New Roman, page height 3518px instead of 1224px, links underlined, layout collapsed into one column).

## Overflow and layout at 1024 (and 1440)

- Horizontal overflow: none at 1440 or 1024 on either page, both themes (`scrollWidth` = viewport). No element past the right edge. No inner horizontal scroll needed.
- Session, waterfall header (both widths): the `end 12.4 s` label overlaps the `12 s` tick (renders as "end 1224 ss").
- Session, waterfall header at 1440: the `× 9.35 s` failure chip covers the `8 s` tick (only 6 s, 9.35 s, 10 s are readable). At 1024 the `8 s` tick is partly covered.
- Session, row 11: type `screenshot` (72px) spills out of its 62px (1440) / 52px (1024) column and runs into the target `full page` ("screenshotfull page").
- Session, CPU and Memory charts: the top y-axis labels `100%` and `80 MB` are clipped by 7px at the top of their SVG (`overflow: hidden`), both widths.
- Overview, Sessions KPI card: the `741 real · 1,185 sim` line has `-mt-1`; its line box overlaps the split bar by 4px and the bar touches the tops of the glyphs.
- Overview at 1440: the static tooltip covers the `alert at 10%` label of the error-rate chart (only "ale" visible). At 1024 it does not.
- Overview at 1440: legends of "Error rate by engine" and "Actions per minute" wrap to two lines; `chrome-headless-shell` wraps to two lines in the engines table.

## Token contrast (claimed in system.md vs computed)

All 25 claimed pairs are within 0.2 of the computed value and all pass their AA target. Lowest margins: `fg-subtle` on `surface-2` light 4.67, `fg-subtle` on `bg` light 4.80, `line-strong` on `surface` dark 3.28, `line-strong` on `bg` light 3.33.

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
| focus ring (fg) vs surface | 3:1 | 15.1 | 15.13 | 18 | 18.01 | ok |
| `ok-fg` on `ok-bg` | 4.5:1 | 8.7 | 8.65 | 5.8 | 5.76 | ok |
| `warn-fg` on `warn-bg` | 4.5:1 | 9.1 | 9.09 | 5.3 | 5.28 | ok |
| `err-fg` on `err-bg` | 4.5:1 | 6.5 | 6.46 | 5.4 | 5.44 | ok |
| `blk-fg` on `blk-bg` | 4.5:1 | 7.1 | 7.09 | 5.9 | 5.89 | ok |
| `ok-fg` on `surface` | 4.5:1 | 9.9 | 9.87 | 6.6 | 6.61 | ok |
| `warn-fg` on `surface` | 4.5:1 | 10.6 | 10.64 | 5.9 | 5.93 | ok |
| `err-fg` on `surface` | 4.5:1 | 7.1 | 7.12 | 6.6 | 6.57 | ok |
| `blk-fg` on `surface` | 4.5:1 | 7.8 | 7.83 | 7.1 | 7.11 | ok |
| `chromium` on `surface` | 3:1 | 7.7 | 7.74 | 5.2 | 5.19 | ok |
| `headless` on `surface` | 3:1 | 7.9 | 7.93 | 4 | 3.99 | ok |
| `lightpanda` on `surface` | 3:1 | 5.8 | 5.83 | 5.3 | 5.25 | ok |
| `bar` on `surface` | 3:1 | 3.7 | 3.70 | 4 | 3.95 | ok |

## Rendered text contrast (mockups)

**dark**: 837 visible text nodes over both pages and widths, 35 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| session | "1,926" (`span.hidden.xl:inline`) | 12px/600 | `#7D8DA1` on `#17212C` | 4.80 | 4.5 | pass |
| overview | "1,926" (`span.hidden.xl:inline`) | 12px/400 | `#7D8DA1` on `#111821` | 5.27 | 4.5 | pass |
| overview | "Updated 1 s ago · stream con" (`p.text-label.text-subtle`) | 12px/400 | `#7D8DA1` on `#0B0F14` | 5.67 | 4.5 | pass |
| overview | "Success rate is 91.6% (targe" (`p.text-body.text-muted`) | 13px/400 | `#9AA9BB` on `#2E2410` | 6.37 | 4.5 | pass |
| overview | "Capacity" (`dt.text-muted`) | 12px/400 | `#9AA9BB` on `#2E2410` | 6.37 | 4.5 | pass |

**light**: 837 visible text nodes over both pages and widths, 35 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| session | "1,926" (`span.hidden.xl:inline`) | 12px/600 | `#5F6E82` on `#F0F3F7` | 4.67 | 4.5 | pass |
| overview | "Updated 1 s ago · stream con" (`p.text-label.text-subtle`) | 12px/400 | `#5F6E82` on `#F4F6F9` | 4.80 | 4.5 | pass |
| overview | "1,926" (`span.hidden.xl:inline`) | 12px/400 | `#5F6E82` on `#FFFFFF` | 5.20 | 4.5 | pass |
| overview | "5" (`span.hidden.xl:inline`) | 12px/500 | `#8A5A00` on `#FDF1D3` | 5.28 | 4.5 | pass |
| session | "2.45 s · failed" (`span.dur.err`) | 12px/600 | `#B42318` on `#FDE4E1` | 5.44 | 4.5 | pass |

No rendered text below AA in either theme. The lowest is `fg-subtle` on `surface-2` (Sessions count in the active nav item): 4.80 dark, 4.67 light.

## Engine colours under colour-vision deficiency (CIEDE2000)

**dark** (engines: chromium #56B4E9, headless #E69F00, lightpanda #CC79A7; status: ok-fg #4BD98E, warn-fg #F2C14E, err-fg #FF7B7B, blk-fg #B79CFF)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 53.6 | 50.6 | 54.3 | 53.5 |
| chromium vs lightpanda | 45.5 | 14.1 | 15.5 | 65.3 |
| headless vs lightpanda | 49.0 | 43.4 | 36.7 | 11.1 |
| chromium vs ok-fg | 40.6 | 41.7 | 39.1 | **8.6** |
| chromium vs warn-fg | 52.6 | 49.7 | 53.2 | 47.6 |
| chromium vs err-fg | 50.6 | 33.3 | 42.5 | 74.0 |
| chromium vs blk-fg | 24.7 | **5.7** | **3.1** | 25.3 |
| headless vs ok-fg | 42.2 | 15.0 | 16.6 | 58.9 |
| headless vs warn-fg | **9.5** | **8.4** | **7.1** | **8.7** |
| headless vs err-fg | 35.3 | 19.9 | 13.3 | **8.7** |
| headless vs blk-fg | 56.7 | 56.0 | 56.9 | 27.8 |
| lightpanda vs ok-fg | 69.6 | 38.6 | 24.5 | 61.2 |
| lightpanda vs warn-fg | 51.2 | 44.8 | 37.0 | 16.4 |
| lightpanda vs err-fg | 18.9 | 25.4 | 26.5 | **8.3** |
| lightpanda vs blk-fg | 20.3 | 15.8 | 18.1 | 26.1 |

**light** (engines: chromium #0072B2, headless #B86E00, lightpanda #B0457F; status: ok-fg #0B6B39, warn-fg #8A5A00, err-fg #B42318, blk-fg #5B3FC4)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 48.7 | 50.2 | 55.5 | 49.0 |
| chromium vs lightpanda | 41.7 | 11.0 | 18.6 | 59.1 |
| headless vs lightpanda | 44.4 | 42.7 | 32.5 | **9.6** |
| chromium vs ok-fg | 41.2 | 41.6 | 39.2 | 11.8 |
| chromium vs warn-fg | 46.5 | 49.0 | 51.7 | 44.7 |
| chromium vs err-fg | 48.1 | 46.1 | 50.9 | 54.4 |
| chromium vs blk-fg | 23.0 | **9.5** | **6.6** | 16.4 |
| headless vs ok-fg | 43.1 | 12.7 | 22.8 | 52.7 |
| headless vs warn-fg | 12.0 | **9.5** | 11.9 | 11.9 |
| headless vs err-fg | 26.0 | 18.0 | 12.4 | 14.0 |
| headless vs blk-fg | 57.5 | 59.9 | 64.0 | 44.2 |
| lightpanda vs ok-fg | 66.1 | 33.2 | 21.1 | 55.5 |
| lightpanda vs warn-fg | 44.2 | 40.0 | 29.9 | **9.7** |
| lightpanda vs err-fg | 26.5 | 36.3 | 29.4 | 13.4 |
| lightpanda vs blk-fg | 24.0 | 12.2 | 23.1 | 43.7 |

Flagged (ΔE < 10):

- dark: chromium #56B4E9 vs ok-fg #4BD98E: tritanopia 8.6
- dark: chromium #56B4E9 vs blk-fg #B79CFF: protanopia 5.7, deuteranopia 3.1
- dark: headless #E69F00 vs warn-fg #F2C14E: normal 9.5, protanopia 8.4, deuteranopia 7.1, tritanopia 8.7
- dark: headless #E69F00 vs err-fg #FF7B7B: tritanopia 8.7
- dark: lightpanda #CC79A7 vs err-fg #FF7B7B: tritanopia 8.3
- light: headless #B86E00 vs lightpanda #B0457F: tritanopia 9.6
- light: chromium #0072B2 vs blk-fg #5B3FC4: protanopia 9.5, deuteranopia 6.6
- light: headless #B86E00 vs warn-fg #8A5A00: protanopia 9.5
- light: lightpanda #B0457F vs warn-fg #8A5A00: tritanopia 9.7
