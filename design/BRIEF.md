# Design brief: Fleetscope dashboard

Both designers get this same brief. Read PLAN.md sections 1 and 7 first.

## Product in one line
A monitoring dashboard for fleets of AI-agent browsers (Chromium, chrome-headless-shell, Lightpanda): health, latency, resource use, cost and failures, from fleet level down to a single session.

## Users
- **DevOps / platform engineers:** glance at fleet health, capacity and cost; react to spikes.
- **Agent developers:** dig into one session to find why it failed or ran slowly.
- **AI agents:** use the API/MCP, not the UI, but the UI should use the same names and numbers they get.

## What the design must achieve
1. **Answer at a glance:** someone opening Overview should know in under 5 seconds whether the fleet is healthy.
2. **High information density without clutter:** this is a monitoring tool, not a marketing site.
3. **Obvious drill-down:** every number and chart point leads to the sessions behind it.
4. **Status colors with meaning:** healthy, degraded, failed and blocked must be distinguishable without relying on color alone (icons and labels too).
5. **Both themes:** dark mode is the default (engineers watch these screens for hours), light mode must also work. Text must meet WCAG AA contrast.
6. **Three engines must be easy to tell apart** in every chart (one consistent color each), and real vs simulated data must be visibly labeled.

## Constraints (so the design can be built by Saturday)
- Built with Next.js, Tailwind, shadcn/ui and Recharts. Don't design anything those can't do in a few hours.
- Layout: left sidebar, top bar with time range, engine filter, source filter and ⌘K search.
- Desktop first (1440px wide); must not break at 1024px.

## Deliverables from each designer (in `design/proposals/<designer>/v<N>/`, one folder per round)
1. `system.md`: design tokens (colors for both themes, status colors, engine colors, type scale, spacing, radius), component rules (KPI card, chart card, table row, status badge, timeline bar) and 3–5 principles.
2. `overview.html`: a static mockup of the Overview screen with realistic fake data.
3. `session.html`: a static mockup of Session detail (action waterfall + CPU/memory chart on the same time axis + issues).
4. `rationale.md`: the key choices and why, in under 300 words.

Mockups are single self-contained HTML files (Tailwind via CDN is fine) so they can be opened in a browser and compared side by side.
