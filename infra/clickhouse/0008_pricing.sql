-- Reference prices for the estimated cost shown on the dashboards (PLAN.md section 6).
--
-- usd_per_browser_hour is what one browser costs for one hour. Cost = browser-hours * this price
-- (the definition of browser-hours is in packages/db/README.md). It is an ESTIMATE: nothing is
-- billed, the local Docker fleet is free. The number answers "what would this cost on a cloud
-- browser provider", and source_url + note say where the number comes from.
--
-- A price change is a NEW row with a later effective_from; old rows stay as history. The view
-- pricing_current has the latest price that is already in effect per engine and provider, which is
-- what dashboards join. All sessions in the selected range are priced at that current price.
CREATE TABLE IF NOT EXISTS pricing
(
    engine               LowCardinality(String),
    provider             LowCardinality(String),
    usd_per_browser_hour Decimal(10, 4),
    source_url           String,
    note                 String,
    effective_from       Date
)
ENGINE = MergeTree
ORDER BY (provider, engine, effective_from);

-- $0.10 per browser-hour: Browserbase's published overage rate on the Startup plan
-- (https://www.browserbase.com/pricing, checked 2026-10-24). One price for all three engines until
-- M3 compares them. The WHERE clause makes the seed safe to run again (a migration file that failed
-- halfway is re-run from its first statement).
INSERT INTO pricing (engine, provider, usd_per_browser_hour, source_url, note, effective_from)
SELECT engine, provider, usd_per_browser_hour, source_url, note, effective_from
FROM values(
    'engine String, provider String, usd_per_browser_hour Decimal(10, 4), source_url String, note String, effective_from Date',
    ('chromium', 'local-docker', 0.10, 'https://www.browserbase.com/pricing', 'reference price (Browserbase Startup plan overage rate, checked 2026-10-24), used for all engines until M3', '2026-10-24'),
    ('chrome-headless-shell', 'local-docker', 0.10, 'https://www.browserbase.com/pricing', 'reference price (Browserbase Startup plan overage rate, checked 2026-10-24), used for all engines until M3', '2026-10-24'),
    ('lightpanda', 'local-docker', 0.10, 'https://www.browserbase.com/pricing', 'reference price (Browserbase Startup plan overage rate, checked 2026-10-24), used for all engines until M3', '2026-10-24')
)
WHERE (engine, provider, effective_from) NOT IN (SELECT engine, provider, effective_from FROM pricing);

-- The output column is not called effective_from: ClickHouse would read that name inside
-- argMax(..., effective_from) as the aggregate max(effective_from) and refuse the query.
CREATE VIEW IF NOT EXISTS pricing_current AS
SELECT
    engine,
    provider,
    argMax(usd_per_browser_hour, effective_from) AS usd_per_browser_hour,
    argMax(source_url, effective_from) AS source_url,
    argMax(note, effective_from) AS note,
    max(effective_from) AS in_effect_since
FROM pricing
WHERE effective_from <= today()
GROUP BY engine, provider;
