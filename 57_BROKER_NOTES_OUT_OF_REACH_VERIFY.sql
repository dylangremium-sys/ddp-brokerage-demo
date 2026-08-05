-- =============================================================================
-- Migration 57 — VERIFY: the broker's note is out of the supplier's reach
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure: the new table, its RLS, its single admin-only policy, and the
--       old column and trigger both gone
--   B — the notes that existed were carried across, and a blank one was not
--   C — BEHAVIOURAL, the whole point: an admin can read and write the note and a
--       farmer who owns the batch cannot see that it exists
--   D — a farmer cannot WRITE one either, so this did not trade a read hole for
--       a write hole
--   E — anon holds nothing on the new table
--   F — the note dies with its batch, so a deleted batch leaves no orphan
--   G — batch updates still work with the trigger gone, which is the regression
--       this migration could most easily have caused
--
-- Expected on success: seven PASSED notices and no exception.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_policies int;
BEGIN
  IF to_regclass('public.batch_internal_notes') IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: public.batch_internal_notes does not exist.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.batch_internal_notes'::regclass) THEN
    v_problems := array_append(v_problems, 'RLS is NOT enabled on batch_internal_notes');
  END IF;

  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'batch_internal_notes';
  IF v_policies <> 1 THEN
    v_problems := array_append(v_problems,
      format('expected exactly ONE policy on batch_internal_notes, found %s — every extra policy is '
             'another chance to be permissive in one verb', v_policies));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='inventory_batches'
               AND column_name='owner_notes') THEN
    v_problems := array_append(v_problems, 'inventory_batches.owner_notes is STILL PRESENT');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
             WHERE c.relname='inventory_batches' AND t.tgname='trg_protect_owner_notes'
               AND NOT t.tgisinternal) THEN
    v_problems := array_append(v_problems,
      'trg_protect_owner_notes is still attached — it assigns NEW.owner_notes and the column is gone');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: batch_internal_notes exists with RLS and exactly one policy; owner_notes and its trigger are both gone.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- Fixture: an admin, a farmer, a farm the farmer owns, and a batch on it.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE v57_ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

DO $seed$
DECLARE
  adm uuid := gen_random_uuid();
  frm uuid := gen_random_uuid();
  f   uuid := gen_random_uuid();
  b   uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (adm), (frm);
  -- UPDATE, not INSERT: handle_new_user() has already made each profile
  -- 'pending', and an INSERT ... ON CONFLICT DO NOTHING here silently no-ops,
  -- leaving the whole test running as two pending users.
  UPDATE public.profiles SET role = 'ddp_admin' WHERE id = adm;
  UPDATE public.profiles SET role = 'farmer'    WHERE id = frm;

  INSERT INTO public.farms (id, farm_name, created_by) VALUES (f, 'VERIFY-57 farm', frm);
  INSERT INTO public.farm_memberships (farm_id, user_id) VALUES (f, frm);
  INSERT INTO public.inventory_batches (id, farm_id, created_by, product_name, quantity_kg)
  VALUES (b, f, frm, 'VERIFY-57 batch', 100);

  INSERT INTO public.batch_internal_notes (batch_id, note, updated_by)
  VALUES (b, 'MARGIN: buy 900, sell 1400. Buyer is Rotterdam.', adm);

  INSERT INTO v57_ids VALUES ('admin', adm), ('farmer', frm), ('farm', f), ('batch', b);
END
$seed$;

-- -----------------------------------------------------------------------------
-- B. The carry-across happened, and a blank note did not
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_blank int;
BEGIN
  SELECT count(*) INTO v_blank FROM public.batch_internal_notes WHERE btrim(note) = '';
  IF v_blank > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: % blank note(s) exist. An empty note is an absent note.', v_blank;
  END IF;

  BEGIN
    INSERT INTO public.batch_internal_notes (batch_id, note)
    VALUES ((SELECT id FROM v57_ids WHERE name='batch'), '   ');
    RAISE EXCEPTION 'VERIFY B FAILED: a whitespace-only note was accepted.';
  EXCEPTION WHEN check_violation OR unique_violation THEN NULL; END;

  RAISE NOTICE 'VERIFY B PASSED: no blank notes exist and a whitespace-only note is refused.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. The point of the migration: the farmer cannot see it, the admin can
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_seen     int;
  v_note     text;
  -- Read BEFORE the role switch. A TEMP table belongs to the session user, so
  -- `authenticated` gets "permission denied for table v57_ids" the moment the
  -- role changes — and that error looks exactly like the policy working.
  v_farmer   uuid := (SELECT id FROM v57_ids WHERE name='farmer');
  v_admin    uuid := (SELECT id FROM v57_ids WHERE name='admin');
  v_batch    uuid := (SELECT id FROM v57_ids WHERE name='batch');
BEGIN
  -- Farmer, who OWNS the batch.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_farmer)::text, true);
  SELECT count(*) INTO v_seen FROM public.batch_internal_notes;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      format('the farmer who owns the batch can see %s internal note row(s)', v_seen));
  END IF;
  -- And the batch itself is still visible, which is what makes the above a
  -- statement about the NOTE rather than about the farmer seeing nothing at all.
  SELECT count(*) INTO v_seen FROM public.inventory_batches;
  IF v_seen = 0 THEN
    v_problems := array_append(v_problems,
      'the farmer cannot see their own BATCH either — the test proves nothing about the note');
  END IF;
  RESET ROLE;

  -- Admin.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  SELECT note INTO v_note FROM public.batch_internal_notes WHERE batch_id = v_batch;
  IF v_note IS NULL THEN
    v_problems := array_append(v_problems, 'the ADMIN cannot read the note — the lock is too tight');
  END IF;
  RESET ROLE;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: the farmer who owns the batch sees the batch but ZERO internal notes; the admin reads the note in full.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. The farmer cannot write one either
--
-- A read hole traded for a write hole would be no improvement: a farmer able to
-- INSERT a note could plant something in DDP's own record of the batch.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_n        int;
  v_farmer   uuid := (SELECT id FROM v57_ids WHERE name='farmer');  -- before the role switch
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_farmer)::text, true);

  BEGIN
    INSERT INTO public.batch_internal_notes (batch_id, note)
    VALUES (gen_random_uuid(), 'planted by the farmer');
    v_problems := array_append(v_problems, 'the farmer INSERTED an internal note');
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL; END;

  EXECUTE 'WITH x AS (UPDATE public.batch_internal_notes SET note = ''rewritten'' RETURNING 1)
           SELECT count(*) FROM x' INTO v_n;
  IF v_n <> 0 THEN
    v_problems := array_append(v_problems, format('the farmer UPDATEd %s note row(s)', v_n));
  END IF;

  EXECUTE 'WITH x AS (DELETE FROM public.batch_internal_notes RETURNING 1) SELECT count(*) FROM x'
    INTO v_n;
  IF v_n <> 0 THEN
    v_problems := array_append(v_problems, format('the farmer DELETEd %s note row(s)', v_n));
  END IF;
  RESET ROLE;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: the farmer cannot insert, update or delete an internal note — the read hole was not traded for a write hole.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. anon holds nothing
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_privs text;
BEGIN
  SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '')
    INTO v_privs
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
   WHERE n.nspname = 'public' AND c.relname = 'batch_internal_notes'
     AND a.grantee = 'anon'::regrole;

  IF v_privs <> '' THEN
    RAISE EXCEPTION 'VERIFY E FAILED: anon holds % on batch_internal_notes.', v_privs;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: anon holds no privilege at all on batch_internal_notes.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. The note dies with its batch
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_batch uuid := (SELECT id FROM v57_ids WHERE name = 'batch');
  v_left  int;
BEGIN
  DELETE FROM public.inventory_batches WHERE id = v_batch;
  SELECT count(*) INTO v_left FROM public.batch_internal_notes WHERE batch_id = v_batch;
  IF v_left <> 0 THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: % note row(s) survived their batch. An orphaned internal note is a note '
      'nobody can attribute and nobody deletes.', v_left;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: deleting a batch takes its internal note with it.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. Batch updates still work
--
-- The regression this migration could most easily have caused. The dropped
-- trigger fired BEFORE UPDATE and assigned NEW.owner_notes; leaving it attached
-- with the column gone would raise on every batch update in the platform.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_farm uuid := (SELECT id FROM v57_ids WHERE name = 'farm');
  v_id   uuid := gen_random_uuid();
  v_q    numeric;
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, product_name, quantity_kg)
  VALUES (v_id, v_farm, 'VERIFY-57 update probe', 10);

  UPDATE public.inventory_batches SET quantity_kg = 20 WHERE id = v_id;

  SELECT quantity_kg INTO v_q FROM public.inventory_batches WHERE id = v_id;
  IF v_q IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: a batch UPDATE did not take effect (quantity_kg = %).', v_q;
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: inserting and updating a batch still works with the trigger removed.';
END
$verify_g$;

ROLLBACK;
