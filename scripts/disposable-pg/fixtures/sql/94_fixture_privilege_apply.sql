-- Harness self-proof fixture (negative scenario) — privilege blindness.
--
-- Migrations 12, 14 and 15 create no object at all: they REVOKE and GRANT. A
-- catalog sweep that records only tables, functions, policies and triggers sees
-- an identical catalog before and after those migrations, so a rollback that
-- restored none of the permissions was reported symmetric and a fixture for them
-- would have proved nothing.
--
-- This stage grants DELETE on a bootstrap table to `anon` -- the unauthenticated
-- role. Its rollback revokes nothing.

GRANT DELETE ON public.profiles TO anon;
