-- Which engine a session was routed away from (`fleet run --routing by-scenario`).
--
-- `engine` stays the engine that actually ran the session, so every per-engine number counts what
-- really happened. `routed_from` is the engine the assignment chose before the fleet routed the
-- session to one that can run its scenario (Lightpanda cannot run web workers, docs/adr/0005).
-- NULL: the session was not routed, and every row written before this column existed.
--
-- Both versions of a session carry it (insertEvents copies it onto the ended row).
-- Re-running is harmless: ADD COLUMN IF NOT EXISTS.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS routed_from LowCardinality(Nullable(String));
