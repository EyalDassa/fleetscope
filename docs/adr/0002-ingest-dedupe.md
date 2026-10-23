# 0002. Keeping duplicates out of ClickHouse

Status: accepted (M1)

## Context

`POST /v1/events` returns `202` as soon as a batch is in the API's in-memory ingest buffer, and a
timer writes the buffer to ClickHouse about once a second. Collectors retry when they do not get an
answer, so the same event can reach the API twice. Separately, one flush is several INSERTs (one
per table), and ClickHouse has no transaction across tables, so a flush that fails halfway leaves
some tables written. The retry then writes those rows again (QA-M0-03).

Both produce duplicate rows, and the dashboard counts rows: every action, error and sample would
be counted twice.

What we have to work with:

- Every event has a uuid `event_id`, and a client retry resends the same ids.
- The raw tables are plain `MergeTree` and are never updated, so there is no unique key.
- ClickHouse can skip an INSERT it has already seen: it remembers the last N blocks per table
  (`non_replicated_deduplication_window`, default **0 = off** for a non-replicated table) and
  compares either a hash of the block or a caller-supplied `insert_deduplication_token`.

## Options considered

1. **In-memory window of recent `event_id`s in the API only.**
   Simple and fast. Catches client retries. Does not help when a flush fails halfway, because the
   retry is made by the buffer itself with the same events. Lost on restart.
2. **`ReplacingMergeTree` keyed by `event_id` for the raw tables.**
   Deduplicates forever, even across restarts and across several API instances. But duplicates
   only disappear when parts are merged, so every query would need `FINAL` or `argMax`, which is
   slow on the tables that hold the most rows. Also `ORDER BY (engine, session_id, ts)` would have
   to start with `event_id` to be the dedupe key, which would ruin the time-range scans the
   dashboard depends on. The sort key is the dedupe key in this engine; we cannot have both.
3. **ClickHouse insert deduplication tokens.**
   Each flush gets an id, and every table INSERT in it carries `insert_deduplication_token =
   <flushId>:<table>`. If the flush is retried with the same events and the same tokens,
   ClickHouse skips the blocks it already wrote. Exact, cheap, no query changes. Only covers
   retries of the same flush, not the same event arriving in two different flushes.

## Decision

Use **1 and 3 together**, because they cover different failures:

| Failure | Caught by |
|---|---|
| Collector resends a batch (timeout, lost response) | Layer 1: the API drops event ids it saw in the last 15 minutes (or last 1,000,000 ids, whichever is smaller). `accepted` and `duplicates` in the 202 say how many of each. |
| Flush fails after some tables were written; the buffer retries it | Layer 2: same events, same tokens, so the written tables are skipped. |

Details that matter:

- The window is `non_replicated_deduplication_window = 10000` (blocks) on `sessions`, `actions`,
  `resource_samples`, `network_requests` and `issues` (migration `0006`, append-only because M0 was
  already merged). A flush is usually one block per table (one per daily partition it touches), so this remembers
  hours of flushes. A retry only has to survive an outage, and no new blocks are written
  during an outage, so the window does not move while it matters.
- With a token, ClickHouse identifies a block by the token and ignores its content. So a token must
  never be reused for different rows: the buffer cuts a flush once, gives it a fresh uuid, and
  retries exactly that batch. New events that arrive during the retry wait for the next flush.
- Once a table has a window, ClickHouse also skips an INSERT whose content equals one it has seen.
  `insertEvents` therefore sends `insert_deduplicate = 0` when the caller passes no token, so the
  seed and tests behave as before, and deduplication happens only where we asked for it.
- The client sets `async_insert = 0` (ClickHouse 26.x defaults to 1). With async inserts the server
  merges many small INSERTs itself and deduplicates on its own terms; we already batch, and a plain
  synchronous INSERT behaves the same locally, in CI and on ClickHouse Cloud.
- We verified on ClickHouse 26.8.34 that a second INSERT with the same token into a non-replicated
  `MergeTree` is skipped when `async_insert = 0`, that a different token writes the rows again, and
  that it also works for a batch that spans two daily partitions
  (`packages/db/src/dedupe.integration.test.ts`). Without migration 0006 it silently does nothing.

A related guard in the same buffer: a `session.ended` whose `session.started` is not in the batch
or in `sessions` is not written (we do not invent a session). The buffer holds it for 60 seconds and
offers it again with every flush, since the start may be in the next batch. After that it logs a
warning with the session ids and drops it (counted in `/healthz`).

## Consequences

Good:

- Retries at both levels are safe: no duplicate rows, no query-time dedupe, no `FINAL`.
- The dashboard can count rows.
- The rules are small enough to explain: an id window, plus one token per flush and table.

Not covered, and accepted:

- **A crash between `202` and the flush loses what is in the buffer** (up to about a second of
  events, at most the buffer capacity). The collector already got its answer, so it will not resend.
  Closing this gap needs a durable queue (a write-ahead log, Kafka or similar), which is out of
  scope. A graceful shutdown (SIGTERM) does flush, waiting up to 10 seconds.
- **The same event in two different flushes is not caught by layer 2.** Layer 1 catches it while the
  id is in the window. A resend more than 15 minutes later, or after an API restart (the window is
  in memory), would be stored twice. With a collector that retries for seconds, not minutes, this is
  not expected. If it ever matters, the next step is a `ReplacingMergeTree` or a periodic dedupe job.
- **Several API instances do not share layer 1.** A collector that retries against a different
  instance would not be recognised. Today there is one instance; sticky routing by `session_id` or a
  shared store (Redis) would fix it.
- **Memory:** one million remembered ids cost on the order of 100 MB. The count limit is the real
  bound at high rates, and the age limit at low rates.
- **A batch that ClickHouse refuses every time would block the buffer** (it retries forever), and
  ingestion would answer `503` once the buffer fills. Validated events should never be refused;
  `/healthz` shows `retrying` and the error name, and the log has the full error. We chose a
  visible stall over silently dropping data that was already acknowledged.
- The buffer is bounded (50,000 events by default). When it is full, `POST /v1/events` returns `503`
  with `Retry-After` and queues nothing; the collector keeps its events and retries.
