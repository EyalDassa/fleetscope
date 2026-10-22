-- CPU / memory / network samples. js_heap_mb is NULL when the engine cannot report it.
-- Raw events are kept for 30 days. event_id lets the API drop duplicates sent by client retries.
CREATE TABLE IF NOT EXISTS resource_samples
(
    event_id   UUID,
    ts         DateTime64(3, 'UTC'),
    session_id String,
    agent_id   LowCardinality(String),
    source     LowCardinality(String),
    engine     LowCardinality(String),
    provider   LowCardinality(String),
    cpu_pct      Float32,
    mem_mb       Float32,
    net_rx_bytes UInt64,
    net_tx_bytes UInt64,
    js_heap_mb   Nullable(Float32),
    origin       LowCardinality(String) -- container | cdp
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (engine, session_id, ts)
TTL toDate(ts) + INTERVAL 30 DAY;
