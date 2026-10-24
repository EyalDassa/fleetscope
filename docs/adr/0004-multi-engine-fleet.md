# ADR 0004: Three browser engines, a forwarder sidecar, and honest gaps

- Status: accepted (2026-10-24, M3)

## Context

M3 adds chrome-headless-shell and Lightpanda next to Chromium so the Browsers dashboard can compare them per scenario. The comparison is only worth something if it is fair (same scenarios, same measurement) and honest (an engine's missing feature shows as missing, not as a number or a success).

## Decisions

1. **One pinned image per engine, unmodified where possible.**
   - Chromium is our Playwright server image (`fleetscope/playwright-chromium:1.64.1-2`, connected with `chromium.connect`).
   - The other two are upstream images pinned exactly: `chromedp/headless-shell:156.0.8078.48` (same Chromium major as Playwright 1.64.1) and `lightpanda/browser:1.0.2` (its latest stable release; Lightpanda has no LTS line). Both are connected with `connectOverCDP`: over http for headless-shell, and over ws for Lightpanda, whose `/json/version` advertises its in-container port.
   - An engine table (`apps/fleet-runner/src/engines.ts`) holds image, port, readiness path and connect mode; CI checks the pins agree everywhere.
2. **The demo-site forwarder is a sidecar container in the browser's network namespace** (`NetworkMode: container:<browser>`), not a process inside the browser image.
   - Every engine needs `localhost:3100` for a secure context, and the upstream images can't host our forwarder.
   - The sidecar's ~17 MB is now outside every browser's cgroup, so memory compares engines, not our plumbing (it took ~10–12 MB out of each Chromium sample).
   - Cost: two containers per session; the runner removes the sidecar first.
3. **Fair assignment.** With N engines, every block of sessions covers every (scenario, engine) pair. Before M3, engine and scenario advanced in lock-step, so each engine would only ever have run one scenario.
4. **Gaps are recorded, never faked.**
   - Lightpanda's missing `Performance.getMetrics` gives `js_heap_mb = null` ("Not available").
   - A feature an engine refuses (CDP method not found, screenshot, viewport) fails the action with `unsupported_feature`.
   - A Web API missing in the page is an `unsupported_api` issue. That needs evidence of absence: a ReferenceError, or a TypeError naming a known API.
   - **A failed `/js-heavy` probe fails the session** (`heavy-page-crawl`), with the failing probes in the issue message. Otherwise the compatibility matrix would show a success that isn't one.
     - The probe's error decides the code. An absent API is `unsupported_api`. A probe that never answers is `timeout`, because a timeout cannot prove the API is missing. Anything else is `js_error`.
     - Example, Lightpanda 1.0.2: `Worker` exists but the worker never answers, so the session ends `timeout` with "webWorker: timeout after 3000ms". The matrix shows that cell as failing, with the reason.
5. **Chromium's memory is not quite like for like (known, M4).**
   - Our Chromium image runs Playwright's Node `run-server`, which launches Chromium. Its ~110 MB (measured idle on Docker Desktop, about the same with `/heavy` loaded) is inside the Chromium container's cgroup, and the CDP engines don't have it.
   - The Browsers dashboard says so.
   - Running Chromium with plain CDP, like the other two, removes it. That is planned for M4.
6. **Time to a usable browser = `startup_ms + connect_ms`.** Chromium launches inside `connect_ms` and the CDP engines inside `startup_ms`, so only the sum compares.
7. **Simulator with calibrated profiles and labelled priors.**
   - `apps/simulator` generates `source: "sim"` sessions from a profile computed from real sessions (`pnpm sim calibrate`).
   - An engine with fewer than 10 real sessions uses documented priors (`basis: "prior"`) until enough real runs exist. After the M3 real run (10 sessions per engine), all three engines are `basis: "measured"`.
   - Simulated session ids are random (`sim-<uuid>`); the seed fixes everything else.
   - The error-code vocabulary (`ERROR_CODES`, `ISSUE_FOR_CODE`) lives in `packages/schema`, shared by the collector and the simulator.

## Consequences

- The Browsers dashboard compares like with like, and Lightpanda's real strengths (memory) and gaps (Web Workers, JS heap) both show.
- More moving parts per session (sidecar), and upstream images can change behaviour on a bump, so pins are bumped deliberately.
- Simulated numbers for an engine are only as good as its profile basis; the profile records which basis each engine used.
