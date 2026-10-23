# 0002. Ingest: keeping duplicates out of ClickHouse, and what to do with a flush it refuses

Status: accepted (M1, amended in the M1 fix round: dead letter, age check, surrogates)

## Context

`POST /v1/events` returns `202` as soon as a batch is in the API's in-memory ingest buffer, and a
timer writes the buffer to ClickHouse about once a second. Two things can go wrong on the way.

**Duplicates.** Collectors retry when they do not get an answer, so the same event can reach the API
twice. Separately, one flush is several INSERTs (one per table), and ClickHouse has no transaction
across tables, so a flush that fails halfway leaves some tables written. The retry then writes those
rows again (QA-M0-03). The dashboard counts rows, so every action, error and sample would be
counted twice.

**Flushes that ClickHouse refuses.** The first version of this ADR said "validated events should
never be refused", retried a failed flush forever, and accepted a stalled buffer as the price. The
review and QA of M1 (R-M1-01, QA-M1-01) found two counterexamples, both reachable by one client:

1. A string with a lone UTF-16 surrogate (half an emoji). `JSON.stringify` sends it as `\ud83d`,
   and ClickHouse answers `CANNOT_PARSE_ESCAPE_SEQUENCE` every time. Our own collector can produce
   one by cutting a text in the middle of an emoji, and any web page can produce one on purpose.
2. A flush that touches more than 100 different days. The raw tables are partitioned by day, and
   ClickHouse refuses more than `max_partitions_per_insert_block = 100` partitions in one INSERT. The
   schema accepted any `ts` from 2020, so 101 events on 101 different days were enough.

A flush holds the events of all clients, so one of these stalls everybody: the buffer fills to its
50,000 events, every client gets `503`, and a restart loses what was acknowledged. Retrying forever
is the right answer to an outage, but the wrong answer to rows that will never be accepted.

What we have to work with:

- Every event has a uuid `event_id`, and a client retry resends the same ids.
- The raw tables are plain `MergeTree` and are never updated, so there is no unique key.
- ClickHouse can skip an INSERT it has already seen: it remembers the last N blocks per table
  (`non_replicated_deduplication_window`, default **0 = off** for a non-replicated table) and
  compares either a hash of the block or a caller-supplied `insert_deduplication_token`.
- ClickHouse's error codes tell a refusal of the data (`CANNOT_PARSE_*`, `TYPE_MISMATCH`, too many
  partitions) from trouble with the server or the network (connection refused, timeouts, memory).

## Options considered

For duplicates:

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

For a flush that ClickHouse refuses:

A. **Retry forever** (the first version). Right for outages. A stall for everybody when the rows are
   the problem, and a restart loses the queue.
B. **Drop the flush with a log line.** Unblocks ingest, but acknowledged events are lost for good.
C. **Move the flush to a dead-letter file** after a few identical refusals. Unblocks ingest, and
   nothing acknowledged is lost: it is in ClickHouse or in the file.
D. **Split the flush in halves** to find the bad events and store the rest. Rejected: the failed
   attempts may already have written some tables, and rows re-inserted in halves carry different
   tokens and blocks, so the tables that were written would get duplicates.

## Decision

**Duplicates: 1 and 3 together**, because they cover different failures:

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
  `insertEvents` therefore sends `deduplicate_insert = 'disable'` when the caller passes no token
  (and `'enable'` with one), so the seed and tests behave as before, and deduplication happens only
  where we asked for it. This is the ClickHouse 26.x setting: it replaced `insert_deduplicate`, which
  is now ignored (we found out the hard way: our test still saw the content dedupe). A server older
  than 25.x would reject the unknown setting, which is fine because the project pins 26.8 LTS.
- The client sets `async_insert = 0` (ClickHouse 26.x defaults to 1). With async inserts the server
  merges many small INSERTs itself and deduplicates on its own terms; we already batch, and a plain
  synchronous INSERT behaves the same locally, in CI and on ClickHouse Cloud.
- We verified on ClickHouse 26.8.34 that a second INSERT with the same token into a non-replicated
  `MergeTree` is skipped when `async_insert = 0`, that a different token writes the rows again, and
  that it also works for a batch that spans two daily partitions
  (`packages/db/src/dedupe.integration.test.ts`). Without migration 0006 it silently does nothing.

**Refused flushes: keep the events out of the poison, and add a safety valve (C).**

Two guards at the edge remove the known causes, so that in practice a valid batch is not refused:

- *Lone surrogates are repaired, not rejected.* Every free-text field in `packages/schema` (labels,
  targets, messages, urls) goes through `String.prototype.toWellFormed()`: each lone surrogate
  becomes U+FFFD, the length does not change, and the event is kept. Text that a page produced
  should not sink a whole batch. `session_id` and `agent_id` are rejected instead (400), because a
  changed id would silently split or merge sessions. Enum fields are strict anyway.
- *Events older than the retention window are rejected* (400, naming the indexes, like the
  clock-skew check). The raw tables have `TTL toDate(ts) + INTERVAL 30 DAY`, which works on whole
  days, so the oldest `ts` that survives is midnight UTC 29 days ago (`RETENTION_DAYS` in the
  schema, `oldestAcceptedTs` in the API; a test against ClickHouse checks both edges). An older event
  would get `202` and be deleted a moment later. The same rule caps a flush at 31 daily partitions,
  far under the limit of 100. A client with a clock far in the past now hears about it.

Then the safety valve for the causes nobody has thought of yet:

- Errors are classified in `packages/db` (`classifyInsertError`). A **data error** is a refusal that
  depends on the rows: the parse and type errors (`CANNOT_PARSE_TEXT`, `_ESCAPE_SEQUENCE`,
  `_QUOTED_STRING`, `_INPUT_ASSERTION_FAILED`, `_DATE`, `_DATETIME`, `_NUMBER`, `_UUID`,
  `TYPE_MISMATCH`, `CANNOT_CONVERT_TYPE`, `INCORRECT_DATA`, `TOO_LARGE_STRING_SIZE`,
  `VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE`) and `TOO_MANY_PARTS` when the message says "too many
  partitions". Everything else is **transient**: connection refused or reset, timeouts, aborted
  requests, 5xx, memory limits, too many queries, merges falling behind (`TOO_MANY_PARTS` for parts),
  and also anything we do not recognise.
- Transient errors are retried forever with backoff, as before. A missing table or database
  (migrations not run) is also treated as transient: the operator fixes it, changing the rows would
  not, and dropping data because a migration was forgotten would be worse than a visible stall.
- When the same flush fails with a data error **3 times in a row** (a transient error in between
  resets the count), its events are written to a **dead-letter file** and the buffer moves on to the
  next flush. One `error` log line says why (error name and code, flush id, event count, file), and
  `/healthz` shows `ingest.deadLettered` (events). If the file cannot be written (disk full,
  permissions), the events stay in memory and the flush keeps being retried, so nothing is lost.
- The file is `INGEST_DEADLETTER_DIR/<UTC time>-<flush id>.jsonl` (default `./.data/deadletter`,
  relative to the API's working directory), one validated event per line.

A related guard in the same buffer: a `session.ended` whose `session.started` is not in the batch
or in `sessions` is not written (we do not invent a session). The buffer holds it for 60 seconds and
offers it again with every flush, since the start may be in the next batch. After that it logs a
warning with the session ids and drops it (counted in `/healthz`).

A batch with more new events than the whole buffer holds can never be accepted, so it gets `413`,
not a retryable `503` (QA-M1-09).

## Consequences

Good:

- Retries at both levels are safe: no duplicate rows, no query-time dedupe, no `FINAL`.
- The dashboard can count rows.
- The rules are small enough to explain: an id window, plus one token per flush and table.
- One client, or one hostile web page, can no longer stop ingestion for everybody. Everything the
  API acknowledged is in ClickHouse or in a dead-letter file.

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
  bound at high rates, and the age limit at low rates. Adding and expiring ids costs the same at any
  fill level (about 1.5 microseconds per event); an earlier `Map`-only version swung between 17 and
  400 microseconds once it was full (QA-M1-07).
- **The dead-letter file holds a whole flush, not just the bad event.** A flush has the events of all
  clients (up to 5,000), and we cannot tell which one ClickHouse disliked (D above is unsafe).
  Innocent events end up in the file too. They are valid and can be sent again.
- **The file may contain events that are already in ClickHouse**, because the attempts before the
  refusal can have written the tables that come first (`sessions`, `actions`, ...). There is no
  automatic replay. To replay, first check the `event_id`s against the tables (or the rows are
  counted twice), fix or drop the bad events, then `POST` the lines to `/v1/events` in batches of up
  to 1,000. Replay only after the API has restarted or 15 minutes after the dead-letter: until then
  the API's in-memory id window still remembers these `event_id`s and answers 202 with every event
  counted as a duplicate, storing nothing. Check that `duplicates` is 0 in every answer. The
  directory needs an owner who looks at it: `deadLettered` in `/healthz` is the signal, and the
  files are never deleted by the API.
- **Only known data errors are dead-lettered.** An unknown ClickHouse error counts as transient and
  stalls the buffer visibly (`retrying: true`, the error name in `lastFlushError`, the full error in
  the log) instead of dropping data. Teach `classifyInsertError` about it when it happens.
- The default directory is relative to the working directory, and on a platform with an ephemeral
  disk a file there disappears with the container. Set `INGEST_DEADLETTER_DIR` to a volume.
- The buffer is bounded (50,000 events by default). When it is full, `POST /v1/events` returns `503`
  with `Retry-After` and queues nothing; the collector keeps its events and retries.
- `z.toJSONSchema` cannot describe the repairing transforms in the free-text fields. When OpenAPI
  is generated from the schema (later), use `io: "input"`.
