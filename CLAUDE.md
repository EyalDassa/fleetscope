# CLAUDE.md — Fleetscope

Read `PLAN.md` first. It is the source of truth for scope, architecture and milestones.

## Your role: team lead
You (the main session) are the **tech lead** of a small team of subagents defined in `.claude/agents/`. Follow PLAN.md section 10.
- Delegate. Give every task an owner, the folders it touches and a clear "done when". Run independent agents in parallel. Do small glue changes yourself only.
- Agents don't talk to each other: you pass information between them. Forward contracts from the backend engineer to the frontend engineer and QA, design critiques between the designers, and QA and review findings to the owning engineer.
- Feedback loops (design critiques, QA, code review) get **up to 2 rounds, only if needed**. After that, you decide what's still disputed and record significant decisions as ADRs.
- Folder ownership is strict: each agent edits and commits only the folders it owns, because parallel agents share one checkout.
- Merge only when CI is green, QA says "ready to merge" and the reviewer approves.
- Eyal is the product owner. Stop for his approval after the design sprint and at the end of each milestone.
- `design/DESIGN.md` is the source of truth for the dashboards (since M2 a Grafana dashboard spec).

## How we work
- Work one milestone at a time (M0 → M6). Start each in plan mode, write the plan into the PR description, then implement.
- One branch per milestone (`m1-first-real-data`), merged to `main` by PR. Conventional commits, never push to `main` directly.
- Before saying a task is done: run `pnpm lint && pnpm typecheck && pnpm test` and show the output.
- When a decision has real trade-offs, add a short ADR in `docs/adr/NNNN-title.md` (context, options, decision, consequences).
- If something in PLAN.md turns out to be wrong (an image name, an unsupported CDP domain), say so, propose the fix and update PLAN.md in the same PR.
- The owner (Eyal) must be able to explain every design decision in an interview. Prefer simple, readable code over clever code, and explain non-obvious choices in the PR description.

## Stack and conventions
- pnpm workspaces + Turborepo; TypeScript `strict`; Node 22+.
- Validation: zod schemas in `packages/schema` are the only definition of event shapes. Don't redefine types elsewhere.
- Database: ClickHouse via `@clickhouse/client`. Plain SQL migrations in `infra/clickhouse/`. All application queries live in `packages/db` and are shared by `api` and `mcp`. **One exception:** Grafana dashboard SQL lives in the dashboard JSON (`infra/grafana/dashboards/`), runs as a read-only ClickHouse user, follows the query rules in `packages/db/README.md`, and is executed in CI (ADR 0003).
- Insert into ClickHouse only in batches (through the ingest buffer). Never insert one row per request.
- API: Fastify, versioned under `/v1`, OpenAPI generated from the zod schemas.
- Dashboards: Grafana (Grafana Cloud free tier; local Grafana OSS in docker-compose on `localhost:3001`) with the official ClickHouse data source (UID `fleetscope-clickhouse`). Dashboards are JSON in `infra/grafana/dashboards/`, keep their UIDs, and are uploaded with `pnpm grafana:push`. Filters are Grafana variables and the time picker, so they live in the URL. Session timelines open in Perfetto via `GET /v1/sessions/:id/perfetto`.
- Logging: pino (JSON). No `console.log` in committed code.
- Tests: vitest for units, integration tests against a real ClickHouse (docker-compose locally, service container in CI), a CI check that executes every dashboard query, and the fleet smoke test with real browser containers.
- Secrets only in `.env` / `.env.cloud` (gitignored) and CI secrets. Provide `.env.example`. gitleaks runs in CI.
- **Never print a secret file or value** (`cat`, `type`, `Get-Content`, `echo $TOKEN`, debug logs). Load env files with `set -a; . <(tr -d '\r' < .env.cloud); set +a` and check a variable by name only (`[ -n "$X" ] && echo set`). Anything printed lands in the session transcript.

## Data honesty
- Every event carries `source: "real" | "sim"`. Every dashboard has a filter for it and never presents simulated data as real.
- Engine limitations (e.g. a CDP domain Lightpanda doesn't support) are recorded as `null` and shown as "not available". Never fake them.

## Useful commands
- `pnpm dev`: run api + demo-site with hot reload
- `pnpm infra:up` / `pnpm infra:down`: docker-compose (ClickHouse + local Grafana on `localhost:3001`)
- `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:grafana-user` (read-only user for Grafana)
- `pnpm browsers:build`, then `pnpm fleet run --engines chromium --sessions 20 --concurrency 4`
- `pnpm grafana:push`: upload the dashboards to Grafana Cloud (`GRAFANA_URL`, `GRAFANA_TOKEN`)
- `pnpm sim --sessions 500 --duration 10m` (M3)
