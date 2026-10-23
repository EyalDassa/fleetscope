-- Insert deduplication for the ingest buffer (docs/adr/0002-ingest-dedupe.md).
--
-- The API's buffer retries a failed flush with the same rows and the same
-- insert_deduplication_token per table. For a non-replicated MergeTree, ClickHouse only remembers
-- those tokens if the table has a deduplication window; the default is 0, which disables it
-- silently. The window counts the last N inserted blocks (one block per partition per INSERT).
-- The buffer flushes about once a second, so 10000 covers well over an hour.
--
-- insertEvents sets insert_deduplicate = 0 on inserts that carry no token, so these tables do not
-- also drop an insert whose content happens to repeat.
-- Re-running is harmless: MODIFY SETTING just sets the same value again.
ALTER TABLE sessions         MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE actions          MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE resource_samples MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE network_requests MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE issues           MODIFY SETTING non_replicated_deduplication_window = 10000;
