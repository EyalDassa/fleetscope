# Fleetscope — observability for AI browser fleets

> Working plan. Hand this file to Claude Code together with `CLAUDE.md`.
> Deadline: demo-ready by **Saturday night**. Interview Sunday 16:00 (IL).

## 1. Product

### Problem
Teams running AI agents on browser fleets (on Anchor, Browserbase, or their own infrastructure) have almost no visibility into what the browsers are doing. When an agent is slow, fails, gets blocked or burns money, they have to dig through logs one session at a time.

### Users and the questions they ask
| User | Question | Screen |
|---|---|---|
| DevOps / platform engineer | Is the fleet healthy right now? Are we near capacity? | Overview |
| DevOps / finance-minded lead | What is this costing, and where does it go? | Usage and cost |
| Agent developer | Why did this session fail or run slowly? | Session detail |
| Agent developer / DevOps | Which browser engine should we run, and for which sites? | Browsers |
| Everyone | What should we fix first? | Insights |
| **AI agents** | "Is my fleet healthy? Why did session X fail?", asked programmatically | MCP server + REST API |

### Product principles
1. **Overview first, then drill down.** Every number on a page links to the sessions behind it.
2. **Every view has a URL.** Filters and time range live in the URL, so any view can be shared as a link.
3. **Agents are first-class users.** Everything a human can see in the dashboard, an agent can query through MCP.
4. **Simulated data is always labeled.** Real and simulated sessions carry `source: "real" | "sim"`, and the UI can filter them.

### Success metrics (for the README's product section)
- Time to answer "why did session X fail" is under 30 seconds, in 3 clicks or fewer.
- The cheapest engine that can handle a given site is visible on one screen.
- Product analytics events (PostHog) show which screens get used.

## 2. Architecture

```
 ┌────────────── fleet-runner ──────────────┐        ┌──────── simulator ────────┐
 │ scenarios → browser pool (Docker)        │        │ synthetic sessions, same  │
 │  chromium │ headless-shell │ lightpanda  │        │ event schema, source=sim  │
 │ collector SDK (wraps Playwright)         │        └────────────┬──────────────┘
 │ container stats poller (Docker API)      │                     │
 └───────────────┬──────────────────────────┘                     │
                 │  POST /v1/events (batched JSON, zod-validated) │
                 ▼                                                ▼
           ┌──────────────────────── api (Fastify) ─────────────────────────┐
           │ ingest buffer → batch insert │ query layer │ SSE /v1/stream    │
           └──────────────┬───────────────────────────────┬─────────────────┘
                          ▼                               │
                    ClickHouse                            │
             raw tables + materialized                    │
             per-minute rollups                           │
                          ▲                               ▼
           ┌──────────────┴─────────┐          ┌────────────────────────┐
           │ mcp server (tools for  │          │ web (Next.js dashboard)│
           │ agents, same query     │          │ live via SSE           │
           │ layer)                 │          └────────────────────────┘
           └────────────────────────┘
```

### Monorepo layout (pnpm + Turborepo, TypeScript strict)
```
apps/
  web/            Next.js App Router, Tailwind, shadcn/ui, Recharts (dashboard)
  api/            Fastify: ingest, query endpoints, SSE stream
  fleet-runner/   runs real browser sessions against the demo site
  simulator/      generates realistic synthetic fleet traffic
  demo-site/      target site with controllable chaos (slow, flaky, blocked)
  mcp/            MCP server exposing fleet tools to AI agents
packages/
  schema/         zod event schemas + TS types (single source of truth, versioned)
  collector/      SDK: wraps Playwright Browser/Page, emits events, batches, retries
  db/             ClickHouse client, migrations, query functions (shared by api + mcp)
infra/
  docker-compose.yml   ClickHouse + browser containers for local dev
  clickhouse/          SQL migrations
docs/
  adr/            architecture decision records
```

## 3. Browser fleet

Each browser instance runs in **its own Docker container** and exposes a CDP or Playwright endpoint. The runner keeps a pool per engine and gives each container one active session at a time, so container CPU and memory can be attributed to that session.

| Engine | How it runs | Why include it |
|---|---|---|
| Chromium (Playwright) | Playwright browser-server container | Baseline that everything is compared to |
| chrome-headless-shell | `chromedp/headless-shell` image (CDP on 9222) | Google's lighter headless build |
| Lightpanda | Official Lightpanda Docker image (CDP) | Built from scratch for AI agents; very low memory; incomplete Web API coverage, so real compatibility failures will show up |

The fleet uses exactly these three engines. Don't add others.

Verify current image names, ports and Playwright compatibility in each project's README before wiring them in. Docker Desktop with WSL2 is required on Windows.

### Where the metrics come from (measured inside and outside)
- **Outside (works for every engine):** Docker Engine API stats per container: CPU %, memory, network rx/tx, sampled every 2s.
- **Inside (when supported):** CDP `Performance.getMetrics` (JS heap, layout and script time) and network events. Engines that don't support a domain report `null` and never crash the collector.
- **Client side (collector):** wall-clock latency for every action, browser startup and connect time, and navigation timing.

## 4. Scenarios (fleet-runner) and the demo site

**Demo site:** a small Next.js or Express app with realistic flows and chaos settings set by query parameters or an admin toggle:
- Log in → dashboard → search → open item → fill a form → submit
- A slow page (adjustable latency), a flaky element (sometimes missing), a heavy page (large DOM and many images)
- A "bot wall" page that returns 403 or a fake CAPTCHA at an adjustable rate
- A JS-heavy page that uses Web APIs some engines lack (this is how Lightpanda's compatibility gaps show up)

**Scenarios:** `login-and-search`, `checkout-form`, `heavy-page-crawl`, `long-idle-session` (a zombie browser that wastes money), `memory-hog` (a page that leaks memory). Each scenario is a typed function that uses the collector-wrapped page.

**Runner CLI:** `pnpm fleet run --engines chrome,lightpanda --sessions 40 --concurrency 8 --scenario mix`

## 5. Event schema (`packages/schema`, version 1)

All events share: `v`, `type` (the event name below, used as the discriminator), `event_id` (uuid, used to drop duplicates), `ts` (ms), `session_id`, `source` ("real"|"sim"), `agent_id`, `engine` (`chromium`/`chrome-headless-shell`/`lightpanda`), `provider`.

| Event | Extra fields |
|---|---|
| `session.started` | engine_version, scenario, region, startup_ms, connect_ms |
| `session.ended` | status (`success`/`failed`/`blocked`/`timeout`/`crashed`), reason, duration_ms |
| `action` | seq, action_type (`goto`/`click`/`fill`/`extract`/`screenshot`/`wait`/`eval`), target (selector or domain), duration_ms, ok, error_code |
| `resource.sample` | origin (`container`/`cdp`), cpu_pct, mem_mb, net_rx_bytes, net_tx_bytes, js_heap_mb? (container samples carry CPU, memory and network; cdp samples carry js_heap_mb; whatever a sample can't measure is `null`) |
| `network.request` | domain, status, bytes, duration_ms, resource_type (sampled) |
| `issue` | kind (`blocked`/`captcha`/`crash`/`timeout`/`nav_error`/`unsupported_api`), message |
| `screenshot` | action_seq, url (stored locally or in object storage; optional) |

Ingest: `POST /v1/events` accepts batches of up to 1,000 events. The API validates them with zod, buffers them in memory, and flushes to ClickHouse every 1s or every 5k rows, whichever comes first. ClickHouse handles large batch inserts well and small frequent inserts badly. The collector batches and retries with backoff; `event_id` makes retries safe.

## 6. ClickHouse data model

- `sessions`: ReplacingMergeTree, ORDER BY `session_id`. Holds the latest state per session.
- `actions`, `resource_samples`, `network_requests`, `issues`: MergeTree, PARTITION BY `toDate(ts)`, ORDER BY `(engine, session_id, ts)`, TTL 30 days. `ts` is `DateTime64(3, 'UTC')`; inserts send it as a `YYYY-MM-DD HH:MM:SS.mmm` string, because ClickHouse reads an integer as seconds.
- `screenshot` events have no table yet; it is added with the screenshots feature (the first thing cut if behind).
- `fleet_minute`: AggregatingMergeTree, filled by a materialized view. Per minute and engine it keeps: active sessions, action count, `quantileState(0.5/0.95)` of action latency, error counts, CPU and memory sums. TTL 1 year. The Overview charts read from this table, not from raw rows.
- Cost is computed in queries from a pricing config: $/browser-hour per engine/provider, $/GB bandwidth, and $/1M LLM tokens (optional).

Write `docs/adr/0001-clickhouse.md` explaining why ClickHouse and when Postgres would still be the right choice (app metadata such as users, API keys and alert rules).

## 7. Dashboard (apps/web)

Global layout: left sidebar navigation; a top bar with a time range picker (15m/1h/24h/7d/custom), an engine filter, a source filter (real/sim/all) and a ⌘K command palette (jump to a session ID, page or saved view). All state lives in the URL.

1. **Overview `/`**: KPI cards (active sessions now, sessions in range, success rate, p95 action latency, CPU cores in use, memory GB, estimated cost); live charts (active sessions, actions/min, error rate); a breakdown by engine; a "recent failures" list that links into sessions.
2. **Sessions `/sessions`**: a filterable, sortable table (status, engine, agent, scenario, duration, peak memory, cost) with a small memory sparkline per row.
3. **Session detail `/sessions/[id]`**: a header (status, engine, duration, cost); an **action waterfall** (Gantt timeline); CPU and memory charts on the same time axis; an always-visible issues side panel and a network tab (see `design/DESIGN.md`); screenshots; an "Explain this session" button (Claude Haiku summarizes what happened and the likely cause).
4. **Browsers `/browsers`**: engines side by side: startup time, memory per session, p95 action latency, success rate, cost per 1k sessions, and a per-scenario compatibility matrix (where Lightpanda fails and Chrome succeeds).
5. **Usage and cost `/usage`**: browser-hours, bandwidth and cost over time, broken down by engine, agent and scenario.
6. **Insights `/insights`**: problems found by SQL rules, each with severity and a link to the affected sessions:
   - Slowest actions and sites (p95)
   - Block or CAPTCHA rate per domain
   - Memory-leak suspects (memory rising steadily during a session)
   - Zombie sessions (idle for more than N minutes while still billed)
   - Error spikes compared with the previous period

Live updates: Overview and Sessions subscribe to `GET /v1/stream` (SSE) and update with a small throttle (once per second).

## 8. AI agents as users (apps/mcp)

An MCP server (stdio for Claude Code/Desktop, plus streamable HTTP) built on the `packages/db` query layer:
- `fleet_health(range?)` returns KPIs and the top 3 issues
- `list_sessions(filters)` returns a page of sessions
- `get_session(id)` returns a session with its actions, resource summary and issues
- `explain_session(id)` returns a short narrative of what happened and the likely cause
- `compare_engines(scenario?, range?)` returns an engine comparison table
- `find_issues(kind?, range?)` returns Insights results

Also: a public read-only REST API (the same endpoints the dashboard uses), documented with OpenAPI, plus `/llms.txt` describing the product and API for agents.

Demo moment: in Claude Code, ask "Which engine should I use for checkout-form, and why did the last failed session fail?" and let the agent answer from live fleet data.

## 9. How it's built and run, like a real startup

- **Git:** GitHub, protected `main`, short-lived feature branches, PRs with a template, conventional commits.
- **CI (GitHub Actions):** lint (Biome or ESLint), typecheck, unit tests (vitest), integration tests against a ClickHouse service container, Playwright end-to-end tests of the dashboard against seeded data, gitleaks secret scanning, and Dependabot.
- **AI review:** `anthropics/claude-code-action` for PR review and `@claude` mentions.
- **CD:** web on Vercel (a preview for each PR); api and mcp on Railway or Fly; ClickHouse Cloud (trial) or self-hosted ClickHouse on Railway for the deployed demo. The simulator runs on a schedule so the deployed dashboard always has fresh data.
- **Quality:** a test pyramid; seed fixtures in `packages/db/fixtures`; one end-to-end test per main screen.
- **Monitoring of Fleetscope itself:** Sentry (web and api), pino structured logs, `/healthz`.
- **Product analytics:** PostHog in the web app with events `page_viewed`, `session_opened`, `filter_changed`, `explain_clicked` and `command_palette_used`, plus one funnel (Overview → session detail).
- **Docs:** README (problem, users, screenshots and GIF, architecture, quickstart), ADRs, CHANGELOG.

## 10. The team: how Claude Code is organized

Fleetscope is built by a small AI team of Claude Code **subagents** (defined in `.claude/agents/`). The main Claude Code session is the **tech lead**: it hands out tasks, runs agents in parallel, and passes feedback between them. Agents don't talk to each other directly; they communicate through **files in the repo** (proposals, critiques, QA reports, review files), and the lead routes each one to the right agent. Eyal is the **product owner**: he approves the design and the end of every milestone.

Every feedback loop has **up to 2 feedback rounds, only if needed**. After that the lead decides, so nothing loops forever.

| Role | Agent file | Owns |
|---|---|---|
| Designer (UI/UX Pro Max) | `designer-promax` | Proposal, critiques, revisions |
| Designer (Taste skill) | `designer-taste` | Competing proposal, critiques, revisions |
| Design lead | `design-lead` | Decides after each round, writes `design/DESIGN.md` |
| Backend engineer | `backend-engineer` | schema, db, collector, api, runner, simulator, mcp |
| Frontend engineer | `frontend-engineer` | apps/web, following DESIGN.md |
| Platform engineer | `platform-engineer` | CI/CD, Docker, deploy, Sentry, PostHog, root config |
| QA engineer | `qa-engineer` | Tests, fixtures, `qa/` reports, merge verdict |
| Code reviewer | `code-reviewer` | `reviews/` files, approve or request changes |

### Design sprint (during M0, in the background while the skeleton is built)
1. **Proposals:** `designer-promax` and `designer-taste` run in parallel from `design/BRIEF.md` and save `v1` without seeing each other's work.
2. **Feedback round 1:** each designer writes a critique of the other's `v1`. Each then revises into `v2` and answers every point in `changes.md` (accepted / rejected with a reason / compromise).
3. **Lead check:** `design-lead` writes `design/rounds/r1-lead-notes.md`: where they now agree, what's still open, and **another round** or **close**.
4. **Feedback round 2 (only if needed):** the same critique-and-revise step, guided by the lead's notes, producing `v3`. Then the lead always closes.
5. **Decision:** `design-lead` scores the final versions, picks a winner per area (colors, typography, KPI cards, charts, tables, waterfall, navigation…), combines them into one coherent system, and writes `design/DECISIONS.md` and `design/DESIGN.md`.
6. **Approval:** Eyal reviews the mockups and DESIGN.md and answers open questions. Frontend work starts only after this.

### Development loop (every milestone)
1. **Plan:** the lead writes the milestone's tasks, each with an owner, the folders it touches and "done when", into the PR description.
2. **Contract first:** the backend engineer commits new schema or API types first; the lead passes them to the frontend engineer and QA.
3. **Build in parallel:** backend, frontend and platform engineers run at the same time in the same checkout on the milestone branch (`m1-...`). Each **edits and commits only the folders it owns**, which is what prevents conflicts.
4. **QA and review (in parallel):** `qa-engineer` writes tests and `qa/<milestone>-report.md`; `code-reviewer` writes `reviews/<milestone>.md`. Every finding names its owner.
5. **Feedback round 1:** the lead sends each engineer their findings. They fix them or explain why they disagree. QA re-tests and the reviewer re-reviews.
6. **Feedback round 2 (only if needed):** the same again for anything still open.
7. **Decide and merge:** the lead decides anything still disputed (significant decisions become an ADR), opens the PR (the Claude GitHub Action reviews it too), and merges when CI is green, QA says "ready to merge" and the reviewer approves. Then the lead shows Eyal what changed.

### Records (for the interview)
Design versions with critiques and `changes.md`, the lead's round notes, `design/DECISIONS.md`, `qa/` reports, `reviews/` files, ADRs and PR descriptions together show how the team worked and how feedback changed the result.

## 11. Milestones (cut from the bottom if time runs out)

| # | When | Goal | Done when |
|---|---|---|---|
| M0 | Thu night | Walking skeleton + design sprint | Monorepo, CI green, docker-compose ClickHouse up, migrations run, empty dashboard deployed on Vercel. In parallel: both design proposals, cross-reviews, and DESIGN.md approved by Eyal |
| M1 | Fri morning | First real data | Collector + runner + demo site: 10 Chromium sessions land in ClickHouse with actions and container stats |
| M2 | Fri afternoon | Core screens | Overview, Sessions and Session detail (waterfall + resource charts) on real data |
| M3 | Fri evening | Multi-engine | chrome-headless-shell and Lightpanda in the pool; Browsers comparison page; simulator generating 500+ sessions |
| M4 | Sat morning | Product depth | Insights rules, Usage and cost page, live SSE updates, ⌘K palette |
| M5 | Sat afternoon | Agents + production | MCP server, "Explain this session" button, production deploy, Sentry + PostHog |
| M6 | Sat evening | Polish | README with screenshots and GIF, ADRs, demo script, recorded 2-minute backup video |

**What to cut if behind (in this order):** Usage page (merge into Overview) → MCP over HTTP (keep stdio) → screenshots.
**Never cut:** real Chromium + Lightpanda data, Session detail, Browsers comparison, CI, deployed demo.

## 12. Demo script (about 5 minutes)
1. Overview: the fleet live, with real and simulated sessions labeled.
2. Click the error spike → Sessions filtered → open a failed Lightpanda session → waterfall shows the unsupported API → "Explain".
3. Browsers: Lightpanda uses about 1/10 the memory but fails checkout-form; recommend a per-scenario engine choice.
4. Insights: a zombie session wasting $X/day and a memory-leak suspect.
5. Claude Code with the MCP server answers the same questions on its own.
6. Engineering tour: repo, CI, an ADR on ClickHouse, the PostHog funnel.
7. How it was built: the AI team (design sprint with two competing designers and a lead, then engineers, QA and reviewer), with `design/DECISIONS.md` and a few PRs as evidence.

## 13. One-time setup (Eyal, before starting Claude Code)
1. Create an empty GitHub repo `fleetscope`, clone it, and unzip the kickoff files into it (`PLAN.md`, `CLAUDE.md`, `design/BRIEF.md`, `.claude/agents/`). Commit them to `main`.
2. Install Docker Desktop (WSL2), Node 22+, pnpm and git.
3. In Claude Code (opened in the repo folder), install the skills. In each install panel choose **project** scope, so the choice is saved in `.claude/settings.json` and committed:
   - UI/UX Pro Max: `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`, then `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`
   - Taste: `/plugin marketplace add Leonxlnx/taste-skill`, then `/plugin install taste-skill@taste-skill`
   - Superpowers: `/plugin marketplace add obra/superpowers-marketplace`, then `/plugin install superpowers@claude-plugins-official` (the ID that ended up in `.claude/settings.json`)
   - Run `/reload-plugins`, check that all three appear in `/plugin`, then ask Claude "which subagents are available to you?" and check that all 8 agents are listed.
   - Read each SKILL.md before installing; third-party skills can contain hidden instructions.
4. Accounts for later milestones: Vercel, Railway or Fly, ClickHouse Cloud (trial), Sentry, PostHog, an Anthropic API key.
5. First prompt to Claude Code: *"You are the tech lead. Read PLAN.md and CLAUDE.md. Start M0: run the design sprint from section 10 in the background (designer-promax and designer-taste in parallel, then the feedback rounds with design-lead), and at the same time plan the walking skeleton and assign it to the platform and backend engineers. Stop for my approval when the design is ready and when M0 is done."*
