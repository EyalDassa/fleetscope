# Rationale, promax v2

**Verdict before data.** Overview opens with a 28px "Degraded", one sentence of cause, a four-state distribution bar (healthy, degraded, failed, blocked) and one button to the failures. The 7-cell KPI strip and charts are the evidence.

**Neutral chrome, colour only for meaning.** Buttons and selection are grey; hue is spent on status and engine. Dark is default; light has its own re-derived colours.

**Redundant encoding.** Status is icon, word and colour. Engines are an Okabe-Ito colour plus a shape (circle, square, diamond) and a line style (solid, dashed, dotted). Real is a solid outline, Sim a dashed hatched chip, and charts show the share in a source strip.

**Blocked keeps a hue.** "The site said no" must read as its own state at a glance, and grey already means running or disabled. The v1 problem was lightness, not hue, so v2 moves blocked, degraded and healthy in lightness away from the engine colours. Three tritanopia-only pairs stay under ΔE 10; shapes and icons cover them.

**Every number is a door.** KPI cells carry a visible `↗`, chart tooltips end in a link, rows are links.

**Charts answer the question.** Error rate gets the widest card with a spike annotation; Active sessions are columns against a capacity line; one shared legend toggles engines everywhere.

**Session: one axis, no collisions.** The waterfall, CPU and memory share one grid and one hover cursor, with a shaded failing span, a two-row axis header and a root-cause banner above the timeline.

**Buildable.** shadcn Card, Table, Tabs, Badge (cva); Recharts for the five charts; the waterfall is percentage-positioned divs. The mockups use inline CSS and render offline.
