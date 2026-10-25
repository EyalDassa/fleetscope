# QA report: public sites (branch `public-sites`), targeted

Scope: the 6-item checklist from the lead. No real site was contacted; real browsers visited a local stub only.

## Tests added (test files only)
- `apps/fleet-runner/src/public.stub.e2e.test.ts` (10 tests; the 6 with browsers are opt-in, `FLEET_E2E=1`, the 4 robots tests run in the normal suite).
  - Real containers (chromium, lightpanda) run `runFleet` -> `runSession` -> the real `wiki-read` journey against a local stub (`host.docker.internal:<port>`) that records raw request headers.
  - Real HTTP robots.txt stub for `prepareSites`/`fetchRobots`.
- `packages/db/src/dashboards.target.integration.test.ts` (22 tests): Overview and Browsers, every query, Target = All vs Demo vs Site = demo-site, on the hand-computed known fleet written without `target`/`site`.

## Results per checklist item
1. **No fingerprint override: PASS.** One public session per engine, success.
   - chromium wire UA: `Mozilla/5.0 (X11; Linux x86_64) ... HeadlessChrome/156.0.8078.4 Safari/537.36`; headers: `host, connection, upgrade-insecure-requests, user-agent, accept, accept-encoding`.
   - lightpanda wire UA: `Lightpanda/1.0`; headers: `host, accept-encoding, user-agent, sec-ch-ua, sec-ch-ua-full-version-list, accept-language, accept` (the engine's own defaults).
   - No `x-*`, authorization, referer, from or cookie header on either engine.
2. **Pause on push-back: PASS** (chromium and lightpanda).
   - 429: session `blocked`, goto action `error_code = http_429` (already committed), issue kind `blocked`. The state file holds `wikipedia` = now + 1 h (within +-60 s). The next `runFleet` assignment skips the paused site (falls back to the demo site; the spec's site is not `wikipedia`).
   - CAPTCHA page (200 with a captcha iframe): `blocked`, `error_code = captcha`, site paused.
3. **robots skip: PASS.** A `Disallow: /` robots.txt skips all 5 sites, one warn line per site. A 500 robots.txt and a connection error also skip. A 404 means allow all. A partial Disallow drops that path and keeps the site. `Crawl-delay: 45` raises `minDelayMs` to 45 s.
4. **Crawl delay: PASS.** Backend's local data, `site='hackernews'`: 5 sessions, all success. The gap between the two `goto`s is 30,006 to 30,012 ms (30,010 / 30,006 / 30,012 / 30,009 / 30,011). All are >= 30 s.
5. **Demo numbers unchanged: PASS with one finding (B1).**
   - `pnpm grafana:check`: all 5 dashboards and 2 alert groups OK, 90 queries executed.
   - Old rows (no `target`/`site` in the event): stored `demo` / `demo-site`. The local DB also shows only `demo`/`demo-site` for the 1,336 old and new demo sessions, and 25 `public` sessions over the 5 sites.
   - Overview and Browsers, all queries: Target = All, Target = Demo site, Site = demo-site and both together return identical rows, **except the 6 panels that read the per-minute rollup** (B1). Target = Public over a range with no public session shows 0 sessions.
6. **Canary script: PASS.** `.github/scripts/test-public-canary-report.sh` reports "OK: ... decisions are as expected" (all 10 cases).

## Bugs and findings
- **B1 (minor, design limitation, owner: dashboard / backend, `infra/grafana/dashboards/fleetscope-{overview,browsers}.json`, `fleet_minute` view).**
  - Repro: Overview or Browsers over a range with demo data only; set Target = Demo site (or Site = demo-site).
  - Expected (checklist): same numbers as Target = All.
  - Actual: the 6 panels that read `fleet_minute` lose their rollup numbers, because the rollup has no `target`/`site` column. Fleet verdict `p95_ms`, By engine `p95_ms`/`cpu_pct`, Engine comparison `action_p95_ms` become null. Actions per minute, p95 action latency and Memory per container return no rows. Example: verdict p95 500 ms (All) vs null (Demo).
  - This is documented (DESIGN.md "Rollup panels and Target / Site", and the panel descriptions), and the default is All, so default views are unchanged. But "Demo site" is the filter someone picks to see the old numbers, and it empties the p95 and CPU. Decide: accept, or add `target`/`site` to the rollup. Minimum fix if accepted: show "not available while filtered" text instead of an empty panel. The new test pins today's behaviour: if the rollup gains the columns, update `ROLLUP_PANELS`.
- No blocker or major bugs.
- Side note: 2 of 25 local public sessions failed with `site_layout` (mdn on chrome-headless-shell: missing `pre | .code-example` on the Global_Objects index page; wikipedia on chromium: the link landmark on Transport_Layer_Security). The error code works as designed. The canary will show whether the descriptors need a tweak.

## Verdict
**Ready to merge**: no open blocker or major bug. B1 is a minor, documented design limitation for the lead to accept or schedule.
