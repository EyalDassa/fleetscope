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
  (checksum). Add a new migration instead. (Until M0 is merged the first five files may still be
  edited, followed by a database reset.)
- A file may hold several statements separated by `;`. `--` comments are stripped first, so a `;`
  or `--` inside a string literal is not supported.

## Writing events

`insertEvents(client, events)` takes validated `FleetEvent`s and writes one batch INSERT per table.
`ts` is sent as a `YYYY-MM-DD HH:MM:SS.mmm` string, because ClickHouse reads a bare integer as
seconds. Rows older than the 30 day TTL are dropped by ClickHouse.

## Logging

The ClickHouse client's own log lines are routed into pino (JSON) and limited to errors. Callers
report expected failures such as an unreachable server themselves.
