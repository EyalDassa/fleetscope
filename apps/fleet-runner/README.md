# @fleetscope/fleet-runner

Runs real browser sessions and reports them. Each session gets its own Docker container for one
engine (chromium, chrome-headless-shell or lightpanda) plus a small forwarder sidecar, a scenario
drives the browser through `@fleetscope/collector`, and the runner adds the numbers only Docker can
give (CPU, memory, network). Then both containers are removed.

```
pnpm infra:up && pnpm db:migrate && pnpm browsers:build && pnpm browsers:pull   # once
pnpm --filter @fleetscope/api dev                            # :4000
pnpm --filter @fleetscope/demo-site dev                      # :3100
pnpm fleet run --engines chromium,chrome-headless-shell,lightpanda --sessions 9 --concurrency 3
```

## Engines

The table is `src/engines.ts`, one entry per `ENGINES` value.

| engine | image (override) | port | ready when | connect |
|---|---|---|---|---|
| `chromium` | `fleetscope/playwright-chromium:1.64.1-2` (`FLEET_BROWSER_IMAGE_CHROMIUM`, old name `FLEET_BROWSER_IMAGE`) | 3000 | `GET /` 2xx | `chromium.connect(ws://...)`, Playwright's server launches Chromium |
| `chrome-headless-shell` | `chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423` (`FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL`) | 9222 | `GET /json/version` 2xx | `connectOverCDP(http://127.0.0.1:<port>)` |
| `lightpanda` | `lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9` (`FLEET_BROWSER_IMAGE_LIGHTPANDA`) | 9222 | `GET /json/version` 2xx | `connectOverCDP(ws://127.0.0.1:<port>/)` |

Every session opens a fresh context with `browser.newContext()` and one page (Lightpanda allows one
context and one page per CDP connection). If an engine refuses viewport emulation the page runs with
its default viewport (logged).

**Forwarder sidecar.** The browsers open the demo site as `http://localhost:3100`. For every engine
the runner starts, next to the browser, a container from `FLEET_FORWARDER_IMAGE`
(`fleetscope/forwarder:1-1`) with `NetworkMode: container:<browser>`: it shares the browser's
`localhost` but not its cgroup, so the forwarder's memory is never in a session's samples. It has the
same `fleetscope.*` labels plus `fleetscope.role=forwarder` (the browser has `role=browser`).
`startup_ms` is browser create to browser ready; the sidecar starts alongside, must be listening
before the scenario starts, and is not counted. Teardown: sidecar first, then the browser. If the
sidecar finds the port taken (an old chromium image with its own forwarder) that is accepted; any
other sidecar failure is an `infra_error`. The stats sampler reads the browser container only.

**Chromium's memory includes Playwright's `run-server`.** The chromium container runs a Node.js
process next to Chromium; the CDP engines have only the browser. Measured on Docker Desktop (image
`1.64.1-2`): the container alone, before any client connects, reads about 114 MiB (the stats figure;
anon 111 MiB), and that is the Node process (RSS 162 MiB, 165 MiB with a 20 000-node `/heavy` page
loaded; RSS also counts shared library pages). So chromium's "peak memory" is about 110 MiB higher
than the same Chromium run over CDP. Running chromium over CDP like the others is planned for M4.

**What Lightpanda does not provide** (recorded, never faked): no `Performance.getMetrics`, so every
`cdp` sample has `js_heap_mb = null` ("not available"); no `*ExtraInfo` network events, so request
sizes and timing fall back to what Playwright can see; its `Browser.getVersion` pretends to be a
Chrome, so `engine_version` is its own `Lightpanda-Version` from `/json/version`. A CDP method it
lacks fails the action with `unsupported_feature`; a missing page API is an `unsupported_api` issue.
Its `/js-heavy` Web Worker probe times out (`webWorker: timeout after 3000ms`): that is a `timeout`
(issue and session status), not an unsupported-API claim, because a timeout does not prove absence.

## Commands

```
pnpm fleet run [--engines chromium] [--sessions 10] [--concurrency 4]
               [--scenario mix|login-and-search|checkout-form|heavy-page-crawl]
               [--seed N] [--agent ID] [--routing fixed|by-scenario] [--session-timeout 120]
               [--public N] [--state-file PATH]
pnpm fleet traffic [--engines chromium] [--rate 3] [--concurrency 2] [--duration 10m] [--agent ID]
               [--scenario ...] [--seed N] [--routing fixed|by-scenario] [--session-timeout 120]
               [--public N] [--state-file PATH]
pnpm fleet cleanup          # remove every container labelled fleetscope.session (all runs)
```

**Fair assignment.** With N engines every scenario runs on every engine: session `i` takes
`pairs[(seed + i) mod (scenarios x engines)]` over (scenario, engine) pairs, so each block of
`scenarios x engines` sessions covers every pair once (`src/assign.ts`). A fixed `--scenario` cycles
the engines.

**Routing (`--routing fixed|by-scenario`, default `fixed`).** `fixed` runs every session on the
engine it was assigned, which is what you want when measuring each engine on every scenario (a
Lightpanda `heavy-page-crawl` then fails, honestly). `by-scenario` moves a session off an engine that
lacks something its scenario needs: `SCENARIO_NEEDS` (`src/scenarios/index.ts`) says what a scenario
needs (`heavy-page-crawl`: `webWorker`), `ENGINE_SPECS[engine].lacks` what an engine is verified not to
have (Lightpanda: `webWorker`, see `docs/adr/0005`), and `routeSession` (`src/assign.ts`) picks the
first capable engine of the run's `--engines` in the order `lightpanda`, `chrome-headless-shell`,
`chromium`. If no engine of the run is capable the session stays where it was assigned (and fails) and
the runner logs a warning once per run.

A routed session is recorded honestly: `session.started.routed_from` / `sessions.routed_from` is the
engine the assignment chose, while `engine` (and everything keyed by it: memory, cost, success rate)
is the engine that **actually ran** it. So per-engine numbers count where the session ran, never
where it was meant to run. The summary shows `chrome-headless-shell (from lightpanda)` in the engine
column and a `routed: N of M sessions` line. Routing happens after the fair assignment, so a routed
run has more sessions on the capable engine than a `fixed` one.

**`fleet traffic`** keeps sessions coming at `--rate` sessions per minute (default 3) with at most
`--concurrency` at once (default 2), in batches of `min(concurrency, rate)` sessions. It prints one
line per batch, runs until Ctrl+C or `--duration` (`90s`, `10m`, `2h`), and stops like `run` does
(same debounce, same cleanup, then the summary). Events go to `FLEETSCOPE_API_URL` with agent
`traffic@<host>` unless `--agent` is given. If sessions take longer than the batch period the next
batch starts at once, so the real rate is lower than asked; the batch durations show it.

The summary table has the engine and the time to a usable browser (`startup + connect`) per session,
and per-engine totals at the end.

Environment (from `.env`): `FLEETSCOPE_API_URL`, `DEMO_SITE_URL` (the runner's own checks),
`DEMO_SITE_BROWSER_URL` (what the browser opens, default `http://localhost:3100`, reached through
the forwarder sidecar), `DEMO_SITE_UPSTREAM` (given to the sidecar), `FLEET_BROWSER_IMAGE_CHROMIUM`,
`FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL`, `FLEET_BROWSER_IMAGE_LIGHTPANDA`,
`FLEET_FORWARDER_IMAGE`, `DOCKER_HOST`, `LOG_LEVEL`.

Exit codes: `0` ok, `1` a problem (preflight failed, a browser never came up, events were dropped),
`2` wrong command line, `130` interrupted.

## One session

1. **Preflight**, before anything starts: API `/healthz`, the demo site, Docker, the image. All
   problems are listed at once.
2. Create the browser container (labels `fleetscope.session`, `fleetscope.run`, `fleetscope.engine`,
   `fleetscope.role`) and the sidecar, wait until the browser answers its readiness check over
   HTTP: `startup_ms`.
3. Connect: `connect_ms`. With chromium the Playwright server launches Chromium for the client, so
   this **includes the browser launch**; compare engines on `startup_ms + connect_ms` (the
   summary's "to browser" column).
4. `session.started`, then Docker's stats stream and the scenario run side by side.
5. Last stats sample, `session.ended`, close the browser, remove the container. If the browser never
   came up there is nothing to report (no timings), and the summary shows `infra_error`.

Status of a session: `success`; `blocked` (403 or captcha, on a goto or a click); `timeout` (an action,
or `--session-timeout`); `crashed` (the browser went away by itself); `failed` for anything else,
including Ctrl+C (`reason: interrupted`). The reason is never empty.

## What the container numbers mean

`resource.sample` with `origin: container`, from Docker's stats **stream** (one frame about every
second over one connection), one sample every 2 s, plus a last one when the session ends:

- **CPU %** is Docker's own figure for the second before the frame (`cpu_delta / system_delta * cpus *
  100`), so 100 is one core. The first sample has no previous frame; it is the container's average
  since it started, which includes launching Chromium.
- **Memory MB** is usage minus the page cache (`inactive_file`, as `docker stats` shows).
- **Network bytes** are changes since the previous sample (the first counts from container start).
  They are **container** bytes, not page bytes: Playwright's control channel and every screenshot
  cross the same interface. Do not read them as "what the page downloaded"; `network_requests.bytes`
  is that, sampled 1 in 5.
- The forwarder is a sidecar in its own cgroup, so none of its memory or CPU is in these samples
  (before M3 about 10 to 17 MB of it were).
- A sample's `ts` is when its frame arrived. Every session gets at least one sample, however short.

## Public sites (`--public N`, docs/adr/0007)

`--public N` makes N of the run's sessions (of **each batch** for `traffic`: its batch is
`min(concurrency, rate)` sessions) visit real public sites instead of the demo site: Wikipedia, MDN,
GOV.UK, Hacker News and the Python docs, with read-only journeys. The first N sessions of the batch are
the public ones, the others stay the demo `mix`. Each is recorded with `target: "public"` and its
`site` (`wikipedia`, `mdn`, `govuk`, `hackernews`, `python-docs`); every other session has
`target: "demo"`, `site: "demo-site"`. `source` is untouched (`real`).

- **Assignment** (`assignPublic`, `src/assign.ts`). Public sessions rotate round-robin over the sites
  that are not paused and over the engines (the site and the engine both move one step per session, so
  five sessions already cover five sites on mixed engines). `traffic` keeps counting across batches,
  so one public session per batch still visits every site in turn. `--routing` still applies; the
  journeys need no capability, so nothing is routed away.
- **Journeys** (`src/scenarios/public/journeys.ts`, descriptors in `sites.ts`), one per site:
  `wiki-read` (an article, then 2 or 3 internal links), `mdn-read` (a reference page, a sidebar
  link, a check that the page has a code example), `govuk-read` (a guide, then its next part),
  `hn-read` (the front page, then one story's comments) and `pydocs-read` (a manual's index, then
  a page of it). The seeded rng picks the pages from a per-site **allowlist** of real pages; links a
  journey follows must be on the site's host and allowed by robots.txt. They use only the
  collector-wrapped page.
- **No fingerprint changes.** A public session opens its page with the same `openPage` as a demo
  session: no user agent, header or locale override, no init script. The engines are measured as they
  are (a test fails if the runner or a journey sets one). The trade-off is in the ADR.
- **robots.txt.** At the start of a run (`traffic`: also every 6 hours) the runner fetches each site's
  `robots.txt` with Node's `fetch` and applies the `*` group (longest rule wins, Allow wins a tie,
  `*` and `# @fleetscope/fleet-runner

Runs real browser sessions and reports them. Each session gets its own Docker container for one
engine (chromium, chrome-headless-shell or lightpanda) plus a small forwarder sidecar, a scenario
drives the browser through `@fleetscope/collector`, and the runner adds the numbers only Docker can
give (CPU, memory, network). Then both containers are removed.

```
pnpm infra:up && pnpm db:migrate && pnpm browsers:build && pnpm browsers:pull   # once
pnpm --filter @fleetscope/api dev                            # :4000
pnpm --filter @fleetscope/demo-site dev                      # :3100
pnpm fleet run --engines chromium,chrome-headless-shell,lightpanda --sessions 9 --concurrency 3
```

## Engines

The table is `src/engines.ts`, one entry per `ENGINES` value.

| engine | image (override) | port | ready when | connect |
|---|---|---|---|---|
| `chromium` | `fleetscope/playwright-chromium:1.64.1-2` (`FLEET_BROWSER_IMAGE_CHROMIUM`, old name `FLEET_BROWSER_IMAGE`) | 3000 | `GET /` 2xx | `chromium.connect(ws://...)`, Playwright's server launches Chromium |
| `chrome-headless-shell` | `chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423` (`FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL`) | 9222 | `GET /json/version` 2xx | `connectOverCDP(http://127.0.0.1:<port>)` |
| `lightpanda` | `lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9` (`FLEET_BROWSER_IMAGE_LIGHTPANDA`) | 9222 | `GET /json/version` 2xx | `connectOverCDP(ws://127.0.0.1:<port>/)` |

Every session opens a fresh context with `browser.newContext()` and one page (Lightpanda allows one
context and one page per CDP connection). If an engine refuses viewport emulation the page runs with
its default viewport (logged).

**Forwarder sidecar.** The browsers open the demo site as `http://localhost:3100`. For every engine
the runner starts, next to the browser, a container from `FLEET_FORWARDER_IMAGE`
(`fleetscope/forwarder:1-1`) with `NetworkMode: container:<browser>`: it shares the browser's
`localhost` but not its cgroup, so the forwarder's memory is never in a session's samples. It has the
same `fleetscope.*` labels plus `fleetscope.role=forwarder` (the browser has `role=browser`).
`startup_ms` is browser create to browser ready; the sidecar starts alongside, must be listening
before the scenario starts, and is not counted. Teardown: sidecar first, then the browser. If the
sidecar finds the port taken (an old chromium image with its own forwarder) that is accepted; any
other sidecar failure is an `infra_error`. The stats sampler reads the browser container only.

**Chromium's memory includes Playwright's `run-server`.** The chromium container runs a Node.js
process next to Chromium; the CDP engines have only the browser. Measured on Docker Desktop (image
`1.64.1-2`): the container alone, before any client connects, reads about 114 MiB (the stats figure;
anon 111 MiB), and that is the Node process (RSS 162 MiB, 165 MiB with a 20 000-node `/heavy` page
loaded; RSS also counts shared library pages). So chromium's "peak memory" is about 110 MiB higher
than the same Chromium run over CDP. Running chromium over CDP like the others is planned for M4.

**What Lightpanda does not provide** (recorded, never faked): no `Performance.getMetrics`, so every
`cdp` sample has `js_heap_mb = null` ("not available"); no `*ExtraInfo` network events, so request
sizes and timing fall back to what Playwright can see; its `Browser.getVersion` pretends to be a
Chrome, so `engine_version` is its own `Lightpanda-Version` from `/json/version`. A CDP method it
lacks fails the action with `unsupported_feature`; a missing page API is an `unsupported_api` issue.
Its `/js-heavy` Web Worker probe times out (`webWorker: timeout after 3000ms`): that is a `timeout`
(issue and session status), not an unsupported-API claim, because a timeout does not prove absence.

## Commands

```
pnpm fleet run [--engines chromium] [--sessions 10] [--concurrency 4]
               [--scenario mix|login-and-search|checkout-form|heavy-page-crawl]
               [--seed N] [--agent ID] [--routing fixed|by-scenario] [--session-timeout 120]
               [--public N] [--state-file PATH]
pnpm fleet traffic [--engines chromium] [--rate 3] [--concurrency 2] [--duration 10m] [--agent ID]
               [--scenario ...] [--seed N] [--routing fixed|by-scenario] [--session-timeout 120]
               [--public N] [--state-file PATH]
pnpm fleet cleanup          # remove every container labelled fleetscope.session (all runs)
```

**Fair assignment.** With N engines every scenario runs on every engine: session `i` takes
`pairs[(seed + i) mod (scenarios x engines)]` over (scenario, engine) pairs, so each block of
`scenarios x engines` sessions covers every pair once (`src/assign.ts`). A fixed `--scenario` cycles
the engines.

**Routing (`--routing fixed|by-scenario`, default `fixed`).** `fixed` runs every session on the
engine it was assigned, which is what you want when measuring each engine on every scenario (a
Lightpanda `heavy-page-crawl` then fails, honestly). `by-scenario` moves a session off an engine that
lacks something its scenario needs: `SCENARIO_NEEDS` (`src/scenarios/index.ts`) says what a scenario
needs (`heavy-page-crawl`: `webWorker`), `ENGINE_SPECS[engine].lacks` what an engine is verified not to
have (Lightpanda: `webWorker`, see `docs/adr/0005`), and `routeSession` (`src/assign.ts`) picks the
first capable engine of the run's `--engines` in the order `lightpanda`, `chrome-headless-shell`,
`chromium`. If no engine of the run is capable the session stays where it was assigned (and fails) and
the runner logs a warning once per run.

A routed session is recorded honestly: `session.started.routed_from` / `sessions.routed_from` is the
engine the assignment chose, while `engine` (and everything keyed by it: memory, cost, success rate)
is the engine that **actually ran** it. So per-engine numbers count where the session ran, never
where it was meant to run. The summary shows `chrome-headless-shell (from lightpanda)` in the engine
column and a `routed: N of M sessions` line. Routing happens after the fair assignment, so a routed
run has more sessions on the capable engine than a `fixed` one.

**`fleet traffic`** keeps sessions coming at `--rate` sessions per minute (default 3) with at most
`--concurrency` at once (default 2), in batches of `min(concurrency, rate)` sessions. It prints one
line per batch, runs until Ctrl+C or `--duration` (`90s`, `10m`, `2h`), and stops like `run` does
(same debounce, same cleanup, then the summary). Events go to `FLEETSCOPE_API_URL` with agent
`traffic@<host>` unless `--agent` is given. If sessions take longer than the batch period the next
batch starts at once, so the real rate is lower than asked; the batch durations show it.

The summary table has the engine and the time to a usable browser (`startup + connect`) per session,
and per-engine totals at the end.

Environment (from `.env`): `FLEETSCOPE_API_URL`, `DEMO_SITE_URL` (the runner's own checks),
`DEMO_SITE_BROWSER_URL` (what the browser opens, default `http://localhost:3100`, reached through
the forwarder sidecar), `DEMO_SITE_UPSTREAM` (given to the sidecar), `FLEET_BROWSER_IMAGE_CHROMIUM`,
`FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL`, `FLEET_BROWSER_IMAGE_LIGHTPANDA`,
`FLEET_FORWARDER_IMAGE`, `DOCKER_HOST`, `LOG_LEVEL`.

Exit codes: `0` ok, `1` a problem (preflight failed, a browser never came up, events were dropped),
`2` wrong command line, `130` interrupted.

## One session

1. **Preflight**, before anything starts: API `/healthz`, the demo site, Docker, the image. All
   problems are listed at once.
2. Create the browser container (labels `fleetscope.session`, `fleetscope.run`, `fleetscope.engine`,
   `fleetscope.role`) and the sidecar, wait until the browser answers its readiness check over
   HTTP: `startup_ms`.
3. Connect: `connect_ms`. With chromium the Playwright server launches Chromium for the client, so
   this **includes the browser launch**; compare engines on `startup_ms + connect_ms` (the
   summary's "to browser" column).
4. `session.started`, then Docker's stats stream and the scenario run side by side.
5. Last stats sample, `session.ended`, close the browser, remove the container. If the browser never
   came up there is nothing to report (no timings), and the summary shows `infra_error`.

Status of a session: `success`; `blocked` (403 or captcha, on a goto or a click); `timeout` (an action,
or `--session-timeout`); `crashed` (the browser went away by itself); `failed` for anything else,
including Ctrl+C (`reason: interrupted`). The reason is never empty.

## What the container numbers mean

`resource.sample` with `origin: container`, from Docker's stats **stream** (one frame about every
second over one connection), one sample every 2 s, plus a last one when the session ends:

- **CPU %** is Docker's own figure for the second before the frame (`cpu_delta / system_delta * cpus *
  100`), so 100 is one core. The first sample has no previous frame; it is the container's average
  since it started, which includes launching Chromium.
- **Memory MB** is usage minus the page cache (`inactive_file`, as `docker stats` shows).
- **Network bytes** are changes since the previous sample (the first counts from container start).
  They are **container** bytes, not page bytes: Playwright's control channel and every screenshot
  cross the same interface. Do not read them as "what the page downloaded"; `network_requests.bytes`
  is that, sampled 1 in 5.
- The forwarder is a sidecar in its own cgroup, so none of its memory or CPU is in these samples
  (before M3 about 10 to 17 MB of it were).
- A sample's `ts` is when its frame arrived. Every session gets at least one sample, however short.

 supported). An allowlisted path that is now disallowed is dropped; a site with no
  allowed path is skipped for the run with one log line; a robots.txt that cannot be read (5xx,
  network error) also skips the site. A Crawl-delay longer than ours is honoured.
- **Delay between pages** (`minDelayMs`): GOV.UK 10 s, Hacker News 30 s (its crawl-delay), the
  others 2 s, measured between the starts of two navigations of a session. The wait is not an
  `action` (it would pollute the latency numbers); the gap shows in the session's timeline.
- **Push-back pauses the site.** A 403, 429 or CAPTCHA ends the session `blocked` (429 is recorded as
  `http_403`, its message says 429), the site is written to `--state-file` as
  `{"<site>": <pausedUntil epoch ms>}` for an hour, and paused sites are skipped by the next
  sessions, also by other fleet processes that use the same file (it is read on every check). Without
  `--state-file` the pause lives only in this process. If no site is available the public sessions
  run on the demo site, with one warning.
- **`site_layout`.** A page that loads (HTTP 200) but has none of its landmark selectors (a primary
  and one fallback) fails the action with `site_layout`, session status `failed`: the site probably
  changed, which is not the browser's fault. A CAPTCHA page found in its place is `captcha` (blocked).
- **What an engine cannot do on a real site** is recorded as it happens (`unsupported_feature`,
  `unsupported_api`, `null` metrics), never routed around or faked.

The summary has a `target/site` column and a "By site" block. `pnpm fleet run --engines
chromium,chrome-headless-shell,lightpanda --sessions 10 --public 5 --state-file .fleet-state.json`
is the usual smoke run.

## Scenarios

`login-and-search`, `checkout-form`, `heavy-page-crawl` (`mix` goes round-robin, started by the
seed). Each is a function `(page: CollectedPage, ctx) => Promise<void>` using only the wrapper and the
demo site's documented `data-testid`s. Seeded chaos gives a run natural variety: `checkout-form`
starts at `/botwall?rate=0.2` (about one in five is blocked), `login-and-search` sometimes clicks the
flaky button (and fails the session if it is missing twice).

## Ctrl+C

- **First**: no new sessions; running ones end `failed` / `interrupted`; the queue is flushed; this
  run's containers are removed; the summary prints; exit 130.
- **Second, 2 s or more later**: stop waiting for running scenarios. Still-running sessions are ended
  as interrupted, the queue is flushed (up to 2 s), this run's containers are removed (up to 3 s).
- **Third**: exit at once. `pnpm fleet cleanup` removes whatever is left.
- Signals less than 2 s apart count as one interrupt. On Windows the console hands Ctrl+C to every
  process in the window, and wrappers pass it on too, so one keypress can arrive twice.
- The script runs `node --import tsx`, not the `tsx` command, so no extra process sits between the
  console and the runner.
- **Windows shells.** Use PowerShell or Git Bash. In **cmd.exe**, `pnpm` is a `.cmd` file, so every
  Ctrl+C asks "Terminate batch job (Y/N)?"; answer **N**, or the wrapper dies before the runner has
  cleaned up. Through pnpm the exit code is the wrapper's (for example `-1073741510`, Ctrl+C), not
  130. In PowerShell the pnpm wrapper also exits at once, so the prompt comes back while the runner
  finishes its cleanup in the background and its summary may not be shown; the data is still
  complete (checked on Windows: finished sessions stored, the running one `failed`/`interrupted`,
  no containers left). Run `pnpm fleet cleanup` afterwards if anything was left; a run only ever removes its own
  containers (label `fleetscope.run`), `cleanup` removes all.
- The runner prints `fleet run: starting...` the moment it starts and a `preflight` line before the
  checks, so a quiet start is a slow Docker or API, not a hung runner.

## Tests

`pnpm --filter @fleetscope/fleet-runner test`: everything runs without Docker (fake daemon, fake stats
stream, fake clock, a stub scenario page). QA's `real-run.e2e.test.ts`, `cli.test.ts` (cleanup) and
the stats load test need the real stack; see `qa/m1-report.md`.
