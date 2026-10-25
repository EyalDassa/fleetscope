# Public sites: review (first review)

Reviewer: senior reviewer. Branch `public-sites` at `97402ca`, diff `main...public-sites`. Timebox 25 min.
Read: CLAUDE.md, ADR 0007. Unit tests run on the branch: fleet-runner 304 passed / 26 skipped (e2e).
The `http_429` code being added now is not reviewed (in flight). Uncommitted files in the tree (`public.stub.e2e.test.ts`, `tools/live-traffic.ps1`) were not reviewed.
Lead decisions not reopened: no fingerprint/UA changes, the site list, `fleet_minute` panels showing "—" under a Target/Site filter, optional fields defaulted at storage, unreadable robots.txt means skip.

## What is good

- **Read-only holds.** Journeys only `goto` and read `href`s. Followed links must be https, on the site's own host, allowed by robots.txt and accepted by a tight per-site predicate (`/wiki/<no colon>`, `/item?id=`, the same manual, the entry's subtree, GOV.UK "next"). No click, no form, no consent banner. A test checks that no UA, header, locale or init script is set.
- **The `running` to `ended` carry is right.** `endedSessionRow` spreads the running row, and `findStoredSessions` now selects `target` and `site`, so an ended event that arrives in a later request keeps them. Migration 0010 is additive, `IF NOT EXISTS`, and gives old rows `demo` / `demo-site`.
- **The robots parser is correct for the `*` group:** grouping of consecutive `User-agent` lines, longest match, Allow wins a tie, `*` and `$`, an empty `Disallow`, and Crawl-delay. It is well tested, including against the saved robots.txt of every site.
- **Rotation (`assignPublic`) is correct.** The extra engine step avoids pinning a site to one engine, and it is tested with 3 sites and 3 engines.
- **`site_layout` vs CAPTCHA:** the challenge selector is checked before `site_layout` is reported. Real engine errors from `locator.count()` keep their own codes.
- **The filters cover every panel.** Every panel that reads `sessions` filters target and site in `picked`, using `$__conditionalAll`. The Site variable follows the agent/scenario pattern.
- **The canary is sound.**
  - Permissions are minimal (`contents: read`, `issues: write`). It runs only on schedule or by hand.
  - There is one issue per site, found by exact title, then a comment each day and an automatic close.
  - `fleet run` exits non-zero only on infra errors and dropped events, so "runner broke" and "site broke" are told apart correctly.

## Must fix

### RV-PS-01 Crawl delay and per-site concurrency are enforced per session only. Several sessions can hit one site at once. Owner: backend
`apps/fleet-runner/src/scenarios/public/journeys.ts:99` (`createPacer` per journey), `apps/fleet-runner/src/run.ts:99-120` (lane assignment), `options.ts` (`--public` up to 100 000; traffic up to 64 per batch).

The pacer lives inside one session. Nothing in the process stops two sessions from visiting the same site at the same moment, or one right after another. Concrete paths:
- `fleet run --sessions 50 --public 50 --concurrency 10` runs about 2 sessions per site at once. Hacker News then gets about 20 page loads in a few minutes, while its robots.txt asks for 30 s between loads.
- `fleet traffic --rate 60 --concurrency 20 --public 20` does the same in every batch, for hours.
- If 4 of the 5 sites are paused or skipped, `activeSites()` returns one site, so every public session of the batch hits that site at the same time.
  - That case follows a push-back, which is exactly when we should be gentlest.
- Batches follow each other with no gap per site, so a new Hacker News session can start seconds after the last one's final load.
- Even the canary sends 2 concurrent sessions to one site when one site's robots.txt is unreadable (5 sessions over 4 sites).

The ADR's "one visit every few minutes" is an assumption about the flags, not something the code guarantees.

**Fix:** Make pacing per site per process.
1. Create one pacer per site in `prepareSites` and put it on `SiteRun`, so every session of that site shares it.
2. Reserve the slot synchronously before awaiting, so concurrent callers queue: `const at = Math.max(now(), nextAt); nextAt = at + minDelayMs; await sleep(at - now())`.
3. Also allow at most one in-flight session per site. `activeSites()` leaves out sites that are busy; if no site is free, the session falls back to the demo site, as it already does.
4. Add a test: two concurrent sessions on one site never start navigations less than `minDelayMs` apart.

Two separate processes still add up. Document that in the ADR (see N7).

### RV-PS-02 The Public sites drill-down repeats `var-target` and `var-site`. Owner: dashboard
`infra/grafana/dashboards/fleetscope-browsers.json:2169`.

The link is `...&${target:queryparam}&${site:queryparam}&...&var-target=public&var-site=${__data.fields.site}`.
- With Site = `mdn,govuk` selected, clicking `wikipedia` opens Sessions filtered to three sites.
- With All selected it sends `var-site=$__all&var-site=wikipedia` (unsure how Grafana resolves that; at best it is ambiguous).

Every other link in the repo drops the queryparam of the variable it overrides (e.g. `var-engine=${__data.fields.engine}` without `${engine:queryparam}`).

**Fix:** remove `${target:queryparam}&${site:queryparam}&` from this link. Add the link to the link check if one exists.

### RV-PS-03 "Top cause" blames the site for what may be an engine gap. Owner: dashboard
`infra/grafana/dashboards/fleetscope-browsers.json:2557` (the Public sites SQL, `per_site.causes` / `top_cause`).

The causes are counted over all engines, and `site_layout` gets the suffix "· site changed". Suppose Lightpanda (or chrome-headless-shell) misses a landmark that Chromium finds, for example an element built by script or a partial DOM. The row then reads "Health (Chromium): Healthy" next to "site_layout ×12 · site changed". That blames the site for an engine gap, which is the opposite of what the panel's own description says a Chromium/other gap means.

**Fix:** add "· site changed" only when Chromium itself has `site_layout` in the range (`countIf(engine = 'chromium' AND cause = 'site_layout') > 0`). Otherwise show `site_layout ×N (not Chromium)`. Add a fixture case where only non-Chromium sessions have `site_layout`.

### RV-PS-04 The fleet-runner README is corrupted. Owner: backend
`apps/fleet-runner/README.md:170-310`.

The Public sites section stops mid-sentence ("`*` and `# @fleetscope/fleet-runner"). The whole earlier README is pasted in at that point, so Engines, Commands, One session and the container-numbers section each appear twice. The section then picks up again at line 311 (" supported). An allowlisted path...").

**Fix:** remove the pasted block and restore the sentence.

## Nits

- **N1 (backend) The pause store under concurrent processes or failure.** `scenarios/public/pause.ts:232-243`, `run.ts:170`.
  - Two processes that pause different sites at the same moment can lose one update. The read-modify-write is not locked; the window is small.
  - Worse: if the write throws (for example EPERM on rename on Windows, or an antivirus lock), the error leaves `lane()`, `runFleet` rejects and a long `traffic` loop dies.
  - The file-backed store keeps no copy in memory, so a failed write also leaves the site unpaused in this process.
  - Fix: keep a map in memory and merge it with the file (the later `until` wins), and catch the write error and log it as a warning.
- **N2 (backend) Pauses are forgotten between runs without `--state-file`.** A loop of `fleet run --public N` (the `tools/live-traffic.ps1` pattern) forgets every pause between runs. `.gitignore` already lists `.fleet-state.json`. Default `--state-file` to it when `--public > 0`, or at least log a warning.
- **N3 (backend) A site paused at preparation stays out too long.** `prepareSites` leaves out a site that was paused when it ran, without reading its robots.txt. In `traffic` that site stays excluded until the 6 h refresh, although its pause ends after 1 h. This is conservative, not unsafe. Fix: prepare every site and leave paused ones to `activeSites()`.
- **N4 (platform) Canary report:**
  - The "blocked" hint can never show. `hint_for "${code:-$status}"` (`public-canary-report.sh:164`) receives `http_403` or `captcha` for a blocked session, so the "don't work around it, decide whether to drop the site" text never appears. Choose the hint from the status first for `blocked` and `timeout`.
  - Strip backticks from `short_reason` (line 163). Reason text that contains a code fence would break out of the code block, and any `@mention` after it would then notify.
  - A single transient failure (`nav_error`, `http_5xx`) opens an issue. That is acceptable, because it closes itself the next day. Consider opening only after 2 failures in a row (unsure it is worth the state).
- **N5 (dashboard) Public sites honesty details.**
  - The Health mapping has a `blocked` entry, but the SQL never produces it, so a site that blocks us reads "✕ Failed". Produce `blocked` when most of the Chromium sessions are blocked, or remove the mapping.
  - Health from 1 or 2 Chromium sessions can flip to Failed. Consider showing "—" below a minimum count (the count is in the next column, so this is minor).
- **N6 (backend) A UTF-8 BOM hides the first `User-agent` line.** `robots.ts:42`: if robots.txt starts with a BOM, the first line's field is `﻿user-agent` and is ignored. Strip `^﻿` from the text first.
- **N7 (backend/lead) The ADR should state the limits of pacing.** After RV-PS-01, pacing is per process. Two fleet processes (or a traffic loop plus a manual run) each pace on their own, and only the pause file is shared. Say so in ADR 0007.
- **N8 (backend) Docs to update with `http_429`.** When `http_429` lands, update `packages/db/README.md` ("`http_403` also covers a public site's 429"), the comment in `packages/schema/src/codes.ts`, and the comment in `collector/src/page.ts:421`. The fleet-runner README already says `http_429`.

## Verdict

**Request changes:** RV-PS-01 (politeness: per-site pacing and concurrency), RV-PS-02 (drill-down link), RV-PS-03 (honesty of Top cause), RV-PS-04 (corrupted README). The nits can follow.

## Round 2

Re-checked only the round-1 items, at `15f165c` (fixes in `15f165c`, `0d22081`, `475df0e`, `ff1bebd`, `e350346`). Fleet-runner unit tests: 312 passed / 26 skipped.

- **RV-PS-01: resolved.**
  - `pacer.ts` holds one pacer per site, created by `prepareSites` and kept on `SiteRun`. Callers form a promise queue. Each waits for the previous caller's real start plus `minDelayMs`. A caller that was cut off hands the last real start on.
  - `traffic` passes one `pacers` map across robots refreshes, so the gap also holds between batches.
  - `busySites` in `runFleet` allows one session per site at a time and is released in `finally`. When no site is free, the session falls back to the demo site with one warning.
  - Tests cover queued callers, the gap from one session to the next, two concurrent sessions on one site, and the "4 of 5 paused" case.
- **RV-PS-02: resolved.** The link no longer carries `${target:queryparam}&${site:queryparam}`.
- **RV-PS-03: resolved.** "· site changed" appears only when `chromium_layout > 0`; otherwise the cell reads "(not Chromium)".
- **RV-PS-04: resolved.** The README has a single set of sections and the Public sites section is whole.
- **N1: resolved.** The pause store keeps its state in memory, merged with the file (the later pause end wins). A failed write only logs a warning.
- **N2: resolved.** `--state-file` defaults to `.fleet-state.json`.
- **N3: not addressed.** It errs on the safe side; fine to leave.
- **N4: resolved.**
  - The hint is chosen from the error code first, so blocked sessions get the "don't work around it" hint.
  - Backticks are stripped from the reason and the code.
  - An issue opens after 2 failing runs in a row. The streak is carried in the Actions cache: a unique key per run, `restore-keys` by prefix, and the old streak is kept if the report itself failed.
- **N5: resolved.** Health shows Blocked when most Chromium sessions were blocked, and "Not enough data" below 3 Chromium sessions.
- **N6: resolved.** One remaining nit: the BOM in the regex is a literal invisible character (`/^<U+FEFF>/` as raw bytes). Write it as `/^﻿/` so a reader can see it.
- **N7: resolved.** The ADR now says pacing is per process and to run one public-site process at a time.
- **N8: resolved** (`e350346`).
  - `http_429` is in `ERROR_CODES` and maps to a `blocked` issue.
  - The collector, `BlockedError` and the db README are updated.
  - The Public sites panel and the canary count it as push-back.

**Verdict: approve with nits.** Remaining nits: N3, and the N6 escape. Nothing is disputed.
