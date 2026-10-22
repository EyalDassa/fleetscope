-- One row per session, always a full snapshot of the session's latest state.
-- ReplacingMergeTree keeps the row with the highest `version` per session_id:
--   version 1 = running (built from session.started)
--   version 2 = ended   (started fields + session.ended fields)
-- Rows are merged in the background, so queries that need exactly one row per session must use
-- FINAL or argMax(..., version).
--
-- Partition and TTL match the raw event tables (daily, 30 days) so a session never outlives its
-- actions, samples and issues. INVARIANT: both versions of a session must carry the same
-- started_at, otherwise they land in different partitions and the old version is never replaced.
-- (insertEvents guarantees this: the ended row is copied from the running row.)
CREATE TABLE IF NOT EXISTS sessions
(
    session_id     String,
    agent_id       LowCardinality(String),
    source         LowCardinality(String),
    engine         LowCardinality(String),
    provider       LowCardinality(String),
    engine_version LowCardinality(Nullable(String)),
    scenario       LowCardinality(String),
    region         LowCardinality(String),
    started_at     DateTime64(3, 'UTC'),
    startup_ms     UInt32,
    connect_ms     UInt32,
    status         LowCardinality(String), -- running | success | failed | blocked | timeout | crashed
    ended_at       Nullable(DateTime64(3, 'UTC')),
    duration_ms    Nullable(UInt32),
    reason         Nullable(String),
    version        UInt32
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toDate(started_at)
ORDER BY session_id
TTL toDate(started_at) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;
