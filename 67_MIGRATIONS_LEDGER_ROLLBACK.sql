-- 67_MIGRATIONS_LEDGER_ROLLBACK.sql
--
-- Removes the ledger and its guards.
--
-- READ THIS BEFORE RUNNING IT. Dropping this table destroys the only record of
-- what has been applied to this database. Every migration from 62 onward writes
-- its row here as its final statement, so afterwards the question this table
-- exists to answer — "did it apply?" — goes back to being answerable only by
-- probing for objects whose names you already have to know.
--
-- Rolling back a migration that RECORDS things is not symmetrical with rolling
-- back one that changes them. This is the intended meaning of undoing 62, and it
-- is not recoverable.

BEGIN;

DROP TRIGGER IF EXISTS schema_migrations_no_truncate ON public.schema_migrations;
DROP TRIGGER IF EXISTS schema_migrations_no_delete ON public.schema_migrations;
DROP TABLE IF EXISTS public.schema_migrations;
DROP FUNCTION IF EXISTS public.refuse_schema_migration_removal();

COMMIT;
