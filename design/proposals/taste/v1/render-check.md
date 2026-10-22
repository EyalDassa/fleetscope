# Render check: taste v1

Objective checks only (rendering, layout, contrast, colour-vision simulation). No style opinions.

## Method

- Playwright 1.49.1, headless Chromium 131, deviceScaleFactor 1, viewport height 900, full-page screenshots. Waited for `networkidle`, `document.fonts.ready` and 800 ms.
- Theme: forced with `?theme=dark|light`.
- Overflow: `documentElement.scrollWidth > innerWidth`, plus elements whose right edge is past the viewport. Spill/clip: text-bearing elements with `scrollWidth > clientWidth`. Overlap: client rects of text nodes from different elements intersecting by more than 15% of the smaller box (hidden `<details>`/`<dialog>` content excluded). SVG `<text>` clipped by an `overflow:hidden` SVG.
- Rendered contrast: every visible text node, computed `color` (SVG: `fill`) with ancestor opacity, against the alpha-composited ancestor background. Large text = 24px, or 18.66px bold.
- Token contrast: WCAG 2.x relative luminance from the hex values in `system.md`. Flag = claimed value off by more than 0.2, or below 4.5:1 (text) / 3:1 (non-text).
- CVD: Machado et al. 2009 matrices at severity 1.0, applied in linear sRGB; ΔE = CIEDE2000 (culori 4.0.1). Flag = ΔE < 10 (bold).
- Note: both sidebars are `position: sticky; height: 100vh`, so in the full-page screenshots the sidebar background stops at y = 900. That is a screenshot artifact, not a layout bug.

## Screenshots

- `screenshots/overview-1440-dark.png` (1440 x 1083)
- `screenshots/overview-1440-light.png` (1440 x 1083)
- `screenshots/overview-1024-dark.png` (1024 x 1506)
- `screenshots/overview-1024-light.png` (1024 x 1506)
- `screenshots/session-1440-dark.png` (1440 x 1093)
- `screenshots/session-1440-light.png` (1440 x 1093)
- `screenshots/session-1024-dark.png` (1024 x 1558)
- `screenshots/session-1024-light.png` (1024 x 1558)

## Console and network

- 8/8 runs (2 pages x 2 widths x 2 themes): no console errors or warnings, no page errors, no failed requests.
- Fonts loaded: IBM Plex Sans 400/500/600, IBM Plex Mono 400/500.
- CSS is inline. With external requests blocked, `overview.html` keeps its layout (height 1100px vs 1083px) and falls back to system fonts.

## Overflow and layout at 1024 (and 1440)

- Horizontal overflow: none at 1440 or 1024 on either page, both themes. No element past the right edge.
- Session, row 11 (both widths): type `screenshot` (72px) spills out of its 66px column and runs into the target `full page` ("screenshotfull page").
- No overlapping text found on either page (one candidate was the closed engine-filter `<details>` menu, a false positive). No clipped SVG labels.
- Visually hidden `.sr` spans ("(worse)", "slow, p95 1,900 ms", "failed") report as clipped. That is intended.

## Token contrast (claimed in system.md vs computed)

All 26 claimed pairs are within 0.2 of the computed value and all pass their AA target. Lowest margins: `faint` on `active` light 4.63, `faint` on `raised` light 4.88, `failed` on `failed-bg` light 4.96, `control` on `surface` dark 3.14, `lightpanda` on `surface` light 3.34.

| Pair | Need | Dark claimed | Dark actual | Light claimed | Light actual | Result |
|---|---|---|---|---|---|---|
| `text` on `ground` | 4.5:1 | 17.6 | 17.59 | 17.3 | 17.31 | ok |
| `text` on `surface` | 4.5:1 | 16.7 | 16.72 | 18.9 | 18.86 | ok |
| `text` on `raised` | 4.5:1 | 15.5 | 15.52 | 16.4 | 16.42 | ok |
| `text` on `active` | 4.5:1 | 14.9 | 14.85 | 15.6 | 15.57 | ok |
| `muted` on `ground` | 4.5:1 | 9.1 | 9.12 | 6.8 | 6.79 | ok |
| `muted` on `surface` | 4.5:1 | 8.7 | 8.67 | 7.4 | 7.39 | ok |
| `muted` on `raised` | 4.5:1 | 8 | 8.05 | 6.4 | 6.44 | ok |
| `muted` on `active` | 4.5:1 | 7.7 | 7.70 | 6.1 | 6.10 | ok |
| `faint` on `ground` | 4.5:1 | 6 | 6.05 | 5.1 | 5.14 | ok |
| `faint` on `surface` | 4.5:1 | 5.7 | 5.75 | 5.6 | 5.61 | ok |
| `faint` on `raised` | 4.5:1 | 5.3 | 5.34 | 4.9 | 4.88 | ok |
| `faint` on `active` | 4.5:1 | 5.1 | 5.11 | 4.6 | 4.63 | ok |
| primary button label on text fill | 4.5:1 | 17.6 | 17.59 | 18.9 | 18.86 | ok |
| `control` on `surface` | 3:1 | 3.1 | 3.14 | 3.4 | 3.43 | ok |
| focus ring (text) vs surface | 3:1 | 16.7 | 16.72 | 18.9 | 18.86 | ok |
| `healthy` on `surface` | 4.5:1 | 8.1 | 8.05 | 6.8 | 6.80 | ok |
| `healthy` on `healthy-bg` | 4.5:1 | 6.7 | 6.71 | 5.8 | 5.84 | ok |
| `degraded` on `surface` | 4.5:1 | 9.1 | 9.06 | 5.9 | 5.93 | ok |
| `degraded` on `degraded-bg` | 4.5:1 | 7.7 | 7.66 | 5.2 | 5.23 | ok |
| `failed` on `surface` | 4.5:1 | 6.2 | 6.21 | 6 | 5.98 | ok |
| `failed` on `failed-bg` | 4.5:1 | 5.5 | 5.53 | 5 | 4.96 | ok |
| `blocked` on `surface` | 4.5:1 | 7.7 | 7.74 | 10.8 | 10.77 | ok |
| `on-failed` on `failed` | 4.5:1 | 6.5 | 6.53 | 6 | 5.98 | ok |
| `chromium` on `surface` | 3:1 | 6.4 | 6.36 | 6.3 | 6.29 | ok |
| `headless` on `surface` | 3:1 | 7.4 | 7.38 | 5.1 | 5.07 | ok |
| `lightpanda` on `surface` | 3:1 | 11.1 | 11.08 | 3.3 | 3.34 | ok |

## Rendered text contrast (mockups)

**dark**: 832 visible text nodes over both pages and widths, 47 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| overview | "Failed" (`span.badge.b-failed`) | 12px/500 | `#F4694B` on `#2D1912` | 5.53 | 4.5 | pass |
| session | "Failed" (`span.badge.lg`) | 13px/500 | `#F4694B` on `#2D1912` | 5.53 | 4.5 | pass |
| overview | "Search sessions, pages, view" (`span`) | 13px/400 | `#8E8E95` on `#121214` | 5.75 | 4.5 | pass |
| overview | "0%" (`text.ax`) | 11px/400 | `#8E8E95` on `#121214` | 5.75 | 4.5 | pass |
| session | "1" (`span.seq`) | 12px/400 | `#8E8E95` on `#121214` | 5.75 | 4.5 | pass |

**light**: 832 visible text nodes over both pages and widths, 47 unique colour/background/size combinations, 1 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| session | "v0.2.9" (`span.eng.e-lightpanda`) | 12px/400 | `#139AB2` on `#F5F5F6` | 3.06 | 4.5 | **FAIL** |
| overview | "Failed" (`span.badge.b-failed`) | 12px/500 | `#B8321A` on `#FCE5DF` | 4.96 | 4.5 | pass |
| session | "Failed" (`span.badge.lg`) | 13px/500 | `#B8321A` on `#FCE5DF` | 4.96 | 4.5 | pass |
| session | "Saved views" (`div.grp`) | 12px/400 | `#67676F` on `#F5F5F6` | 5.14 | 4.5 | pass |
| overview | "Degraded" (`span`) | 28px/600 | `#8A5A00` on `#FBF0D6` | 5.23 | 3 | pass |

**One AA failure:** session page header, light theme, `v0.2.9` (`span.eng.e-lightpanda`, 12px/400) is drawn in the Lightpanda engine colour `#139AB2` on `#F5F5F6` = 3.06:1 (needs 4.5:1). system.md 2.3 says engine colour is never used as label colour. In dark it is `#6FD6E6` on `#0B0B0C` and passes.

## Engine colours under colour-vision deficiency (CIEDE2000)

**dark** (engines: chromium #4C9BE6, headless #D98AB8, lightpanda #6FD6E6; status: healthy #3FC07A, degraded #E8A93A, failed #F4694B, blocked #A6A6AE)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 37.4 | 10.0 | 18.9 | 60.8 |
| chromium vs lightpanda | 23.1 | 18.2 | 17.6 | 13.2 |
| headless vs lightpanda | 48.8 | 14.5 | 10.2 | 67.8 |
| chromium vs healthy | 44.4 | 45.1 | 41.9 | 10.0 |
| chromium vs degraded | 50.9 | 53.7 | 57.4 | 49.8 |
| chromium vs failed | 47.1 | 46.3 | 52.5 | 73.9 |
| chromium vs blocked | 23.1 | 18.2 | 21.2 | 22.4 |
| headless vs healthy | 65.9 | 34.7 | 22.9 | 56.8 |
| headless vs degraded | 46.4 | 42.4 | 35.6 | **8.9** |
| headless vs failed | 27.5 | 35.6 | 32.1 | 14.1 |
| headless vs blocked | 21.5 | **10.0** | **3.1** | 21.8 |
| lightpanda vs healthy | 28.3 | 32.1 | 31.7 | **9.4** |
| lightpanda vs degraded | 43.1 | 40.0 | 43.7 | 54.7 |
| lightpanda vs failed | 51.4 | 38.8 | 41.4 | 67.9 |
| lightpanda vs blocked | 25.6 | 12.6 | 12.7 | 25.4 |

**light** (engines: chromium #1A5FB4, headless #B8408A, lightpanda #139AB2; status: healthy #17683F, degraded #8A5A00, failed #B8321A, blocked #3D3D44)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 34.2 | **7.9** | 19.7 | 57.2 |
| chromium vs lightpanda | 27.4 | 21.0 | 19.3 | 17.8 |
| headless vs lightpanda | 54.6 | 20.8 | 10.6 | 66.6 |
| chromium vs healthy | 41.6 | 41.6 | 38.1 | 10.9 |
| chromium vs degraded | 49.5 | 51.8 | 54.9 | 51.0 |
| chromium vs failed | 44.9 | 48.3 | 54.7 | 63.1 |
| chromium vs blocked | 25.2 | 24.0 | 23.3 | 24.1 |
| headless vs healthy | 66.4 | 33.9 | 23.0 | 56.6 |
| headless vs degraded | 47.1 | 43.2 | 34.2 | 11.2 |
| headless vs failed | 29.7 | 39.9 | 33.7 | 11.6 |
| headless vs blocked | 29.8 | 18.1 | 20.8 | 30.2 |
| lightpanda vs healthy | 32.8 | 36.0 | 34.2 | 22.4 |
| lightpanda vs degraded | 45.7 | 43.9 | 45.3 | 51.4 |
| lightpanda vs failed | 62.8 | 43.9 | 44.5 | 62.9 |
| lightpanda vs blocked | 38.3 | 34.3 | 29.8 | 38.9 |

Flagged (ΔE < 10):

- dark: headless #D98AB8 vs degraded #E8A93A: tritanopia 8.9
- dark: headless #D98AB8 vs blocked #A6A6AE: protanopia 10.0, deuteranopia 3.1
- dark: lightpanda #6FD6E6 vs healthy #3FC07A: tritanopia 9.4
- light: chromium #1A5FB4 vs headless #B8408A: protanopia 7.9

Borderline (displayed 10.0, not flagged): dark Chromium vs headless-shell under protanopia, dark Chromium vs healthy under tritanopia.
