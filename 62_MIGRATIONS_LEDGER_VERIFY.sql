-- 62_MIGRATIONS_LEDGER_VERIFY.sql
--
-- Run AFTER the hardening. Run again AFTER the rollback and it must FAIL — a
-- verify that passes in both directions checks nothing.

DO $verify$
DECLARE
  v_failed boolean;
  v_backfilled int;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: schema_migrations does not exist';
  END IF;

  -- The ledger recorded itself. If this row is missing, the file did not run to
  -- completion — which is the exact failure the ledger exists to expose, so it
  -- must be checked on the ledger itself first.
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 62 AND evidence = 'self-recorded'
       AND applied_at IS NOT NULL AND applied_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: 62 did not record itself as self-recorded and witnessed';
  END IF;

  -- A backfilled row must NOT claim to have been witnessed. This is the
  -- distinction the owner asked for: "63 applied, evidence: object exists" is a
  -- weaker claim than a row written by 63, and the ledger must not blur them.
  SELECT count(*) INTO v_backfilled
    FROM public.schema_migrations WHERE evidence LIKE 'backfilled%';

  IF EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE evidence LIKE 'backfilled%'
       AND (applied_at IS NOT NULL OR applied_by IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a backfilled row claims a time or an actor it cannot know';
  END IF;

  -- And the constraint must refuse the reverse: a self-recorded row with no
  -- witness. Tested rather than assumed.
  v_failed := false;
  BEGIN
    INSERT INTO public.schema_migrations (number, name, evidence)
    VALUES (999999, 'CONSTRAINT PROBE', 'self-recorded');
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY FAILED: a self-recorded row was accepted with no applied_at/applied_by';
  END IF;

  -- Rows cannot be removed.
  v_failed := false;
  BEGIN
    DELETE FROM public.schema_migrations WHERE number = 62;
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY FAILED: a ledger row was deleted';
  END IF;

  -- anon holds nothing. Read from relacl, not role_table_grants, which is blind
  -- when queried as a role that cannot see the grant.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
       AND array_to_string(c.relacl, ',') LIKE '%anon=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: anon holds a grant on schema_migrations';
  END IF;

  RAISE NOTICE 'VERIFY PASSED: ledger present, self-recorded, % backfilled row(s) marked as such, append-only, anon has nothing.',
    v_backfilled;
END
$verify$;

-- What this database actually has. Printed so the operator sees it in the same
-- output as the apply, rather than having to remember to ask afterwards.
SELECT number, name,
       coalesce(to_char(applied_at, 'DD Mon YYYY, HH24:MI'), '—') AS applied_at,
       coalesce(applied_by, '—') AS applied_by,
       evidence
  FROM public.schema_migrations
 ORDER BY number;
