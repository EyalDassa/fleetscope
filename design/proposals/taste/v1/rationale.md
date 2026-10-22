# Rationale (Taste, v1)

**Dials, unchanged: VISUAL_DENSITY 8, DESIGN_VARIANCE 4, MOTION_INTENSITY 2.** This is a screen engineers watch for hours: dense rows and 12px gutters, a conventional sidebar-plus-top-bar frame so nothing has to be learned, and no animation beyond 100ms hover feedback. Charts redraw in place.

**Answer first.** Overview opens with one tinted band: "Degraded" at 28px, the one finding (Lightpanda errors peaked at 21.4% after the v0.2.9 rollout), a four-state distribution bar, and the single filled button, "Review 114 failures". A person knows the fleet state in under 5 seconds; everything below is evidence.

**Colour is data or status, nothing else.** Chrome is neutral grey in both themes. The only hues are the three engines (blue circle, pink square, cyan diamond: different hue, lightness and shape) and four statuses (green, amber, vermillion, plus blocked as a neutral hatched outline). Each status carries an icon and a label.

**Honest data.** Real/sim chips differ by border style (solid or dashed) and by word; the title row always shows the mix. Lightpanda's missing JS heap is a dashed "Not available" frame, not a zero.

**KPIs are one divided strip**, no icons or sparklines. Deltas name their window, and colour means better or worse, not up or down.

**The Session page tells one story on one time axis**: the waterfall, CPU and memory share a single x scale, the failing span is shaded across all rows, and CPU dropping to 3% for 8 seconds shows the click was waiting on code that never ran.

**Buildable:** shadcn tokens map 1:1 (`system.md` section 6); charts are Recharts lines and stacked bars with custom markers; the waterfall is absolutely positioned divs.

**Caveats:** IBM Plex needs a tabular-figures check; contrast ratios were computed by hand; I had no browser to screenshot, so layouts were reasoned, not seen.
