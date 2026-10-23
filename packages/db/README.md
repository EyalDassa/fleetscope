# @fleetscope/db

ClickHouse client, migrations, batch insert and (later) all queries, shared by `api` and `mcp`.

## Commands

```
pnpm db:migrate            # apply pending migrations from infra/clickhouse
pnpm db:seed               # insert a handful of source=sim events (repeatable)
pnpm test                  # unit tests, no Docker
pnpm test:integration      # needs ClickHouse: pnpm infra:up
```

## Migrations

Plain SQL files in `infra/clickhouse/`, named `NNNN_name.sql`, applied in order. The runner records
each applied file (with a checksum) in the `schema_migrations` table.

Rules:

- **Run migrations from exactly one place.** ClickHouse has no advisory locks and no transactional
  DDL, so the runner cannot lock. Run `pnpm db:migrate` as a single CI/deploy step (or by hand),
  never on API startup, where several replicas could race and record a file twice. The runner
  re-reads the ledger right before each file, which narrows the race but does not close it.
- **Keep statements idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), or keep
  one statement per file. A file that fails halfway re-runs from its first statement.
- **Applied files are append-only.** Editing or deleting an applied file makes the runner fail
  (checksum). Add a new migration instead. M0 is merged, so `0001` to `0005` are frozen; schema
  changes go in a new file (for example `0006` sets the insert deduplication window).
- A file may hold several statements separated by `;`. `--` comments are stripped first, so a `;`
  or `--` inside a string literal is not supported.

## Writing events

`insertEvents(client, events)` takes validated `FleetEvent`s and writes one batch INSERT per table.
`ts` is sent as a `YYYY-MM-DD HH:MM:SS.mmm` string, because ClickHouse reads a bare integer as
seconds.

`insertEvents(client, events, { dedupTokens })` is safe to repeat. With one `insert_deduplication_token`
per table (`dedupTokensFor(flushId)` builds `<flushId>:<table>`), ClickHouse skips an INSERT it has
already seen, so a flush that failed halfway can be retried with the same events and tokens without
duplicating the tables that were written. Without tokens nothing is deduplicated. The result lists
the `session.ended` events whose `session.started` was not found (`orphans`) so the caller can try
them again later. See `docs/adr/0002-ingest-dedupe.md`.

The client sets `async_insert = 0`: ClickHouse 26.x defaults to server-side async inserts, but the
API already batches.

Rows older than the 30 day TTL are dropped by ClickHouse asynchronously: a background merge removes the expired part shortly after the insert, so a query right after the insert may still see them.

## Logging

The ClickHouse client's own log lines are routed into pino (JSON) and limited to errors. Callers
report expected failures such as an unreachable server themselves.
