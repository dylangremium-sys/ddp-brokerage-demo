-- Harness self-proof fixture (negative scenario) — RLS-flag blindness.
--
-- Row-level security is a boolean on pg_class, not an object. Migration 51 is
-- almost entirely "ALTER TABLE ... ENABLE ROW LEVEL SECURITY" and creates
-- nothing, so an object-only snapshot cannot distinguish a rollback that turned
-- RLS back off from one that did nothing whatsoever.
--
-- This stage enables RLS on a bootstrap table that starts with it disabled.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
