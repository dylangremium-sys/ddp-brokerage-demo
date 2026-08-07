-- =============================================================================
-- 62_STATUS_HISTORY_APPEND_ONLY_VERIFY.sql
--
-- Proves status_history is append-only and attributed, WITHOUT proving it by
-- accident.
--
-- Sections B, C and D are the point: they attempt a real UPDATE, a real DELETE
-- and a real TRUNCATE and require each to be REFUSED. They run as the migration
-- runner, which is a superuser and bypasses RLS entirely — that is deliberate,
-- because the superuser is one of the roles the old table could not restrain.
-- A guarantee proven only for under-privileged roles is a policy, not an
-- invariant, and policies were never the gap here.
--
-- The other sections stop those three passing for the wrong reason: A pins the
-- trigger and function properties, E pins the privilege layer, F proves
-- attribution is forced rather than merely defaulted, and G proves the
-- migration did NOT touch the policies — because the tempting "fix" to the
-- alarming-looking arwd grant is to widen a RESTRICTIVE policy, which would
-- remove a restriction while looking like hardening.
--
-- RUNNING THIS AGAINST PRODUCTION: wrap it in a transaction you roll back.
--
--   { echo "BEGIN;"; cat 62_..._VERIFY.sql; echo "ROLLBACK;"; } \
--     | psql "$PROD" -v ON_ERROR_STOP=1
--
-- Not for tidiness. Section D attempts a TRUNCATE, and a TRUNCATE that is NOT
-- refused raises no exception and so cannot be caught — plpgsql's implicit
-- savepoint only unwinds on error. Section D carries a catalog interlock so the
-- statement is never attempted unless the guard is already proven present, and
-- the enclosing ROLLBACK is the second layer under that. Use both.
-- =============================================================================

DO $verify$
DECLARE
  v_problems text[] := '{}';
  v_id       uuid;
  v_count    int;
  v_secdef   boolean;
  v_path     text;
  v_refused  boolean;
BEGIN
  -- ── A. The guards exist and are built correctly ───────────────────────────
  SELECT count(*) INTO v_count
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND c.relname = 'status_history'
    AND t.tgname IN ('status_history_no_update_delete', 'status_history_no_truncate', 'status_history_set_actor');

  IF v_count <> 3 THEN
    v_problems := v_problems || format('expected 3 triggers on status_history, found %s', v_count);
  END IF;

  FOR v_secdef, v_path IN
    SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('prevent_status_history_mutation', 'fn_status_history_set_actor')
  LOOP
    IF NOT v_secdef THEN
      v_problems := v_problems || 'a status_history guard function lost SECURITY DEFINER';
    END IF;
    IF v_path IS NULL OR v_path NOT LIKE '%search_path=public, pg_temp%' THEN
      v_problems := v_problems || format('a status_history guard has an unpinned search_path (%s)', coalesce(v_path, 'NULL'));
    END IF;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: 3 triggers present; both guard functions are SECURITY DEFINER and search_path-pinned.';

  -- ── Fixture ───────────────────────────────────────────────────────────────
  INSERT INTO public.status_history (entity_type, entity_id, old_status, new_status, note)
  VALUES ('v62_probe', gen_random_uuid(), 'before', 'after', 'migration 62 verify fixture')
  RETURNING id INTO v_id;

  -- ── B. UPDATE is refused ──────────────────────────────────────────────────
  v_refused := false;
  BEGIN
    UPDATE public.status_history SET new_status = 'tampered' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: an UPDATE against status_history SUCCEEDED as a superuser. The trail can '
      'still be rewritten by the roles RLS cannot restrain, which is the defect 62 exists to close.';
  END IF;

  SELECT count(*) INTO v_count FROM public.status_history WHERE id = v_id AND new_status = 'after';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: the row changed even though the UPDATE raised.';
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: UPDATE refused, and the row is unchanged.';

  -- ── C. DELETE is refused ──────────────────────────────────────────────────
  v_refused := false;
  BEGIN
    DELETE FROM public.status_history WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a DELETE against status_history SUCCEEDED. History can still be erased.';
  END IF;

  SELECT count(*) INTO v_count FROM public.status_history WHERE id = v_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the row vanished even though the DELETE raised.';
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: DELETE refused, and the row survives.';

  -- ── D. TRUNCATE is refused ────────────────────────────────────────────────
  -- Separate from B and C because a row-level trigger never fires for TRUNCATE:
  -- a table guarded only by the row-level trigger is still emptiable in one
  -- statement.
  --
  -- THE CATALOG PRE-CHECK IS A SAFETY INTERLOCK, NOT A SHORTCUT. A TRUNCATE
  -- that is not refused destroys the table and raises nothing to catch. So it
  -- is attempted only once the catalog says the guard exists. If it does not,
  -- this fails without touching a row — a missing guard is a failure to report,
  -- not a thing to demonstrate by emptying the audit trail.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'status_history'
      AND t.tgname = 'status_history_no_truncate'
  ) THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: status_history_no_truncate does not exist, so the whole trail can be '
      'emptied in one statement. NOT attempting the TRUNCATE to prove it.';
  END IF;

  v_refused := false;
  BEGIN
    TRUNCATE public.status_history;
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: TRUNCATE SUCCEEDED despite the guard being present. The trail has been '
      'emptied by this check — restore from backup.';
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: TRUNCATE refused.';

  -- ── E. The privilege layer ────────────────────────────────────────────────
  IF has_table_privilege('authenticated', 'public.status_history', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.status_history', 'DELETE') THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: authenticated still holds UPDATE and/or DELETE on status_history. RLS '
      'already blocked the route, but the grant should match the intent.';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.status_history', 'SELECT') THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: authenticated lost SELECT. The farmer select-own policy now has no '
      'privilege to act through, so a farmer can no longer see their own history.';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: authenticated keeps SELECT and holds neither UPDATE nor DELETE.';

  -- ── F. Attribution is forced, not defaulted ───────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.status_history'::regclass AND attname = 'changed_by' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'VERIFY F FAILED: status_history has no changed_by column, so no row can say who caused it.';
  END IF;

  -- A column DEFAULT would satisfy "attribution exists" while remaining
  -- overridable by any caller supplying the column — which is the forgery the
  -- BEFORE INSERT trigger prevents. Its absence is the assertion.
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.status_history'::regclass AND a.attname = 'changed_by'
  ) THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: changed_by has a column DEFAULT, which any caller can override. '
      'Attribution must come from the BEFORE INSERT trigger.';
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: changed_by exists and is set by trigger, not by an overridable default.';

  -- ── G. The policies were NOT touched ──────────────────────────────────────
  -- This section guards against the plausible wrong fix. `authenticated=arwd`
  -- looks like a hole; the instinct is to go at the policy named "operational
  -- farmer or admin". That policy is RESTRICTIVE — dropping or widening it
  -- REMOVES a restriction, and adding a permissive farmer policy GRANTS access
  -- that does not exist today. Either would read as hardening and be the
  -- opposite.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'status_history'
      AND policyname = 'status_history: operational farmer or admin'
      AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION
      'VERIFY G FAILED: the RESTRICTIVE overlay from migration 22 is missing or is no longer '
      'restrictive. Migration 62 must not touch it — removing it WIDENS access.';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'status_history' AND permissive = 'PERMISSIVE' AND cmd IN ('ALL', 'UPDATE', 'DELETE', 'INSERT');
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'VERIFY G FAILED: expected exactly ONE permissive policy admitting write commands (the admin '
      'one), found %. A second would hand write access to a role that does not have it today.', v_count;
  END IF;
  RAISE NOTICE 'VERIFY G PASSED: the RESTRICTIVE overlay is intact and no new permissive write policy was added.';

  -- ── Fixture removal ───────────────────────────────────────────────────────
  -- Only possible by dropping the guard, so it is recreated and re-checked.
  DROP TRIGGER status_history_no_update_delete ON public.status_history;
  DELETE FROM public.status_history WHERE entity_type = 'v62_probe';
  CREATE TRIGGER status_history_no_update_delete
    BEFORE DELETE OR UPDATE ON public.status_history
    FOR EACH ROW EXECUTE FUNCTION public.prevent_status_history_mutation();

  -- Confirmed from the CATALOG, deliberately. A BEFORE DELETE FOR EACH ROW
  -- trigger does not fire when no row matches, and every fixture row has just
  -- been removed — so a behavioural re-test would need a victim row, and a
  -- DELETE matching nothing succeeds whether the guard is present or absent.
  -- That test would report a false failure on a correctly restored table.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND c.relname = 'status_history'
      AND t.tgname = 'status_history_no_update_delete'
      AND p.proname = 'prevent_status_history_mutation'
      -- tgtype bits: ROW = 1, DELETE = 8, UPDATE = 16.
      AND (t.tgtype & 1) = 1
      AND (t.tgtype & 8) = 8
      AND (t.tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED AT CLEANUP: the row-level UPDATE/DELETE guard was not restored, or was '
      'restored with the wrong function or firing events. This script left the table unprotected.';
  END IF;

  RAISE NOTICE 'VERIFY 62 COMPLETE: 7 sections passed, fixtures removed, guard restored and re-checked.';
END
$verify$;
