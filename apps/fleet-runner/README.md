# @fleetscope/fleet-runner

Runs real browser sessions and reports them. Each session gets its own Docker container with
Playwright's server and Chromium, a scenario drives it through `@fleetscope/collector`, and the
runner adds the numbers only Docker can give (CPU, memory, network). Then the container is removed.

```
pnpm infra:up && pnpm db:migrate && pnpm browsers:build      # once
pnpm --filter @fleetscope/api dev                            # :4000
pnpm --filter @fleetscope/demo-site dev                      # :3100
pnpm fleet run --engines chromium --sessions 10 --concurrency 4 --scenario mix
```

## Commands

```
pnpm fleet run [--engines chromium] [--sessions 10] [--concurrency 4]
               [--scenario mix|login-and-search|checkout-form|heavy-page-crawl]
               [--seed N] [--agent ID] [--session-timeout 120]
pnpm fleet cleanup          # remove every container labelled fleetscope.session (all runs)
```

`--seed` makes the scenario order, the pages and the chaos repeat exactly (a random seed is printed
at the start). Only `chromium` exists until M3. Environment (from `.env`): `FLEETSCOPE_API_URL`,
`DEMO_SITE_URL` (the runner's own checks), `DEMO_SITE_BROWSER_URL` (what the browser opens, default
`http://localhost:3100`, reached through a forwarder in the image), `DEMO_SITE_UPSTREAM`,
`FLEET_BROWSER_IMAGE`, `DOCKER_HOST`, `LOG_LEVEL`.

Exit codes: `0` ok, `1` a problem (preflight failed, a browser never came up, events were dropped),
`2` wrong command line, `130` interrupted.

## One session

1. **Preflight**, before anything starts: API `/healthz`, the demo site, Docker, the image. All
   problems are listed at once.
2. Create the container (labels `fleetscope.session`, `fleetscope.run`, `fleetscope.engine`), wait
   until Playwright's server answers over HTTP: `startup_ms`.
3. `chromium.connect`: `connect_ms`. The server launches Chromium for the client, so this **includes
   the browser launch**; compare engines on `startup_ms + connect_ms`.
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
- The container also holds the small Node forwarder of the browser image (`localhost:3100` to the
  host). Its memory and CPU are in every sample: about 10 to 17 MB, measured in
  `infra/browsers/README.md`. It moves to a sidecar in M3.
- A sample's `ts` is when its frame arrived. Every session gets at least one sample, however short.

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
  130. Run `pnpm fleet cleanup` afterwards if anything was left; a run only ever removes its own
  containers (label `fleetscope.run`), `cleanup` removes all.
- The runner prints `fleet run: starting...` the moment it starts and a `preflight` line before the
  checks, so a quiet start is a slow Docker or API, not a hung runner.

## Tests

`pnpm --filter @fleetscope/fleet-runner test`: everything runs without Docker (fake daemon, fake stats
stream, fake clock, a stub scenario page). QA's `real-run.e2e.test.ts`, `cli.test.ts` (cleanup) and
the stats load test need the real stack; see `qa/m1-report.md`.
