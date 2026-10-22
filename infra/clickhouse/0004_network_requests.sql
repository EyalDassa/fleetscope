-- Sampled network requests. status / bytes are NULL when the request failed or the engine does not report them.
-- Raw events are kept for 30 days. event_id lets the API drop duplicates sent by client retries.
CREATE TABLE IF NOT EXISTS network_requests
(
    event_id   UUID,
    ts         DateTime64(3, 'UTC'),
    session_id String,
    agent_id   LowCardinality(String),
    source     LowCardinality(String),
    engine     LowCardinality(String),
    provider   LowCardinality(String),
    domain        LowCardinality(String),
    status        Nullable(UInt16),
    bytes         Nullable(UInt64),
    duration_ms   UInt32,
    resource_type LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (engine, session_id, ts)
TTL toDate(ts) + INTERVAL 30 DAY;
