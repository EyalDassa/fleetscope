# ADR 0003: Grafana instead of a custom dashboard

- Status: accepted (2026-10-24, decided by Eyal at the start of M2)
- Replaces: the `apps/web` Next.js dashboard from PLAN.md section 7 and the shadcn/Recharts parts of `design/DESIGN.md`

## Context

M0 shipped an empty Next.js dashboard on Vercel and a design system for a custom UI. M1 landed real fleet data in ClickHouse. Before building any screens, Eyal chose to use **Grafana** as the product's UI instead of writing our own.

What the UI has to do:
- show fleet health at a glance and drill down to one session (PLAN section 1);
- show a session's actions next to its CPU and memory on one time axis;
- explain why a session failed;
- run for $0 for the demo.

## Options considered

1. **Custom Next.js dashboard (the original plan).** It gives full control over look and interactions (KPI cards, ⌘K, a custom waterfall, PostHog analytics). It is also the most code to write, test and host, and it re-implements what monitoring tools already do: time picker, variables, refresh, sharing links.
2. **Grafana reading through our API** (Infinity/JSON data source). All queries stay in `packages/db`, but it's slower to build, Grafana's native features (time macros, variables) work less well, and the API must be publicly hosted.
3. **Grafana reading ClickHouse directly** (official ClickHouse data source by Grafana Labs). It's fast to build, standard for observability products, and uses Grafana's time picker, variables, data links and auto-refresh natively. The dashboard SQL lives in dashboard JSON instead of `packages/db`.

Hosting:
- **Grafana Cloud free tier:** $0, no card, 3 active users.
- **Self-hosted Grafana OSS:** the software is free, but always-on hosting is not.
- **ClickHouse:** has no free hosted tier. ClickHouse Cloud has a 30-day trial ($300 credit, no card). Grafana Cloud needs a ClickHouse it can reach over the internet.

## Decision

- **Grafana is the only UI.** `apps/web` and the Vercel project are removed.
- **Grafana queries ClickHouse directly**, as a **read-only user** (`readonly`, `SELECT` only), through the data source with UID `fleetscope-clickhouse`.
- **Dashboards are code:** JSON in `infra/grafana/dashboards/`. The local Grafana OSS container (docker-compose, `localhost:3001`) provisions them, and `pnpm grafana:push` uploads them to Grafana Cloud by UID.
- **Rules for dashboard SQL** (an exception to "all queries live in `packages/db`"):
  - it follows the rules written in `packages/db/README.md`: `sessions FINAL`, interrupted sessions excluded from success and failure numbers, the `fleet_minute` rollup for time series;
  - it's bounded by the time range or a LIMIT;
  - a CI step executes every panel's query against seeded data.
- **Production:** Grafana Cloud free tier plus the ClickHouse Cloud trial. The trial's end date is recorded, and the service is deleted before it ends.
- **Session timeline:** **Perfetto** (ui.perfetto.dev). The API serves a session as a Chrome trace (`GET /v1/sessions/:id/trace`), and a small API page hands it to Perfetto with `postMessage`. Perfetto shows action slices with CPU, memory and JS-heap counters on one time axis, entirely in the browser. Grafana has no native Gantt chart, and Perfetto is the tool browser engineers already use.
- **"Explain this session"** uses **Grafana Assistant** (Grafana Cloud's AI; free tier allows 3 AI users) instead of our own Claude Haiku endpoint. What the MCP tool `explain_session` returns is decided in M5.
- **Dropped:** ⌘K palette, SSE live updates (Grafana auto-refresh replaces them), and PostHog product analytics.

## Consequences

- **Much less UI code**, and the product looks and works like the monitoring tools its users already know.
- **Two places hold SQL:** `packages/db` (API and MCP) and the dashboard JSON. The written query rules and the CI query check keep them consistent; a schema change has to update both.
- **Less control over the UI:** no custom KPI cards or animations, and Grafana's own theme. DESIGN.md now specifies what Grafana can express: colours, units, thresholds, panel order and drill-down links.
- **The timeline lives outside Grafana:** it opens in a new tab, and the viewer's browser must reach our API. For the demo, the API runs on the presenter's laptop.
- **Grafana Assistant is a Grafana Cloud feature:** it isn't in the repo, its answers aren't under our control, and the local Grafana doesn't have it.
- **Cost:** $0 during the trial. After 30 days ClickHouse Cloud would bill, so the service must be deleted (or replaced) before then.
- **Records kept:** the M0 design sprint for the custom UI stays as history (`design/proposals`, `DECISIONS.md`). Its colour and layout decisions carry over into the Grafana spec.
