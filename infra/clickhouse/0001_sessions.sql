-- One row per session, always a full snapshot of the session's latest state.
-- ReplacingMergeTree keeps the row with the highest `version` per session_id:
--   version 1 = running (built from session.started)
--   version 2 = ended   (started fields + session.ended fields)
-- Rows are merged in the background, so queries that need exactly one row per session must use
-- FINAL or argMax(..., version).
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
ORDER BY session_id;
