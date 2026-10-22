# Render check: taste v2

Objective checks only. No style opinions.

## Method

Same scripts as v1 (`render.mjs` with `V=v2`, `tokens-v2.mjs`, `offline2.mjs`): Playwright 1.49.1, headless Chromium 131, viewport height 900, full-page screenshots after `networkidle` + `document.fonts.ready` + 800 ms. Theme forced with `?theme=dark|light` (both proposals now support it). Overlap, spill, clip and SVG-label-clip heuristics and the rendered-contrast sampler are unchanged from v1, except that text with `font-size: 0` is ignored. CVD: Machado 2009 (severity 1.0) in linear sRGB, CIEDE2000 via culori 4.0.1; flag = ΔE < 10. Expected-vs-actual verdicts: "about X" holds within ±2, a range holds inside the range, ">= X" holds at or above X; values above a claim are reported as "better than claimed". Full-page screenshots show the sticky 100vh sidebar ending at y = 900 (screenshot artifact, as in v1).

## Screenshots

- `screenshots/overview-1440-dark.png` (1440 x 1121)
- `screenshots/overview-1440-light.png` (1440 x 1121)
- `screenshots/overview-1024-dark.png` (1024 x 1592)
- `screenshots/overview-1024-light.png` (1024 x 1592)
- `screenshots/session-1440-dark.png` (1440 x 1234)
- `screenshots/session-1440-light.png` (1440 x 1234)
- `screenshots/session-1024-dark.png` (1024 x 1836)
- `screenshots/session-1024-light.png` (1024 x 1836)

## Console, network, offline

- 8/8 runs online: no console errors or warnings, no page errors, no failed requests. Fonts loaded: IBM Plex Sans 400/500/600, IBM Plex Mono 400/500.
- With every non-`file:` request blocked, all four page/width combinations render styled; only `fonts.googleapis.com` is blocked, text falls back to the system font, no horizontal overflow, no errors:

| Page | Width | Height online | Height offline | scrollWidth offline | Body font (CSS) | Blocked hosts | Errors |
|---|---|---|---|---|---|---|---|
| overview | 1440 | 1121 | 1140 | 1440 | IBM Plex Sans (not loaded, system fallback) | fonts.googleapis.com | none |
| overview | 1024 | 1592 | 1593 | 1024 | IBM Plex Sans (not loaded, system fallback) | fonts.googleapis.com | none |
| session | 1440 | 1234 | 1230 | 1440 | IBM Plex Sans (not loaded, system fallback) | fonts.googleapis.com | none |
| session | 1024 | 1836 | 1812 | 1024 | IBM Plex Sans (not loaded, system fallback) | fonts.googleapis.com | none |

## v1 → v2 comparison

| v1 problem | v2 status | Evidence |
|---|---|---|
| `v0.2.9` in Lightpanda colour, 3.06:1 (light, session header) | **Fixed** | No rendered text uses an engine colour; 0 text below AA. |
| Row 11 `screenshot` spills into `full page` | **Fixed** | No spill detected at either width. |
| CVD dark headless vs Blocked, deutan 3.1 (protan 10.0) | **Fixed** (deutan 14.0, protan 13.4) | |
| CVD dark headless vs Degraded, tritan 8.9 | **Fixed** (11.1) | |
| CVD dark Lightpanda vs Healthy, tritan 9.4 | **Fixed** (13.4) | |
| CVD light Chromium vs headless, protan 7.9 | **Fixed** (12.8) | Above 10; below the claimed ~15. |
| Borderline dark Chromium vs headless protan 10.0 / Chromium vs Healthy tritan 10.0 | **Fixed** (13.5 / 16.5) | Protan below the claimed >= 20. |
| Lowest non-text margin: Lightpanda light on surface 3.34 | **Lower** (3.10, still passes); on `raised` 2.70 fails 3:1, as the designer documented | |
| `.sr` spans reported as clipped | Still reported; intended visually hidden text (not a defect) | |
| — (new) | **CVD light headless-shell `#C8559C` vs Lightpanda `#17A0BA`, deuteranopia 8.7** (v1: 10.6) | The designer named this as the most likely miss. |

## New findings at 1024 / 1440

- Horizontal overflow: none on either page, either width, either theme. No text overlaps, spills or clipped SVG labels detected; card edges align on both pages at both widths.
- The sampler flagged "Saved views" at 1024 (4.38-4.63:1). It is a `font-size: 0` 1px separator at that width, not visible text (false positive, excluded below).
- Session: the dashed failure line runs through the JS heap "Not available" placeholder text (also true in v1). The "Resources, sampled every 2 s..." caption extends past the label column into the plot, and the plot's left gridline crosses "(origin: container)" at 1440.
- Session at 1024: the order is Issues, then engine table + Session details, then the action waterfall, which starts at y = 1101 (in v1 it started at about y = 860).

## Token contrast (claimed in system.md / changes.md vs computed)

All 29 claimed pairs are within 0.2 of the computed value. All pass except the one the designer documented as a known limit: **Lightpanda `#17A0BA` on `raised` `#EFEFF1` (hovered row, light) = 2.70:1, below 3:1** (claimed 2.7, so the claim is accurate). New values confirmed: Chromium 4.62 / 8.36, headless 7.38 / 4.01, Lightpanda 13.28 / 3.10 on surface; degraded dark 10.75 / 9.08; `on-degraded` 11.30 / 5.93; blocked outline dark 4.65.

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
| primary button label on `text` fill | 4.5:1 | 17.6 | 17.59 | 18.9 | 18.86 | ok |
| `control` on `surface` | 3:1 | 3.1 | 3.14 | 3.4 | 3.43 | ok |
| `healthy` on `surface` | 4.5:1 | 8.1 | 8.05 | 6.8 | 6.80 | ok |
| `healthy` on `healthy-bg` | 4.5:1 | 6.7 | 6.71 | 5.8 | 5.84 | ok |
| `degraded` on `surface` (v2 value) | 4.5:1 | 10.8 | 10.75 | 5.9 | 5.93 | ok |
| `degraded` on `degraded-bg` (v2 value) | 4.5:1 | 9.1 | 9.08 | 5.2 | 5.23 | ok |
| `failed` on `surface` | 4.5:1 | 6.2 | 6.21 | 6 | 5.98 | ok |
| `failed` on `failed-bg` | 4.5:1 | 5.5 | 5.53 | 5 | 4.96 | ok |
| `on-failed` on `failed` | 4.5:1 | 6.5 | 6.53 | 6 | 5.98 | ok |
| `on-degraded` on `degraded` (v2 value) | 4.5:1 | 11.3 | 11.30 | 5.9 | 5.93 | ok |
| `blocked` outline/icon vs `surface` (non-text) (v2 value) | 3:1 | 4.65 | 4.65 | 10.8 | 10.77 | ok |
| blocked badge label (`text`) on `surface` | 4.5:1 | 16.7 | 16.72 | 18.9 | 18.86 | ok |
| `chromium` on `surface` (v2 value) | 3:1 | 4.6 | 4.62 | 8.4 | 8.36 | ok |
| `headless` on `surface` (v2 value) | 3:1 | 7.4 | 7.38 | 4 | 4.01 | ok |
| `lightpanda` on `surface` (v2 value) | 3:1 | 13.3 | 13.28 | 3.1 | 3.10 | ok |
| `lightpanda` on `raised` (hovered row; claimed light only) (v2 value) | 3:1 | n/a | 12.33 | 2.7 | 2.70 | **light below 3:1** |
| Lightpanda version text (`muted`) on `surface` (v2 value) | 4.5:1 | 8.7 | 8.67 | 7.4 | 7.39 | ok |

Claimed CIE L* values (system.md 2.3) are all within 0.4 of the computed CIELAB values:

| Colour (theme) | Claimed L* | Actual L* (CIELAB D65) |
|---|---|---|
| chromium #3A7FD6 (dark) | 53 | 52.9 |
| headless #D98AB8 (dark) | 67 | 66.8 |
| lightpanda #96E6F3 (dark) | 87 | 86.8 |
| chromium #174C96 (light) | 33 | 33.0 |
| headless #C8559C (light) | 53 | 53.1 |
| lightpanda #17A0BA (light) | 61 | 60.7 |
| healthy #3FC07A (dark) | 70 | 69.6 |

## Rendered text contrast (mockups)

**dark**: 840 visible text nodes over both pages and widths, 36 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| overview | "Failed" (`span.badge.b-failed`) | 12px/500 | `#F4694B` on `#2D1912` | 5.53 | 4.5 | pass |
| session | "Failed" (`span.badge.lg`) | 13px/500 | `#F4694B` on `#2D1912` | 5.53 | 4.5 | pass |
| overview | "Search sessions, pages, view" (`span`) | 13px/400 | `#8E8E95` on `#121214` | 5.75 | 4.5 | pass |
| overview | "0%" (`text.ax`) | 12px/400 | `#8E8E95` on `#121214` | 5.75 | 4.5 | pass |
| session | "Saved views" (`div.grp`) | 12px/400 | `#8E8E95` on `#0B0B0C` | 6.05 | 4.5 | pass |

**light**: 840 visible text nodes over both pages and widths, 36 unique colour/background/size combinations, 0 below AA. Lowest five:

| Page | Text (element) | Size/weight | Colour on background | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| overview | "Failed" (`span.badge.b-failed`) | 12px/500 | `#B8321A` on `#FCE5DF` | 4.96 | 4.5 | pass |
| session | "Failed" (`span.badge.lg`) | 13px/500 | `#B8321A` on `#FCE5DF` | 4.96 | 4.5 | pass |
| session | "Saved views" (`div.grp`) | 12px/400 | `#67676F` on `#F5F5F6` | 5.14 | 4.5 | pass |
| overview | "Degraded" (`span`) | 28px/600 | `#8A5A00` on `#FBF0D6` | 5.23 | 3 | pass |
| overview | "Degraded" (`span.badge.b-degraded`) | 12px/500 | `#8A5A00` on `#FBF0D6` | 5.23 | 4.5 | pass |

0 rendered text below AA in either theme (after excluding the font-size-0 separator). No text is drawn in an engine colour. Matches the changes.md prediction.

## CVD: expected (system.md 2.4 / changes.md) vs actual

7/10 predictions held.

| Pair (theme) | Vision | Expected | Actual | Verdict |
|---|---|---|---|---|
| headless vs blocked (dark) | deutan | about 13 | 14.0 | held |
| headless vs blocked (dark) | protan | about 12 | 13.4 | held |
| headless vs degraded (dark) | tritan | about 12 | 11.1 | held |
| lightpanda vs healthy (dark) | tritan | about 12 | 13.4 | held |
| chromium vs headless (dark) | protan | >= 20 | 13.5 | **missed** |
| headless vs lightpanda (dark) | deutan | about 14 | 12.9 | held |
| chromium vs healthy (dark) | tritan | about 12 | 16.5 | better than claimed |
| chromium vs headless (light) | protan | about 15 | 12.8 | **missed** |
| headless vs lightpanda (light) | deutan | about 12 | 8.7 | **missed** (under 10) |
| headless vs degraded (light) | tritan | about 12 | 14.9 | better than claimed |

changes.md predicted "at most 1 or 2" flags. Measured: **one** pair under 10 (light headless-shell vs Lightpanda, deuteranopia 8.71), the pair the designer named as the most likely miss.

## CVD: full table (v2 palette)

**dark** (engines: chromium #3A7FD6, headless #D98AB8, lightpanda #96E6F3; status: healthy #3FC07A, degraded #F2BC48, failed #F4694B, blocked #7E7E86)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 35.0 | 13.5 | 24.5 | 57.4 |
| chromium vs lightpanda | 33.6 | 29.3 | 30.4 | 24.8 |
| headless vs lightpanda | 45.0 | 18.6 | 12.9 | 61.5 |
| chromium vs healthy | 48.1 | 48.7 | 45.4 | 16.5 |
| chromium vs degraded | 57.5 | 58.5 | 62.9 | 58.1 |
| chromium vs failed | 46.3 | 47.2 | 55.6 | 68.8 |
| chromium vs blocked | 22.8 | 19.6 | 21.3 | 20.9 |
| headless vs healthy | 65.9 | 34.7 | 22.9 | 56.8 |
| headless vs degraded | 49.1 | 43.3 | 36.3 | 11.1 |
| headless vs failed | 27.5 | 35.6 | 32.1 | 14.1 |
| headless vs blocked | 24.5 | 13.4 | 14.0 | 25.1 |
| lightpanda vs healthy | 29.0 | 31.7 | 31.3 | 13.4 |
| lightpanda vs degraded | 40.5 | 38.3 | 41.5 | 48.3 |
| lightpanda vs failed | 50.4 | 39.8 | 40.6 | 65.1 |
| lightpanda vs blocked | 34.0 | 27.9 | 26.5 | 34.6 |

**light** (engines: chromium #174C96, headless #C8559C, lightpanda #17A0BA; status: healthy #17683F, degraded #8A5A00, failed #B8321A, blocked #3D3D44)

| Pair | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| chromium vs headless | 35.9 | 12.8 | 27.4 | 54.3 |
| chromium vs lightpanda | 34.3 | 29.6 | 26.5 | 28.1 |
| headless vs lightpanda | 53.8 | 14.9 | **8.7** | 66.0 |
| chromium vs healthy | 40.7 | 40.2 | 37.3 | 10.3 |
| chromium vs degraded | 48.9 | 50.1 | 54.6 | 48.0 |
| chromium vs failed | 44.0 | 46.1 | 54.7 | 59.0 |
| chromium vs blocked | 21.2 | 19.6 | 20.0 | 18.9 |
| headless vs healthy | 66.8 | 34.4 | 27.5 | 57.1 |
| headless vs degraded | 47.9 | 43.6 | 36.6 | 14.9 |
| headless vs failed | 31.5 | 41.1 | 35.7 | 15.7 |
| headless vs blocked | 33.8 | 23.0 | 27.3 | 34.1 |
| lightpanda vs healthy | 34.7 | 37.7 | 36.0 | 24.6 |
| lightpanda vs degraded | 46.9 | 45.5 | 46.4 | 52.3 |
| lightpanda vs failed | 63.5 | 46.0 | 45.5 | 63.6 |
| lightpanda vs blocked | 40.4 | 37.1 | 32.3 | 41.0 |

Flagged (ΔE < 10):

- light: headless #C8559C vs lightpanda #17A0BA: deutan 8.71
