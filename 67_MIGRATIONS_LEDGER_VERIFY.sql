-- 67_MIGRATIONS_LEDGER_VERIFY.sql
--
-- Sections A-F. Each raises on failure and prints "VERIFY <letter> PASSED" on
-- success, which is the form the disposable-PostgreSQL harness parses.
--
-- Run AFTER the hardening. Run again AFTER the rollback and it must FAIL.

-- A — the substrate exists.
DO $a$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: schema_migrations does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='schema_migrations'
       AND column_name IN ('number','name','applied_at','applied_by','database','evidence')
     GROUP BY table_name HAVING count(*) = 6
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: schema_migrations is missing columns';
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: the ledger exists with all six columns.';
END $a$;

-- B — it recorded itself. If this row is absent the file did not run to
-- completion, which is the exact failure the ledger exists to expose.
DO $b$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 67 AND evidence = 'self-recorded'
       AND applied_at IS NOT NULL AND applied_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: 67 did not record itself as self-recorded and witnessed';
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: the ledger recorded its own apply, with a time and an actor.';
END $b$;

-- C — a backfilled row is a weaker claim and must not dress as a witnessed one.
DO $c$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.schema_migrations WHERE evidence LIKE 'backfilled%';
  IF EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE evidence LIKE 'backfilled%'
       AND (applied_at IS NOT NULL OR applied_by IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a backfilled row claims a time or an actor it cannot know';
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: % backfilled row(s), none claiming a time or an actor.', v_n;
END $c$;

-- D — and the constraint refuses the reverse. Tested, not assumed.
DO $d$
DECLARE v_failed boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.schema_migrations (number, name, evidence)
    VALUES (999999, 'CONSTRAINT PROBE', 'self-recorded');
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY D FAILED: a self-recorded row was accepted with no applied_at/applied_by';
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: a self-recorded row without a witness is refused.';
END $d$;

-- E — an audit trail that can be cleared is not one.
DO $e$
DECLARE v_failed boolean := false;
BEGIN
  BEGIN
    DELETE FROM public.schema_migrations WHERE number = 67;
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a ledger row was deleted';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: ledger rows cannot be deleted.';
END $e$;

-- F — anon holds nothing. Read from relacl, not role_table_grants, which is
-- blind when queried as a role that cannot see the grant.
DO $f$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='schema_migrations'
       AND array_to_string(c.relacl, ',') LIKE '%anon=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY F FAILED: anon holds a grant on schema_migrations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='schema_migrations' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'VERIFY F FAILED: RLS is not enabled on schema_migrations';
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: RLS on, anon holds nothing.';
END $f$;
