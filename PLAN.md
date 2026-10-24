# Fleetscope — observability for AI browser fleets

> Working plan. Hand this file to Claude Code together with `CLAUDE.md`.
> Deadline: demo-ready by **Saturday night**. Interview Sunday 16:00 (IL).
> **Changed in M2 (2026-10-24):** the custom Next.js dashboard was replaced by **Grafana** (Grafana Cloud free tier, ClickHouse data source, dashboards as JSON in the repo). Session timelines open in **Perfetto**; "explain" is **Grafana Assistant**. See `docs/adr/0003-grafana-dashboards.md`.

## 1. Product

### Problem
Teams running AI agents on browser fleets (on Anchor, Browserbase, or their own infrastructure) have almost no visibility into what the browsers are doing. When an agent is slow, fails, gets blocked or burns money, they have to dig through logs one session at a time.

### Users and the questions they ask
| User | Question | Grafana dashboard |
|---|---|---|
| DevOps / platform engineer | Is the fleet healthy right now? Are we near capacity? | Overview |
| DevOps / finance-minded lead | What is this costing, and where does it go? | Usage and cost |
| Agent developer | Why did this session fail or run slowly? | Session detail (+ Perfetto timeline, Grafana Assistant) |
| Agent developer / DevOps | Which browser engine should we run, and for which sites? | Browsers |
| Everyone | What should we fix first? | Insights |
| **AI agents** | "Is my fleet healthy? Why did session X fail?", asked programmatically | MCP server + REST API |

### Product principles
1. **Overview first, then drill down.** Every number on a dashboard links to the sessions behind it (Grafana data links).
2. **Every view has a URL.** Grafana keeps the time range and the variables (engine, source, …) in the URL, so any view can be shared as a link.
3. **Agents are first-class users.** Everything a human can see in Grafana, an agent can query through MCP.
4. **Simulated data is always labeled.** Real and simulated sessions carry `source: "real" | "sim"`, and every dashboard can filter them.

### Success metrics (for the README's product section)
- Time to answer "why did session X fail" is under 30 seconds, in 3 clicks or fewer.
- The cheapest engine that can handle a given site is visible on one dashboard.

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
           │ ingest buffer → batch insert │ query layer │ session trace     │
           │                              │             │ (→ Perfetto UI)   │
           └──────────────┬──────────────────────────────────────────────┘
                          ▼
                    ClickHouse  ◄──── read-only SQL ────┐
             raw tables + materialized                  │
             per-minute rollups                         │
                          ▲                             │
           ┌──────────────┴─────────┐          ┌────────┴────────────────────┐
           │ mcp server (tools for  │          │ Grafana (Cloud free / local)│
           │ agents, same query     │          │ dashboards as JSON in repo, │
           │ layer)                 │          │ auto-refresh, Assistant     │
           └────────────────────────┘          └─────────────────────────────┘
```

### Monorepo layout (pnpm + Turborepo, TypeScript strict)
```
apps/
  api/            Fastify: ingest, query endpoints, session trace + Perfetto page
  fleet-runner/   runs real browser sessions against the demo site
  simulator/      generates realistic synthetic fleet traffic
  demo-site/      target site with controllable chaos (slow, flaky, blocked)
  mcp/            MCP server exposing fleet tools to AI agents
packages/
  schema/         zod event schemas + TS types (single source of truth, versioned)
  collector/      SDK: wraps Playwright Browser/Page, emits events, batches, retries
  db/             ClickHouse client, migrations, query functions (shared by api + mcp)
infra/
  docker-compose.yml   ClickHouse + Grafana for local dev (browser containers are started by the runner)
  clickhouse/          SQL migrations
  grafana/             dashboards (JSON), local provisioning, push script
  browsers/            browser images
docs/
  adr/            architecture decision records
```

## 3. Browser fleet

Each browser instance runs in **its own Docker container** and exposes a CDP or Playwright endpoint. The runner runs up to `--concurrency` containers at once and gives each session a fresh container that is removed afterwards, so container CPU and memory belong to exactly one session and `startup_ms` (container create → server ready) is a real per-engine number.

| Engine | How it runs | Why include it |
|---|---|---|
| Chromium (Playwright) | Playwright browser-server container | Baseline that everything is compared to |
| chrome-headless-shell | `chromedp/headless-shell` image (CDP on 9222) | Google's lighter headless build |
| Lightpanda | Official Lightpanda Docker image (CDP) | Built from scratch for AI agents; very low memory; incomplete Web API coverage, so real compatibility failures will show up |

The fleet uses exactly these three engines. Don't add others.

Verify current image names, ports and Playwright compatibility in each project's README before wiring them in. Docker Desktop with WSL2 is required on Windows.

**How the browser reaches the demo site.** Inside every browser container the demo site is `http://localhost:3100`, because `localhost` is a secure context in every engine (APIs like `crypto.subtle` need one). A small forwarder passes that port to the host. In M1 the forwarder runs inside the browser container and adds about 10 MB idle and 11–17 MB with a page loaded to every container sample (measured, `infra/browsers/README.md`). In M3, before the engines are compared, it moves to a sidecar container that shares the browser container's network namespace (`--network container:<browser>`), so it is no longer counted in the browser's memory.

### Where the metrics come from (measured inside and outside)
- **Outside (works for every engine):** Docker Engine API stats per container: CPU %, memory, network rx/tx, sampled every 2s.
- **Inside (when supported):** CDP `Performance.getMetrics` (JS heap, layout and script time) and network events. Engines that don't support a domain report `null` and never crash the collector.
- **Client side (collector):** wall-clock latency for every action, browser startup and connect time, and navigation timing.

## 4. Scenarios (fleet-runner) and the demo site

**Demo site:** a small Fastify app (server-rendered HTML) with realistic flows and chaos settings set by query parameters or an admin toggle:
- Log in → dashboard → search → open item → fill a form → submit
- A slow page (adjustable latency), a flaky element (sometimes missing), a heavy page (large DOM and many images)
- A "bot wall" page that returns 403 or a fake CAPTCHA at an adjustable rate
- A JS-heavy page that uses Web APIs some engines lack (this is how Lightpanda's compatibility gaps show up)

**Scenarios:** `login-and-search`, `checkout-form`, `heavy-page-crawl`, `long-idle-session` (a zombie browser that wastes money), `memory-hog` (a page that leaks memory). Each scenario is a typed function that uses the collector-wrapped page. M1 builds the first three; `long-idle-session` and `memory-hog` come with Insights (M3/M4).

**Runner CLI:** `pnpm fleet run --engines chromium,lightpanda --sessions 40 --concurrency 8 --scenario mix` (engine slugs as in `packages/schema`)

## 5. Event schema (`packages/schema`, version 1)

All events share: `v`, `type` (the event name below, used as the discriminator), `event_id` (uuid, used to drop duplicates), `ts` (ms), `session_id`, `source` ("real"|"sim"), `agent_id`, `engine` (`chromium`/`chrome-headless-shell`/`lightpanda`), `provider`. Since M2 the identifiers and labels that dashboards put into SQL (`session_id`, `agent_id`, `provider`, `scenario`, `region`, `engine_version`, `error_code`) accept only `A-Z a-z 0-9 . _ : @ / + -`, 1–128 characters (`SAFE_LABEL_PATTERN`); other values are rejected at ingest with 400.

| Event | Extra fields |
|---|---|
| `session.started` | engine_version, scenario, region, startup_ms, connect_ms |
| `session.ended` | status (`success`/`failed`/`blocked`/`timeout`/`crashed`), reason, duration_ms |
| `action` | seq, action_type (`goto`/`click`/`fill`/`extract`/`screenshot`/`wait`/`eval`), target (selector or domain), duration_ms, ok, error_code |
| `resource.sample` | origin (`container`/`cdp`), cpu_pct, mem_mb, net_rx_bytes, net_tx_bytes, js_heap_mb? (container samples carry CPU, memory and network; cdp samples carry js_heap_mb; whatever a sample can't measure is `null`) |
| `network.request` | domain, status, bytes, duration_ms, resource_type (sampled) |
| `issue` | kind (`blocked`/`captcha`/`crash`/`timeout`/`nav_error`/`unsupported_api`), message |
| `screenshot` | action_seq, url (stored locally or in object storage; optional) |

Ingest: `POST /v1/events` accepts batches of up to 1,000 events. The API validates them with zod, buffers them in memory, and flushes to ClickHouse every 1s or every 5k rows, whichever comes first. ClickHouse handles large batch inserts well and small frequent inserts badly. The collector batches and retries with backoff; `event_id` makes retries safe. Events with a `ts` more than 5 minutes in the future or older than the 30-day retention are rejected (400). A flush that ClickHouse keeps refusing with a data error goes to a dead-letter file instead of blocking ingest (ADR 0002).

**What the timings mean.** `startup_ms` = container created → browser server ready. `connect_ms` = the client's `connect()`, which includes launching the browser. Engines are compared on `startup_ms + connect_ms` ("time to a usable browser").

**Why a session failed.** Every session that doesn't end in `success` has a `reason`, and the action that failed carries an `error_code`. "Why did session X fail" is answered from those two. `issue` events are for problems with the site or the engine (blocked, captcha, crash, timeout, navigation error, unsupported API), so a session can fail without an issue (for example a missing selector).

## 6. ClickHouse data model

- `sessions`: ReplacingMergeTree, ORDER BY `session_id`. Holds the latest state per session. PARTITION BY `toDate(started_at)`, TTL 30 days, like the raw tables.
- `actions`, `resource_samples`, `network_requests`, `issues`: MergeTree, PARTITION BY `toDate(ts)`, ORDER BY `(engine, session_id, ts)`, TTL 30 days. `ts` is `DateTime64(3, 'UTC')`; inserts send it as a `YYYY-MM-DD HH:MM:SS.mmm` string, because ClickHouse reads an integer as seconds.
- `screenshot` events have no table yet; it is added with the screenshots feature (the first thing cut if behind).
- `fleet_minute`: AggregatingMergeTree, filled by materialized views. Per minute, engine and source it keeps: action count, error count, `quantilesState(0.5, 0.95)` of action latency, CPU and memory sums with a sample count. TTL 1 year. The Overview charts read from this table, not from raw rows. Active sessions per minute are derived from `sessions` at query time (that table is small).
- `pricing`: $/browser-hour per engine and provider, with the source of the price (a published reference price until we have our own). Cost = browser-hours × price, computed in the dashboard queries and labeled "estimated".
- Grafana reads ClickHouse with a **read-only user**. The dashboard rules (one row per session via `FINAL`, interrupted sessions excluded from success and failure numbers, failure cause = issue kind or the failed action's `error_code`) are documented in `packages/db/README.md`.

Write `docs/adr/0001-clickhouse.md` explaining why ClickHouse and when Postgres would still be the right choice (app metadata such as users, API keys and alert rules).

## 7. Dashboards (Grafana)

The UI is **Grafana**: Grafana Cloud (free tier) for the deployed demo and a local Grafana OSS container (`localhost:3001`) for development. Dashboards are JSON files in `infra/grafana/dashboards/`, loaded by the local Grafana and uploaded to Grafana Cloud with `pnpm grafana:push`. Grafana queries ClickHouse directly with the official ClickHouse data source (UID `fleetscope-clickhouse`) as a read-only user. Grafana's time picker and variables (`engine`, `source` real/sim/All, `status`, `agent`, `scenario`, and `routed` on Sessions) are the filters, and they live in the URL. Panels auto-refresh (no SSE). Visual rules (engine and status colours, units, thresholds) are in `design/DESIGN.md`.

1. **Overview** (`fleetscope-overview`): verdict; KPIs (active sessions now, sessions in range, success rate, p95 action latency, CPU cores in use, memory in use (GiB), estimated cost, interrupted sessions); time series per engine: actions/min from `fleet_minute`; active sessions and error rate per session from `sessions` (so interrupted sessions can be excluded); a breakdown by engine; recent failures and top failure causes that link into sessions.
2. **Sessions** (`fleetscope-sessions`): a filterable table (status, engine, agent, scenario, duration, startup + connect, actions, peak memory, estimated cost, source); each row links to Session detail.
3. **Session detail** (`fleetscope-session`): header stats and the failure reason; actions table; CPU, memory and JS-heap charts; network and issues; an **"Open timeline in Perfetto"** link; and suggested **Grafana Assistant** prompts ("explain this session").
   - **Perfetto timeline:** the API serves the session as a Chrome trace (`GET /v1/sessions/:id/trace`): actions as slices, network requests, issues as markers, and CPU / memory / JS-heap counters on the same time axis. `GET /v1/sessions/:id/perfetto` is a small page that opens ui.perfetto.dev and hands it the trace (processed in the browser, not uploaded). The viewer's browser must reach the API.
4. **Browsers** (`fleetscope-browsers`, M3): engines side by side: time to a usable browser, memory per session, p95 action latency, success rate, cost per 1k sessions, and a per-scenario compatibility matrix (where Lightpanda fails and Chromium succeeds).
5. **Usage and cost** (`fleetscope-usage`, M4): browser-hours and cost over time, by engine, agent and scenario.
6. **Insights** (`fleetscope-insights`, M4): problems found by SQL rules, each with severity and a link to the affected sessions:
   - Slowest actions and sites (p95)
   - Block or CAPTCHA rate per domain
   - Memory-leak suspects (memory rising steadily during a session)
   - Zombie sessions (idle for more than N minutes while still billed)
   - Error spikes compared with the previous period

**Dropped with the move to Grafana:** the ⌘K palette (Grafana has its own search), SSE live updates (auto-refresh), PostHog product analytics, and the Claude Haiku "Explain" endpoint (Grafana Assistant instead).

## 8. AI agents as users (apps/mcp)

An MCP server (stdio for Claude Code/Desktop, plus streamable HTTP) built on the `packages/db` query layer:
- `fleet_health(range?)` returns KPIs and the top 3 issues
- `list_sessions(filters)` returns a page of sessions
- `get_session(id)` returns a session with its actions, resource summary and issues
- `explain_session(id)` returns a short narrative of what happened and the likely cause (how it's generated is decided in M5; humans use Grafana Assistant)
- `compare_engines(scenario?, range?)` returns an engine comparison table
- `find_issues(kind?, range?)` returns Insights results

Also: a public read-only REST API on the same query layer, documented with OpenAPI, plus `/llms.txt` describing the product and API for agents.

Demo moment: in Claude Code, ask "Which engine should I use for checkout-form, and why did the last failed session fail?" and let the agent answer from live fleet data.

## 9. How it's built and run, like a real startup

- **Git:** GitHub, protected `main`, short-lived feature branches, PRs with a template, conventional commits.
- **CI (GitHub Actions):** Biome lint, typecheck, unit tests (vitest), integration tests against a ClickHouse service container, a fleet smoke test with real Chromium containers, a **dashboard check that runs every Grafana panel's SQL** against seeded data, gitleaks secret scanning, and Dependabot.
- **AI review:** `anthropics/claude-code-action` for PR review and `@claude` mentions.
- **CD and hosting (kept at $0):** Grafana Cloud free tier, with dashboards uploaded by `pnpm grafana:push`; ClickHouse Cloud **30-day trial** (no free tier exists, so the service is deleted before the trial ends). Hosting for the api/mcp and a schedule for the simulator are decided in M5 with the $0 constraint; until then the api runs locally pointed at ClickHouse Cloud for demo runs.
- **Quality:** a test pyramid; seed fixtures in `packages/db/fixtures`; every dashboard query executed in CI.
- **Monitoring of Fleetscope itself:** Sentry (api), pino structured logs, `/healthz`.
- **Docs:** README (problem, users, Grafana screenshots and GIF, architecture, quickstart), ADRs, CHANGELOG.

## 10. The team: how Claude Code is organized

Fleetscope is built by a small AI team of Claude Code **subagents** (defined in `.claude/agents/`). The main Claude Code session is the **tech lead**: it hands out tasks, runs agents in parallel, and passes feedback between them. Agents don't talk to each other directly; they communicate through **files in the repo** (proposals, critiques, QA reports, review files), and the lead routes each one to the right agent. Eyal is the **product owner**: he approves the design and the end of every milestone.

Every feedback loop has **up to 2 feedback rounds, only if needed**. After that the lead decides, so nothing loops forever.

| Role | Agent file | Owns |
|---|---|---|
| Designer (UI/UX Pro Max) | `designer-promax` | Proposal, critiques, revisions |
| Designer (Taste skill) | `designer-taste` | Competing proposal, critiques, revisions |
| Design lead | `design-lead` | Decides after each round, writes `design/DESIGN.md` (since M2 a Grafana dashboard spec) |
| Backend engineer | `backend-engineer` | schema, db, collector, api, runner, simulator, mcp |
| Dashboard engineer | `frontend-engineer` | Grafana dashboards (`infra/grafana/dashboards`) following DESIGN.md, and apps/demo-site |
| Platform engineer | `platform-engineer` | CI/CD, Docker, local Grafana and its provisioning, `grafana:push`, deploy, Sentry, root config |
| QA engineer | `qa-engineer` | Tests, fixtures, `qa/` reports, merge verdict |
| Code reviewer | `code-reviewer` | `reviews/` files, approve or request changes |

### Design sprint (during M0, in the background while the skeleton is built)
1. **Proposals:** `designer-promax` and `designer-taste` run in parallel from `design/BRIEF.md` and save `v1` without seeing each other's work.
2. **Feedback round 1:** each designer writes a critique of the other's `v1`. Each then revises into `v2` and answers every point in `changes.md` (accepted / rejected with a reason / compromise).
3. **Lead check:** `design-lead` writes `design/rounds/r1-lead-notes.md`: where they now agree, what's still open, and **another round** or **close**.
4. **Feedback round 2 (only if needed):** the same critique-and-revise step, guided by the lead's notes, producing `v3`. Then the lead always closes.
5. **Decision:** `design-lead` scores the final versions, picks a winner per area (colors, typography, KPI cards, charts, tables, waterfall, navigation…), combines them into one coherent system, and writes `design/DECISIONS.md` and `design/DESIGN.md`.
6. **Approval:** Eyal reviews the mockups and DESIGN.md and answers open questions. Frontend work starts only after this.

The sprint ran in M0 for a custom web UI. In M2 the UI moved to Grafana (ADR 0003); the design lead turned the approved design into a Grafana spec, and the sprint records stay as history.

### Development loop (every milestone)
1. **Plan:** the lead writes the milestone's tasks, each with an owner, the folders it touches and "done when", into the PR description.
2. **Contract first:** the backend engineer commits new schema, table or API contracts first; the lead passes them to the dashboard engineer and QA.
3. **Build in parallel:** backend, dashboard and platform engineers run at the same time in the same checkout on the milestone branch (`m1-...`). Each **edits and commits only the folders it owns**, which is what prevents conflicts.
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
| M2 | Sat | Grafana + core dashboards | `apps/web` removed; Overview, Sessions and Session detail dashboards on real data, locally and in Grafana Cloud on ClickHouse Cloud; Perfetto session timeline; every dashboard query checked in CI |
| M3 | Sat | Multi-engine | chrome-headless-shell and Lightpanda in the pool; Browsers dashboard; simulator generating 500+ sessions. Carried from M1: move the demo-site forwarder into a sidecar container so its memory isn't counted in the browser's samples; classify TypeError-shaped missing Web APIs as `unsupported_api` |
| M4 | Sat | Product depth | Insights rules and Usage and cost dashboards |
| M5 | Sat | Agents + production | MCP server (decide how `explain_session` works), api/simulator hosting at $0 (or keep the api local for the demo), Sentry, Grafana Assistant checked on the demo data |
| M6 | Sat night | Polish | README with Grafana screenshots and GIF, ADRs, demo script, recorded 2-minute backup video |

**What to cut if behind (in this order):** Usage dashboard (merge into Overview) → MCP over HTTP (keep stdio) → screenshots.
**Never cut:** real Chromium + Lightpanda data, Session detail with the Perfetto timeline, Browsers comparison, CI, the deployed demo (Grafana Cloud).

## 12. Demo script (about 5 minutes)
1. Overview in Grafana: the fleet live, with real and simulated sessions labeled.
2. Click the error spike → Sessions filtered → open a failed Lightpanda session → "Open timeline in Perfetto" shows the failing action next to CPU and memory → ask Grafana Assistant why it failed.
3. Browsers: Lightpanda uses about 1/20 the memory but never runs Web Workers, so it fails every heavy-page-crawl (checkout-form works); routing by scenario (ADR 0005) sends those pages to headless-shell and the dashboard shows the routed sessions.
4. Insights: a zombie session wasting $X/day and a memory-leak suspect.
5. Claude Code with the MCP server answers the same questions on its own.
6. Engineering tour: repo, CI (including the check that runs every dashboard query), dashboards as code, ADRs on ClickHouse and Grafana.
7. How it was built: the AI team (design sprint with two competing designers and a lead, then engineers, QA and reviewer), the switch to Grafana mid-project, with `design/DECISIONS.md` and a few PRs as evidence.

## 13. One-time setup (Eyal, before starting Claude Code)
1. Create an empty GitHub repo `fleetscope`, clone it, and unzip the kickoff files into it (`PLAN.md`, `CLAUDE.md`, `design/BRIEF.md`, `.claude/agents/`). Commit them to `main`.
2. Install Docker Desktop (WSL2), Node 22+, pnpm and git.
3. In Claude Code (opened in the repo folder), install the skills. In each install panel choose **project** scope, so the choice is saved in `.claude/settings.json` and committed:
   - UI/UX Pro Max: `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`, then `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`
   - Taste: `/plugin marketplace add Leonxlnx/taste-skill`, then `/plugin install taste-skill@taste-skill`
   - Superpowers: `/plugin marketplace add obra/superpowers-marketplace`, then `/plugin install superpowers@claude-plugins-official` (the ID that ended up in `.claude/settings.json`)
   - Run `/reload-plugins`, check that all three appear in `/plugin`, then ask Claude "which subagents are available to you?" and check that all 8 agents are listed.
   - Read each SKILL.md before installing; third-party skills can contain hidden instructions.
4. Accounts for later milestones: Grafana Cloud (free tier), ClickHouse Cloud (30-day trial; delete the service before it ends), Sentry. Hosting for the api (if any) and an Anthropic API key only if M5 decides they're needed. (M0 used Vercel for the old web app; that project is disconnected in M2.)
5. First prompt to Claude Code: *"You are the tech lead. Read PLAN.md and CLAUDE.md. Start M0: run the design sprint from section 10 in the background (designer-promax and designer-taste in parallel, then the feedback rounds with design-lead), and at the same time plan the walking skeleton and assign it to the platform and backend engineers. Stop for my approval when the design is ready and when M0 is done."*
