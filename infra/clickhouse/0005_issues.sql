-- Problems seen during a session (blocked, captcha, crash, ...).
-- Raw events are kept for 30 days. event_id lets the API drop duplicates sent by client retries.
CREATE TABLE IF NOT EXISTS issues
(
    event_id   UUID,
    ts         DateTime64(3, 'UTC'),
    session_id String,
    agent_id   LowCardinality(String),
    source     LowCardinality(String),
    engine     LowCardinality(String),
    provider   LowCardinality(String),
    kind    LowCardinality(String),
    message String
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (engine, session_id, ts)
TTL toDate(ts) + INTERVAL 30 DAY;
