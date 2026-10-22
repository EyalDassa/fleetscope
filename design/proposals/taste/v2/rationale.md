# Rationale (Taste, v2)

**Dials unchanged: VISUAL_DENSITY 8, DESIGN_VARIANCE 4, MOTION_INTENSITY 2.** A long-session monitoring tool: dense, conventional, hover feedback only.

**Answer first.** Overview opens with "Degraded" at 28px, the one finding (Lightpanda errors after the v0.2.9 rollout), a four-state bar and one button, "Review 114 failures". Breaching KPIs carry a 2px red rule.

**Colour is data or status.** Chrome is grey. Engines are separated by hue, lightness, marker shape and line dash (v2 rebuilt the palette as a lightness ladder after colour-vision checks). Statuses are green, amber and vermillion with icons and labels. **Blocked is deliberately hue-less**: outlined, `ban` icon, hatched wherever it is a fill.

**Real vs sim is inside every chart**: a per-minute strip, solid for real and hatched for sim, plus chips on rows and a mix line in the title.

**Engine colour is never text.** This fixes v1's AA failure.

**Drill-down is visible at rest.** KPI cells show an arrow; every row, count and point opens its sessions.

**Session story on one time axis.** Waterfall, CPU and memory share an x scale; the failing span is shaded through all rows; slow actions are amber, the failed one vermillion; unsupported JS heap is a "Not available" frame.

**Scope trimmed to PLAN.md section 7**: no workspace switcher, user row or settings.

## Open questions for Eyal
1. Fleet and engine status thresholds: I assumed 95 and 90 percent success. Which?
2. Does `blocked` count as a failure in the success rate? Mockups count it as not successful.
3. Default source filter: All with a visible mix, or Real only?
4. Is a hue-less blocked state acceptable, or should it be louder?
