-- What a session visited (docs/adr/0007): the demo site or a real public site.
--
-- `target` is 'demo' or 'public'; `site` names the site ('demo-site', 'wikipedia', 'mdn', 'govuk',
-- 'hackernews', 'python-docs'). `source` ('real' | 'sim') keeps its meaning and is independent.
-- Every row written before this migration, and every session whose events carry neither field,
-- reads 'demo' / 'demo-site': that is what they were.
--
-- Both versions of a session carry them (insertEvents copies them onto the ended row).
-- Re-running is harmless: ADD COLUMN IF NOT EXISTS.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS target LowCardinality(String) DEFAULT 'demo';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS site LowCardinality(String) DEFAULT 'demo-site';
