# QA report: M0 walking skeleton

Branch `m0-walking-skeleton`, first QA pass. Environment: Windows 11, Git Bash, Node 22.17, pnpm 12, Docker Desktop, ClickHouse 26.8.34.13 (the pinned compose image).

Tested against the "done when" column of the PR table and PLAN.md sections 5, 6, 9 and 11, not against what the code happens to do. Known pending change (not filed): `resource.sample` metrics that a sample cannot measure become `null` (PLAN section 5); the schema still requires cpu/mem/net.

## Verdict, first pass (superseded by the re-test verdict at the end): NOT READY

Every M0 "done when" is met and CI on the PR is green. Two **major** bugs are open. Both are cheap to fix and both sit exactly on the path M1 builds on (batch ingest), so they are better fixed now:

- **QA-M0-01** `insertEvents` fails outright for a realistic batch of `session.ended` events.
- **QA-M0-02** the schema accepts a `ts` that ClickHouse cannot store, so one bad event fails a whole batch.

Everything else is minor or a nit.

## Done-when check

| Task | Result |
|---|---|
| P1 root: install, lint, typecheck, test | pass (`pnpm lint && pnpm typecheck && pnpm test`) |
| P2 ClickHouse in Docker | pass. `infra:down` then `infra:up` 2.7 s + 6.5 s, healthy; data survives a restart (9 actions before and after); `down -v` then `up` + `db:migrate` + `db:seed` from scratch works; ports bound to 127.0.0.1 |
| P3 CI | pass, all jobs green on the PR (`gh pr checks 1`: Lint/typecheck/unit 18 s, Integration 57 s, gitleaks 17 s, GitGuardian pass, Claude jobs skipped). Run was on the commit before my tests; the new tests have not run in CI yet |
| P4 web builds | pass (`pnpm --filter @fleetscope/web build`). Vercel deploy is Eyal's manual step, not tested |
| B1 schema | pass, with the bugs below |
| B2 migrations + runner | pass: 5 tables with the right engines, partition key, order key and TTL; idempotent; edit and missing-file detection; seed repeatable |
| B3 `/healthz` | pass: 200 / 503 as specified, 503 in about 10-20 ms with ClickHouse stopped, recovers on its own when ClickHouse returns (no API restart), the bundled `dist/server.js` serves it too |
| B4 ADR | not tested (docs; reviewer's area) |

## Tests added

All new tests are separate `*.edge*.test.ts` files next to the existing ones; no existing test was modified. Unit tests need no Docker; integration tests use `createTestDatabase()`, with fixtures at "now" because of the 30 day TTL.

| File | Kind | What it covers |
|---|---|---|
| `packages/schema/src/events.edge.test.ts` | unit, 48 tests | wrong `v`, bad uuid, negative / float / NaN / huge `ts`, id and text length boundaries (128 / 2000), empty strings, unknown engine and source (case too), bad discriminator, `__proto__`, extra fields (stripped, recorded), per-type invalid values, `js_heap_mb` null vs omitted vs `undefined`, batch of 1 / 1000 / 1001, mixed valid/invalid batch with error paths, observations |
| `packages/db/src/insert.edge.test.ts` | unit | ms padding, epoch, year 9999, UTC independence, throw on unrepresentable `ts`, `js_heap_mb` null / 0 / omitted, null `status` / `bytes`, `engine_version` null, session snapshot versions |
| `packages/db/src/migrate.edge.test.ts` | unit | real migration list and checksums, empty dir, non-`.sql` files, bad names, duplicate numbers, `splitStatements` (empty, comments only, CRLF, no trailing `;`, documented string-literal limitation) |
| `packages/db/src/db.edge.integration.test.ts` | integration, 58 tests | schema-vs-table column contract; round trip of every event type; duplicate `event_id` (batch, retry, sessions); session ordering (ended first, retried started, two ends, engine mismatch, end before start, end in an earlier batch); TTL (29 d kept, 31 d and epoch dropped, sessions not TTL'd), future `ts`, ordering under skew, year 9999, day boundary; unicode / quotes / newlines / NUL / SQL metacharacters in `target`, `message`, `reason`, session ids; volume (10k batch, 10k mixed, 5k sessions closed in one batch, 500 closed from an earlier batch, one-INSERT-per-table check via `system.parts`); migrate on an empty DB, 3 concurrent migrations; seed keeps non-seed data and never piles up |
| `apps/api/src/app.edge.test.ts` | unit, 35 tests | real `ping()` against a TCP server that never answers and an HTTP server that answers late; 50 parallel probes during an outage; own timeout when `ping` ignores its timeout; late resolve after timeout; no error details in the 503 body; HEAD up and down; `no-store`; 404s (unknown path, wrong method, `/v1`, `/v1/`, `POST /v1/events`); real HTTP on the wire; env boundaries (ports, empty and invalid values, SQL in database name, empty password allowed, password not echoed) |
| `apps/api/src/app.edge.integration.test.ts` | integration, 4 tests | `/healthz` over real HTTP with real ClickHouse (GET, HEAD, `no-store`, under 1 s), 100 sequential probes, unknown user and refused port give a fast 503, missing database still gives 200 (QA-M0-11) |

Open bugs are encoded as `it.fails(...)` tests named `QA-M0-NN: ...`. They pass while the bug exists (so CI stays green) and **start failing once the engineer fixes the bug**; in the re-test pass QA flips them to plain `it`. Engineers must not edit these files; ask QA.

Playwright: nothing to test yet (the web app is a placeholder page); the first e2e suite arrives with the first real screen in M2.

## Bugs

### QA-M0-01 (major, backend): `insertEvents` fails for many `session.ended` events whose start is already stored

**Status: VERIFIED (round 1). Lookup is chunked by URL-encoded size (`chunkByEncodedSize`, 40 KB budget). Tests: 1,000 ends with 128-char ids, 5,000 with 36-char ids, 5,000 with 128-char ids (640 KB), 1,000 ids that grow when URL-encoded (unicode, quotes, spaces), 700 stored + 300 orphaned ends counted correctly, plus 6 unit tests for the chunker (no id lost or reordered, every chunk under budget, an oversized id gets its own chunk). The `it.fails` tests are now plain tests.**
- **File:** `packages/db/src/insert.ts`, `findStoredSessions`.
- **Steps:** store the `session.started` for N sessions, then call `insertEvents` with the N `session.ended` events (test: `db.edge.integration.test.ts`, "volume").
- **Expected:** every session is closed. A batch of 1,000 events (the documented API limit) with ids up to 128 chars, and an ingest flush of 5,000 rows, are both inside the contract (PLAN section 5).
- **Actual:** throws `Poco::Exception ... HTML Form Exception: Field value too long`. The lookup sends all ids as one query parameter (`session_id IN {ids:Array(String)}`) and ClickHouse rejects a form field of about 64 KB or more. Measured: 2,000 ends with 36-char ids pass, 1,000 ends with 128-char ids fail, 5,000 ends with 36-char ids fail. The whole flush is lost, no row is written for it.
- **Why it matters:** in M1 a session usually ends in a later flush than it started, so this is the normal path, and a failure here retries forever.
- **Suggested fix:** look the ids up in chunks (for example 200 per query), or send them in the POST body / as external data, or keep open sessions in the ingest buffer (the TODO in the code).
- **Tests:** two `it.fails` "QA-M0-01" in `db.edge.integration.test.ts`.

### QA-M0-02 (major, backend): `ts` is unbounded in the schema, one bad event breaks a whole batch

**Status: VERIFIED (round 1). `ts` must be an integer in [2020-01-01, 2100-01-01) (`TS_MIN`, `TS_MAX_EXCLUSIVE`): year 10000, `Number.MAX_SAFE_INTEGER`, the epoch and seconds-instead-of-ms are all rejected. Boundary test updated to the new window (`ts: 0` is now invalid on purpose). The db-level "year 10000 / RangeError" tests were replaced by a contract test: the extreme values the schema accepts (last ms of 2099, UInt32 max, cpu 100000, mem 16 TiB, byte counters 2^53-1) round-trip exactly. Residual, accepted: `insertEvents` still throws a `RangeError` for an unvalidated `ts` it cannot format (kept as a passing test).**
- **File:** `packages/schema/src/events.ts` (`count` / `ts`), related `packages/db/src/insert.ts` `toClickHouseDateTime`.
- **Steps:** `FleetEvent.parse({..., ts: 253402300800000})` (year 10000) or `ts: Number.MAX_SAFE_INTEGER`, then `insertEvents`.
- **Expected:** the schema rejects timestamps ClickHouse cannot store, so a bad event is a 400 for that event (or batch) at the API, not a failed flush.
- **Actual:** the schema accepts any integer up to 2^53. `ts >= 253402300800000`: ClickHouse errors `Cannot read DateTime: unexpected number of decimal digits for time zone offset` and the whole insert fails. `ts` above about 8.64e15: `toISOString` throws `RangeError: Invalid time value` (caught only because it runs before any write). Year 9999 works; year 2400 and "now + 1 year" are stored as given.
- **Suggested fix:** `ts: count.max(253_402_300_799_999)` in the schema, and in M1 reject or clamp a `ts` far from server time (clock skew). Not asked for in M0: a skew policy.
- **Tests:** `it.fails` "QA-M0-02" in `events.edge.test.ts`; the failure mode itself is pinned by two passing tests in `db.edge.integration.test.ts` ("a bad value must not take the whole batch down").

### QA-M0-03 (minor, backend): `insertEvents` is not atomic across tables

**Status: DEFERRED TO M1 (lead decision). Not an open M0 bug. The failing test was replaced by `it.todo` ("a retry after a partial write inserts no duplicates", needs `event_id` dedupe). With validated events it is only reachable through a ClickHouse outage mid-flush.**
- **File:** `packages/db/src/insert.ts` (sequential `client.insert` per table).
- **Steps:** `insertEvents([session.started, action, issue with ts in year 10000])`.
- **Expected:** nothing is written when the batch fails, or the caller is told what was written, so a retry cannot double-insert.
- **Actual:** the call throws, but `sessions` and `actions` were already written (`expected 1 to be 0`). A retry duplicates the actions (no dedupe until M1). Reachable only with a value the schema lets through (QA-M0-02), so minor once that is fixed; ClickHouse has no multi-table transaction, so the real answer is M1's dedupe by `event_id`.
- **Test:** `it.fails` "QA-M0-03".

### QA-M0-04 (minor, backend): values the schema allows but the columns cannot hold are silently changed

**Status: Schema level: VERIFIED (round 1). Every UInt32 field rejects 2^32, `cpu_pct` is capped at 100,000, `mem_mb` / `js_heap_mb` at 16,777,216; byte counters up to 2^53-1. Db level (unvalidated events into `insertEvents`): DISPUTED, then ACCEPTED AS DESIGNED by the lead. QA position: the db layer still wraps or NULLs an out-of-range value if someone bypasses the schema. Backend / lead position: `insertEvents` takes typed, validated `FleetEvent`s and the API validation is the guard. The db-level `it.fails` tests were replaced by the contract test described under QA-M0-02.**
- **File:** `packages/schema/src/events.ts` (`count`, `amount`) vs `infra/clickhouse/*.sql` (UInt32, Float32).
- **Steps:** insert an action with `duration_ms: 2**32 + 5`, a sample with `cpu_pct: 1e39`.
- **Expected:** rejected at validation (or stored exactly).
- **Actual:** `duration_ms` is stored as `5`; `seq: 2**33` is stored as `0`; `cpu_pct: 1e39` is stored as `NULL`, which the dashboard would show as "not available" (a made-up gap, against the data-honesty rule). Affects `duration_ms`, `seq`, `startup_ms`, `connect_ms`, `action_seq` and the Float32 fields; UInt64 byte counters hold up to 2^53 fine.
- **Suggested fix:** `.max(4_294_967_295)` on the UInt32 fields; a sensible upper bound on `cpu_pct` / `mem_mb` / `js_heap_mb`.
- **Tests:** `it.fails` "QA-M0-04" (2 in `events.edge.test.ts`, 2 in `db.edge.integration.test.ts`).

### QA-M0-05 (minor, backend): concurrent `migrate` runs are not serialized

**Status: ACCEPTED LIMITATION (lead decision, partly fixed). The runner re-reads the ledger before each file (narrows the race), and `packages/db/README.md` and the doc comment say to run migrations from one place (a single CI / deploy step, never on API startup). Re-test: overlapping runs still leave a complete, usable database and every migration is recorded at least once; sequential runs record each exactly once. QA position: duplicate ledger rows are still possible and the first non-idempotent migration would expose it. Lead position: ClickHouse has no advisory locks and migrate runs as one step. The `it.fails` test became two passing tests that state exactly what is promised.**
- **File:** `packages/db/src/migrate.ts`, `applyPending`.
- **Steps:** run `runMigrations` three times in parallel on an empty database (also: two `pnpm db:migrate` at once).
- **Expected:** each migration applied and recorded once.
- **Actual:** all three runs report 5 applied; `schema_migrations` has 3 rows per migration (`[3,3,3,3,3]`). Harmless today because every file is `CREATE TABLE IF NOT EXISTS`; the first `ALTER TABLE ADD COLUMN` migration will fail or apply twice. Later runs still work (same checksum).
- **Suggested fix:** take a lock (for example a `schema_migrations_lock` table with a unique insert, or `ReplacingMergeTree` ledger) or document "run migrations from one place" in the README and the deploy step.
- **Test:** `it.fails` "QA-M0-05".

### QA-M0-06 (minor now, must be decided before M1 ingest ships; backend): a `session.ended` that arrives before its `session.started` is lost for good

**Status: DEFERRED TO M1 (lead decision). Not an open M0 bug. The passing test that records today's behaviour stays; change its expectation when M1 decides how to handle an end that arrives first.**
- **File:** `packages/db/src/insert.ts` (orphaned ends are counted, not stored).
- **Steps:** `insertEvents([ended])`, then later `insertEvents([started])` for the same session.
- **Expected (for M1):** the session ends up with the real status.
- **Actual:** the end is thrown away (`orphanedEnds: 1`); the session is `running` forever and shows up as a zombie. In the same batch, in either order, the merge works; a retried `started` after `ended` correctly does not reopen the session. This is the documented M0 decision ("counted, not stored, so nothing is invented"), so not a defect against the M0 criteria, but client retries and several collectors make the cross-batch order possible. M1 should store a "pending end" or the ingest buffer should hold ends until the start arrives.
- **Test:** passing test that records today's behaviour; change its expectation when M1 decides ("loses a session.ended that arrives in an earlier batch").

### QA-M0-07 (minor, platform): `pnpm infra:up` without `.env` gives a confusing error

**Status: VERIFIED (round 1, Windows). `infra:up` / `infra:down` now use `--project-directory .` and no `--env-file`. With `.env` renamed away: `pnpm infra:down` then `pnpm infra:up` starts a healthy ClickHouse with the default credentials (exit 0); with `.env` restored it works as before. `.gitignore` now ignores `.env*` except `.env.example` (checked with `git check-ignore`).**
- **File:** root `package.json` scripts `infra:up` / `infra:down` (`--env-file .env`).
- **Steps:** delete or rename `.env`, run `pnpm infra:up`.
- **Expected:** a hint such as "copy .env.example to .env". The compose file already has defaults for all three variables, so it does not need the file at all.
- **Actual:** `couldn't find env file: D:\Eyal\fleetscope\.env` and `ELIFECYCLE`. (`pnpm db:migrate` without `.env` is fine: it prints a readable `ConfigError` listing the four missing variables, though the message does not mention `.env.example` either.)
- **Suggested fix:** drop `--env-file .env` (Compose reads a `.env` next to the compose file or the cwd only; if kept, use `--env-file` only when present) or document the copy step in the error / README.

### QA-M0-08 (minor / nit, backend): `splitStatements` does not strip comments in CRLF files

**Status: VERIFIED (round 1). `split(/\r?\n/)`; the `it.fails` test is a plain test now and passes.**
- **File:** `packages/db/src/migrate.ts`, `splitStatements` (`/--.*$/`).
- **Steps:** a migration saved with CRLF and a comment containing `;`.
- **Expected:** comment removed; **Actual:** `.` does not match `\r`, so the comment stays and is cut at its `;`. Hidden today because `.gitattributes` forces LF; also the file checksum would differ between LF and CRLF checkouts, which `.gitattributes` also prevents.
- **Test:** `it.fails` "QA-M0-08" in `migrate.edge.test.ts`.

### QA-M0-09 (minor, recorded; M1 owns it): duplicate `event_id` is stored twice

**Status: DEFERRED TO M1 (lead decision). Not an open M0 bug. The three passing tests that record the current behaviour stay; they must change when dedupe lands.**
- **Steps:** `insertEvents([e, e])`, or retry the same batch.
- **Actual:** two rows in `actions` (same for issues, samples, network). Expected for M0. For sessions the duplicate is harmless (`ReplacingMergeTree` keeps one row). Notes for the M1 dedupe: the schema accepts upper-case and the nil UUID, so dedupe must normalise `event_id` case; `InsertCounts` counts rows sent, not rows kept.
- **Tests:** three passing tests, "duplicate event_id (M1 owns dedupe)"; the first two need their expectation changed when dedupe lands.

### QA-M0-10 (nit, backend): `CLICKHOUSE_URL` accepts any URL scheme

**Status: VERIFIED (round 1). `CLICKHOUSE_URL` must be http(s) with the message "must be an http(s) URL such as http://localhost:8123". Test rejects `localhost:8123`, `ftp://`, `javascript:` and `file:` and accepts `https://...:8443`.**
- **File:** `packages/db/src/config.ts` (`z.url()`).
- `CLICKHOUSE_URL=localhost:8123` is a valid URL with scheme `localhost`, so a missing `http://` is not caught at startup; it fails at the first query. Suggest `z.url({ protocol: /^https?$/ })`. Recorded by a passing test.

### QA-M0-11 (nit, backend): `/healthz` is green when the database does not exist or is not migrated

**Status: KEPT AS A LIVENESS CHECK (lead agrees). Not a bug; the passing test documents it.**
- **File:** `packages/db/src/ping.ts` / `apps/api/src/routes/health.ts`.
- With `CLICKHOUSE_DATABASE` pointing at a database that does not exist, `/healthz` still returns 200 with `schemaVersion: 1`. The spec only asks for "ClickHouse answers", so this is within the criteria; flagging because the response suggests more than it checks. Recorded by a passing test.

## Observations (no action needed, behaviour recorded)

- **Extra fields are stripped, not rejected.** `FleetEvent.parse({...issue, extra: 1})` returns the event without `extra`; a typo such as `durration_ms` is dropped silently. Forward compatible, but nothing warns a collector author. Test: "extra fields".
- Schema allows `ok: true` together with an `error_code`, and `ok: false` without one; a whitespace-only `session_id`; a NUL byte in ids (stored fine). `session.ended.ts` earlier than `session.started.ts` is stored as is (negative runtime). Engine mismatch between started and ended: the started engine wins.
- TTL: a row older than 30 days is dropped at insert (confirmed for 31 days and for the epoch); the insert still reports it in `InsertCounts`. `sessions` has no TTL by design.
- Future `ts`: stored as given (one year ahead works). A far-future event lands in a far-future partition and its TTL clock starts there, so it would live very long. The skew policy belongs to the M1 ingest.
- Performance: 10,000 actions in one `insertEvents` call 150-250 ms locally; 50,000 about 520 ms; 10,000 mixed (5,000 sessions + 5,000 actions) about 250 ms. One data part per batch, confirmed via `system.parts`.
- Unicode, quotes, newlines, `'; DROP TABLE`, `{param:String}` and NUL bytes all round-trip exactly; session ids are always parameterised.
- API: `HEAD /healthz` works for 200 and 503, `Cache-Control: no-store` on both. Unknown routes, wrong methods, `/v1`, `/healthz/` and `/HEALTHZ` are clean JSON 404s. 503 is about 10-20 ms with ClickHouse stopped, about 1 s with ClickHouse hung (timeout), 50 parallel probes during a hang all finish in about 1 s. Recovery is automatic. Bad or missing env exits 1 with a readable JSON line naming every variable, port in use exits 1 with a clear log, password is never echoed.
- Each probe logs two info lines ("incoming request", "request completed"); with a 5-10 s orchestrator probe that is noisy. Consider `disableRequestLogging` for `/healthz` (nit).
- The ClickHouse client logs expected failures to the console at ERROR level during the `it.fails` / rejection tests; noise only.

## Command output (re-test pass, round 1)

```
pnpm lint        Tasks: 5 successful, 5 total   (4 packages + //#lint:root)
pnpm typecheck   Tasks: 4 successful, 4 total
pnpm test        schema  3 files  111 passed
                 db      3 files   43 passed
                 api     3 files   46 passed
                 Tasks: 4 successful, 4 total
pnpm test:integration
                 db      2 files   76 passed | 1 todo (QA-M0-03, M1)
                 api     2 files    7 passed
                 Tasks: 2 successful, 2 total
```

No `it.fails` is left anywhere. The only non-running test is one `it.todo` for QA-M0-03 (M1).

First pass for comparison: unit 76 / 30 / 43 and integration 62 / 7, with 10 `it.fails`.

## New bugs and re-test findings (round 1)

### QA-M0-12 (major, platform): the new "image tag in CI matches docker-compose" step fails on every run

**Status: VERIFIED (round 1, commit 66040dc).** Found by QA in the re-test pass, fixed by platform within the same round: the check is now `.github/scripts/check-clickhouse-tag.sh` (POSIX character classes, exactly one image line required per file, clear error message). Re-tested: on the repo it prints both tags and exits 0; with a copy of the compose file at a different tag it prints both tags and exits 1 with "ClickHouse image tags differ". Still unproven on GitHub itself until the branch is pushed.
- **File:** `.github/workflows/ci.yml`, lines 29-35 (job `check`).
- **Steps:** run the two commands of the step in any shell: `grep -E '^s+image: clickhouse/clickhouse-server:' infra/docker-compose.yml | awk '{print $2}'`.
- **Expected:** prints `clickhouse/clickhouse-server:26.8.34.13` for both files, `test "$compose" = "$ci"` passes.
- **Actual:** the regex is `^s+image:` (the backslash of `\s` was lost; `cat -A` shows a literal `s+`), so it matches nothing, `compose` is empty, `test -n "$compose"` fails and the step, and therefore the required check "Lint, typecheck, unit tests", goes red on every run. Reproduced locally: `compose=[]`. This commit has not been pushed yet, so CI has not shown it.
- **Fix:** `grep -E '^\s+image: clickhouse/clickhouse-server:'` in both lines (or `grep -oE 'clickhouse/clickhouse-server:[0-9.]+'`, which also avoids matching the step's own text). Check that the step prints both tags and succeeds.

### QA-M0-13 (nit, backend): Fastify deprecation warning at startup
- **File:** `apps/api/src/app.ts` (`disableRequestLogging` given as a function).
- **Actual:** `FastifyDeprecation: disableRequestLogging option is deprecated. Use the logController option ... (FSTDEP023)` is printed on every API start. Behaviour is right (checked on a real server: successful `/healthz` probes log nothing, a failing probe logs one `healthz: ClickHouse is down` warning, other routes still log request and response), but the option will be removed in a later Fastify major.

## Re-test summary

| Bug | Owner | Result |
|---|---|---|
| QA-M0-01 | backend | verified |
| QA-M0-02 | backend | verified |
| QA-M0-03 | backend | deferred to M1 (`it.todo`) |
| QA-M0-04 | backend | schema level verified; db level disputed, accepted as designed by the lead |
| QA-M0-05 | backend | accepted limitation (documented, partly mitigated) |
| QA-M0-06 | backend | deferred to M1 |
| QA-M0-07 | platform | verified (Windows, with and without `.env`) |
| QA-M0-08 | backend | verified |
| QA-M0-09 | backend | deferred to M1 |
| QA-M0-10 | backend | verified |
| QA-M0-11 | backend | kept as a liveness check |
| QA-M0-12 | platform | new in this pass, fixed in 66040dc, verified |
| QA-M0-13 | backend | new, open, nit |

Other changes checked: new `resource.sample` rules per origin (container with any of the four metrics null is rejected, cdp with nulls is accepted and stored as NULL, real zeros stay 0; the four metric columns are `Nullable`); sessions now `PARTITION BY toDate(started_at)` with the 30 day TTL and `ttl_only_drop_parts = 1` on all five tables (31 and 90 day old sessions are dropped, 29 day old kept; a session closed by a later batch merges to one physical row after `OPTIMIZE ... FINAL`); `pnpm build` passes (web and api); `.gitignore` covers `.env*`; `pnpm db:migrate` and `pnpm db:seed` on the re-created local database work; the lint/typecheck/test run in `turbo` with the new transit nodes and `//#lint:root` is green. The Dependabot, SHA-pinned action and Claude workflow changes were not exercised (they only run on GitHub).

CI note: `gh pr checks 1` still shows the run on the first commit (all green). The branch is 10 commits ahead of origin, so none of the fixes or the new `build` and tag-check steps have run in CI yet. QA-M0-12 will show up on the first push.

## Verdict (re-test, round 1): READY TO MERGE

Open blocker: none.
Open major: none.
Open nit: QA-M0-13 (Fastify `disableRequestLogging` deprecation warning at startup; behaviour is correct).
Deferred to M1 (not open M0 bugs): QA-M0-03, QA-M0-06, QA-M0-09.
Accepted by lead decision: QA-M0-04 (db level), QA-M0-05.

`pnpm lint && pnpm typecheck && pnpm test` and `pnpm test:integration` are green on the current HEAD (re-run after 66040dc), `pnpm build` passes, and no `it.fails` is left. Conditions outside QA's reach: the branch has not been pushed since the first CI run, so the pushed CI run (new `build` and tag-check steps, SHA-pinned actions) must be green before merging; and the reviewer must approve.
