-- CPU / memory / network / JS heap samples. Anything a sample cannot measure is NULL:
-- container samples (Docker stats) have no js_heap_mb, cdp samples (inside the browser) have no
-- cpu / memory / network. The schema guarantees container samples have all four container metrics.
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
    cpu_pct      Nullable(Float32),
    mem_mb       Nullable(Float32),
    net_rx_bytes Nullable(UInt64),
    net_tx_bytes Nullable(UInt64),
    js_heap_mb   Nullable(Float32),
    origin       LowCardinality(String) -- container | cdp
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (engine, session_id, ts)
TTL toDate(ts) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1; -- partitions are daily too, so expired data is dropped whole
