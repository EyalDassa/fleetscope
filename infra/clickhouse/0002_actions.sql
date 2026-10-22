-- One row per browser action (goto, click, ...).
-- Raw events are kept for 30 days. event_id lets the API drop duplicates sent by client retries.
CREATE TABLE IF NOT EXISTS actions
(
    event_id   UUID,
    ts         DateTime64(3, 'UTC'),
    session_id String,
    agent_id   LowCardinality(String),
    source     LowCardinality(String),
    engine     LowCardinality(String),
    provider   LowCardinality(String),
    seq         UInt32,
    action_type LowCardinality(String),
    target      String,
    duration_ms UInt32,
    ok          Bool,
    error_code  LowCardinality(Nullable(String))
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (engine, session_id, ts)
TTL toDate(ts) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1; -- partitions are daily too, so expired data is dropped whole
