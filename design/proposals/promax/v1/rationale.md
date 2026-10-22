# Rationale, promax v1

**Verdict before data.** Overview opens with a banner: "Fleet degraded", one sentence of cause, capacity, and a button to the failures. That is the 5-second answer; the KPI cards and charts are the evidence beneath it.

**Neutral chrome, colour only for meaning.** Buttons, selection and focus are greys (the primary button is near-white on dark). Hue is spent only on status and engine, so every coloured pixel is data. Dark is default; light has its own darkened status colours so badge text stays above 5:1.

**Redundant encoding everywhere.** Status is icon plus word plus colour. Engines are an Okabe-Ito colour plus a shape (circle, square, diamond) plus a line style (solid, dashed, dotted). Real is a solid outline; Sim is a dashed, hatched chip. A colour-blind engineer loses nothing.

**Blocked is violet, not red.** "A site said no" and "our fleet broke" need different reactions, so they get different hues and icons.

**Every number is a link.** KPI cards are whole-card links with a visible arrow; chart tooltips end in "N failed sessions, Open"; table rows are links. This serves the "3 clicks to why" metric.

**One time axis on Session detail.** Waterfall, CPU and memory share one grid and one hover cursor, with a dashed line at the moment of failure. A root-cause banner sits above the timeline, so the answer ("unsupported_api, IntersectionObserver, Chromium succeeds 38/38") is visible before any scrolling.

**Honest gaps.** JS heap on Lightpanda is a labelled hatched placeholder, never a zero.

**Buildable.** shadcn Card, Table, Tabs, Badge (cva variants) and Recharts for the three Overview charts and two resource charts; the waterfall is plain percentage-positioned divs, which is simpler than bending Recharts into a Gantt. Dense 13px type, 40px rows, 56px icon rail at 1024.
