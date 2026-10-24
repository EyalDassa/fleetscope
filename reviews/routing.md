# Routing by scenario: review (first review)

Reviewer: senior reviewer. Branch `routing-by-scenario` at `78d60ec`, diff `main...routing-by-scenario` (screenshots looked at only through QA's report). Timebox 35 min.
Read: CLAUDE.md, ADR 0005, `qa/routing-report.md` (QA-RT-01..03 are being fixed by their owners and are not repeated here; their work in progress is uncommitted in the working tree and was not reviewed).
Unit tests run on the branch: fleet-runner 248 passed / 20 skipped (e2e), grafana-tools 256/256. QA ran lint, typecheck and the integration suites.
Lead decisions not reopened: static capability table, `fixed` as default, routed sessions count under the engine that ran, retry fallback deferred, solid lines.

## What is good

- `routeSession` is pure, small and well tested; the "no capable engine" case runs as assigned and warns once per engine/scenario (shared set across `fleet traffic` batches). `routedFrom` is set only when the engine actually changed.
- Running to ended carry of `routed_from` is right: `endedSessionRow` spreads the running row, and `findStoredSessions` now selects `routed_from`, so an ended event in a later request keeps it (QA covers it over HTTP and after a flush). Migration 0009 is additive, `IF NOT EXISTS`, `LowCardinality(Nullable(String))`, NULL for old rows.
- Schema: `routed_from: Engine.nullish()` lives only in `packages/schema`; the collector sends the key only when routed, so unrouted events are byte-identical to before.
- Data honesty: `engine` is always the engine that ran; routed sessions show in the summary (`chrome-headless-shell (from lightpanda)`, `routed: N of M`), the Sessions "Routed from" column and filter, the Session engine stat, and the Browsers stat. The stat follows the Engine comparison's rules (`sessions FINAL`, interrupted excluded, bounded by the time range).
- Push: folder access uses the per-role `builtInRoles/:role` endpoint, so user and team grants are never replaced; access is read back (idempotent, tested); extra user/team grants are reported, not removed; the team folder's contents are never listed or written; a repo uid found in the team folder is refused even with `--force`. Errors carry the path and Grafana's message, never the `Authorization` header; the ClickHouse password stays masked.
- `grafana:check` solid-line and shared-colour rules are simple and tested.

## Must fix

### RV-RT-01 The drift guard refuses an official dashboard again after its pull was merged. Owner: platform
`infra/grafana/src/push.ts:477-503`, `infra/grafana/src/drift.ts` (`driftVerdict`), `infra/grafana/src/pull.ts:170`.
The guard decides from `meta.updatedBy` only. Scenario: Alice edits `fleetscope-overview` in Grafana; push refuses; we `grafana:pull fleetscope-overview`, merge it; push now finds the repo equal to Grafana, says `unchanged`, and does **not** save, so `updatedBy` stays `alice`. The next ordinary repo change to that dashboard is `updated` + `updatedBy=alice` and is refused again, forever, until someone runs `--force`, which is global and would also discard any other dashboard's real UI edits made in the meantime. The pull reminder ("then pnpm grafana:push stops refusing it") is therefore wrong after the first later change.
**Fix:** when the repo equals Grafana (`action === "unchanged"`) and `verdict.refuse` is true, re-save the dashboard once (POST `/api/dashboards/db` with the same body, `overwrite: true`) so `updatedBy` becomes the push's account; log it as `adopted` (dry run: `would adopt`). Add a test with fake-grafana: foreign save, pull, push (adopted), repo change, push (updated, not refused, no `--force`).

### RV-RT-02 The access model has not run against a real Grafana. Owner: platform
`infra/grafana/src/folder-access.ts`, `drift.ts`, `push.ts:401`; QA skipped "Grafana folder permissions" by agreement, and every test uses `fake-grafana.ts`, which encodes our assumptions about Grafana's responses.
The risky assumptions only show on a real server: (a) `GET /api/user` with a service account token returns the SA and its `login` equals `meta.updatedBy` on dashboards it saved (on Grafana Cloud with unified storage I am **unsure** what the legacy `meta.updatedBy` holds for a service account). If it does not match, every changed official dashboard is refused on every push (fail-safe, but push then always exits 1 and `--force` becomes routine). (b) The `Admin` built-in role row: whether Grafana lists it and accepts `POST .../builtInRoles/Admin`. If not, push fails or reports "updated" on every run. (c) Editors really lose edit on the official folder after the lock (no basic-role grant that bypasses it).
**Fix:** before merge, run and paste into the PR: two real `pnpm grafana:push` runs against local Grafana OSS (second run: folder lock, team folder, team access and every dashboard `unchanged`); `GET /api/access-control/folders/fleetscope` showing Viewer View / Editor View / Admin Admin; an Editor login trying to save an official dashboard (expect denied) and saving in "Team dashboards" (expect allowed); then a Grafana Cloud `--dry-run` showing the token's identity resolved and no unexpected `REFUSED` or `lock ... would updated`. If (a) fails on Cloud, match on the SA's id (`meta.updatedById` if present) instead of the login.

## Nits

- **N1 (platform)** `--force` is all or nothing. `--force <uid>` (repeatable) would let you discard one drifted dashboard without discarding another. `infra/grafana/src/cli/push.ts`.
- **N2 (platform)** `identityFrom` treats the token's `name` and `email` as "me" too (`drift.ts:17`), but `updatedBy` is a login. A human whose login equals the SA's display name would be exempt from the guard. Compare `login` only.
- **N3 (platform)** Team folder access is enforced on every push (Viewer View, Editor Edit). If an admin narrows it on purpose (e.g. hide drafts from Viewers), push widens it back. Say this in `infra/grafana/README.md` ("push owns the role rows of both folders; use user/team grants for exceptions").
- **N4 (backend)** `LIGHTNESS_ORDER` (`apps/fleet-runner/src/assign.ts:45`) is a plain `Engine[]`; a new engine added to `ENGINES` is silently never a routing target. Derive it from a field on `ENGINE_SPECS` or add a test that it contains every engine.
- **N5 (backend)** The schema accepts `routed_from` equal to `engine` (QA note). A `.refine` on `SessionStartedEvent` (`packages/schema/src/events.ts:195`) would make "routed" always mean "moved".
- **N6 (backend)** The Perfetto process name (`apps/api/src/trace/build-trace.ts:262`) does not mention routing; adding `(routed from lightpanda)` would make "visible everywhere" literally true. Not misleading as is.

## Verdict: request changes

Must fix: RV-RT-01 and RV-RT-02 (both platform, both in the Grafana access model). The routing, schema, db, collector, summary and dashboard parts are approved; with QA-RT-01..03 closed they need no further changes from me.
