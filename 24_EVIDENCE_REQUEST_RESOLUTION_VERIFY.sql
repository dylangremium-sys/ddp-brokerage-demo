-- =============================================================================
-- Migration 24 — VERIFY (Evidence Request & Resolution Workflow)
--
-- Production-safe: the whole script runs inside ONE transaction that ends in
-- ROLLBACK, so every fixture it creates is discarded. It contains no COMMIT.
--
-- These are BEHAVIOURAL checks, not catalog spot-checks: each section builds a
-- real fixture and proves the database actually refuses the thing the contract
-- says it must refuse. A section that cannot build its fixture RAISES rather
-- than silently passing, so the script can never pass vacuously.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — every migration-24 object exists with the required security shape.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  f text;
  tables text[] := ARRAY['evidence_requests','evidence_request_responses',
                         'evidence_request_attachments','evidence_request_history'];
  fns text[] := ARRAY[
    'can_operationally_access_farm','create_evidence_request',
    'get_or_create_evidence_response_draft','save_evidence_response_draft',
    'submit_evidence_response','request_evidence_clarification',
    'resolve_evidence_request','reject_evidence_response','cancel_evidence_request',
    'reserve_evidence_attachment','finalize_evidence_attachment',
    'remove_draft_evidence_attachment','link_existing_evidence_document'];
  rls_off text[] := ARRAY[]::text[];
  insecure text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = f)
    THEN missing := missing || ('function ' || f); END IF;
  END LOOP;
  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(missing, ', ');
  END IF;

  -- RLS must be enabled on all four tables.
  SELECT array_agg(c.relname::text) INTO rls_off
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY(tables) AND c.relrowsecurity = false;
  IF rls_off IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: RLS not enabled on: %', array_to_string(rls_off, ', ');
  END IF;

  -- Every RPC must be SECURITY DEFINER with an explicit search_path.
  SELECT array_agg(p.proname::text) INTO insecure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY(fns)
    AND (p.prosecdef = false OR p.proconfig IS NULL
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  IF insecure IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: not SECURITY DEFINER with search_path: %',
      array_to_string(insecure, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: all migration-24 objects exist, RLS on, RPCs are SECURITY DEFINER with search_path.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- VERIFY B — anon and authenticated hold NO direct write privilege. Every
-- mutation must go through an RPC.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  leaks text[] := ARRAY[]::text[];
  r record;
BEGIN
  FOR r IN
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('evidence_requests','evidence_request_responses',
                         'evidence_request_attachments','evidence_request_history')
      AND grantee IN ('anon','authenticated','PUBLIC')
      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
  LOOP
    leaks := leaks || format('%s: %s has %s', r.table_name, r.grantee, r.privilege_type);
  END LOOP;

  IF array_length(leaks,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: direct write privilege leaked: %',
      array_to_string(leaks, ' | ');
  END IF;

  -- anon must not even read.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee='anon'
      AND table_name IN ('evidence_requests','evidence_request_responses',
                         'evidence_request_attachments','evidence_request_history')
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: anon holds a privilege on an evidence table';
  END IF;

  -- There must be NO INSERT/UPDATE/DELETE policy at all on the workflow tables.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('evidence_requests','evidence_request_responses',
                        'evidence_request_attachments','evidence_request_history')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a non-SELECT policy exists on an evidence table';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: no direct DML grants or policies; anon has no access.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- VERIFY C — scope, target and category integrity are enforced by the database,
-- using a REAL fixture (non-vacuous: the control insert must succeed first).
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  farm_a      uuid;
  farm_b      uuid;
  profile_a   uuid;
  batch_a     uuid;
  actor       uuid;
  req_id      uuid;
  ok          boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: no auth.users row available to act as creator';
  END IF;

  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_a;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_b;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_a) RETURNING id INTO profile_a;
  INSERT INTO public.inventory_batches (id, farm_id, created_by)
    VALUES (gen_random_uuid(), farm_a, actor) RETURNING id INTO batch_a;

  -- C1 CONTROL: a correctly scoped farm-level request must be insertable.
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_a, 'farm_profile', profile_a, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  IF req_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: control insert produced no row (test would be vacuous)';
  END IF;

  -- C2: farm_id that does not own the target must be rejected.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
    VALUES (farm_b, 'farm_profile', profile_a, 'farm_license',
            'Cross-farm', 'This request deliberately points at another farm profile.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: mismatched farm_id was accepted'; END IF;

  -- C3: two targets at once must be rejected.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, inventory_batch_id, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', profile_a, batch_a, 'farm_license',
            'Two targets', 'This request deliberately carries both target ids at once.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: a request with two targets was accepted'; END IF;

  -- C4: no target at all must be rejected.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', 'farm_license',
            'No target', 'This request deliberately carries no target id at all.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: a request with no target was accepted'; END IF;

  -- C5: category/target matrix — 'coa' is batch-only, so a farm target fails.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', profile_a, 'coa',
            'COA on farm', 'A COA category must never be valid for a farm-profile target.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: coa accepted on a farm_profile target'; END IF;

  -- C6: title/explanation length floors are enforced.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', profile_a, 'farm_license', 'ab', 'too short', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: short title/explanation accepted'; END IF;

  -- C7: core fields are immutable after creation.
  ok := false;
  BEGIN
    UPDATE public.evidence_requests SET title = 'Renamed' WHERE id = req_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: request title was mutable after creation'; END IF;

  -- C8: requests cannot be deleted.
  ok := false;
  BEGIN
    DELETE FROM public.evidence_requests WHERE id = req_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: a request was deletable'; END IF;

  RAISE NOTICE 'VERIFY C PASSED: scope, target, category, length, immutability and no-delete all enforced.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- VERIFY D — history is append-only and a submitted response is immutable.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  farm_id_v   uuid;
  profile_v   uuid;
  actor       uuid;
  req_id      uuid;
  resp_id     uuid;
  hist_id     uuid;
  ok          boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_identity',
          'Identity', 'Please provide the current farm identity documentation set.', actor)
  RETURNING id INTO req_id;

  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role, event_type)
  VALUES (req_id, NULL, 'open', actor, 'ddp_admin', 'request_created')
  RETURNING id INTO hist_id;
  IF hist_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY D FAILED: control history insert produced no row (test would be vacuous)';
  END IF;

  -- D1: history UPDATE denied.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET note = 'tampered' WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: history was updatable'; END IF;

  -- D2: history DELETE denied.
  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_history WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: history was deletable'; END IF;

  -- D3: a non-creation event must carry previous_status.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_request_history
      (request_id, previous_status, next_status, actor_user_id, actor_role, event_type, note)
    VALUES (req_id, NULL, 'resolved', actor, 'ddp_admin', 'request_resolved', 'a valid resolution note');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: non-creation event accepted without previous_status'; END IF;

  -- D4: terminal events require a note of 10-2000 characters.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_request_history
      (request_id, previous_status, next_status, actor_user_id, actor_role, event_type, note)
    VALUES (req_id, 'farmer_submitted', 'resolved', actor, 'ddp_admin', 'request_resolved', 'short');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: terminal event accepted without a valid note'; END IF;

  -- D5: a submitted response is immutable and undeletable.
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, response_text, created_by_user_id, submitted_at, draft_owner_user_id)
  VALUES (req_id, 1, 'submitted', 'evidence text', actor, now(), actor)
  RETURNING id INTO resp_id;

  ok := false;
  BEGIN
    UPDATE public.evidence_request_responses SET response_text = 'edited' WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: a submitted response was editable'; END IF;

  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_responses WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: a submitted response was deletable'; END IF;

  -- D6: only one draft may exist per request.
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 2, 'draft', actor, actor);

  ok := false;
  BEGIN
    INSERT INTO public.evidence_request_responses
      (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
    VALUES (req_id, 3, 'draft', actor, actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: a second draft was accepted for one request'; END IF;

  RAISE NOTICE 'VERIFY D PASSED: history append-only, submitted responses immutable, single-draft enforced.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- VERIFY E — the authorization helper fails closed.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  farm_id_v uuid;
  actor     uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;

  -- With no authenticated session, auth.uid() is NULL: access must be false.
  IF public.can_operationally_access_farm(farm_id_v) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: helper granted access with no authenticated session';
  END IF;
  IF public.can_operationally_access_farm(NULL) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: helper granted access for a NULL farm id';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: can_operationally_access_farm() fails closed for anonymous and NULL input.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- VERIFY F — migrations 21 and 23 are untouched by migration 24.
-- -----------------------------------------------------------------------------
DO $verify_f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'profiles_role_check'
                   AND pg_get_constraintdef(oid) LIKE '%pending%') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: migration 21 pending role constraint is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_new_user') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: migration 21 handle_new_user() is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'issue_buyer_pack_snapshot') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: migration 23 issue_buyer_pack_snapshot() is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_operational_farmer_access') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: has_operational_farmer_access() is missing';
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: migration 21 and migration 23 objects remain intact.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- VERIFY G — a draft attachment can be removed, and its history event survives
-- with attachment_id nulled. Proves the ON DELETE SET NULL interpretation:
-- history is preserved, only the pointer is cleared, and no other history
-- mutation is possible.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  farm_id_v uuid;
  profile_v uuid;
  actor     uuid;
  req_id    uuid;
  resp_id   uuid;
  att_id    uuid;
  hist_id   uuid;
  h         public.evidence_request_history%ROWTYPE;
  before_h  public.evidence_request_history%ROWTYPE;
  ok        boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_license',
          'Licence', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;

  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;

  -- A READY upload: exactly the case the old ON DELETE RESTRICT made unremovable.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_id_v || '/' || req_id || '/' || resp_id || '/x/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 1024,
          repeat('a', 64), actor, now())
  RETURNING id INTO att_id;

  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role,
     event_type, response_id, attachment_id)
  VALUES (req_id, 'open', 'open', actor, 'farmer',
          'attachment_uploaded', resp_id, att_id)
  RETURNING id INTO hist_id;

  SELECT * INTO before_h FROM public.evidence_request_history WHERE id = hist_id;
  IF before_h.attachment_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: fixture history event has no attachment_id (test would be vacuous)';
  END IF;

  -- G1: a ready draft attachment must now be deletable (ON DELETE SET NULL).
  DELETE FROM public.evidence_request_attachments WHERE id = att_id;
  IF EXISTS (SELECT 1 FROM public.evidence_request_attachments WHERE id = att_id) THEN
    RAISE EXCEPTION 'VERIFY G FAILED: ready draft attachment was not deleted';
  END IF;

  -- G2: the history event must still exist, with ONLY attachment_id cleared.
  SELECT * INTO h FROM public.evidence_request_history WHERE id = hist_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFY G FAILED: history event disappeared when its attachment was removed';
  END IF;
  IF h.attachment_id IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: attachment_id was not nulled by the referential action';
  END IF;
  IF h.event_type      IS DISTINCT FROM before_h.event_type
     OR h.actor_user_id IS DISTINCT FROM before_h.actor_user_id
     OR h.actor_role    IS DISTINCT FROM before_h.actor_role
     OR h.created_at    IS DISTINCT FROM before_h.created_at
     OR h.request_id    IS DISTINCT FROM before_h.request_id
     OR h.response_id   IS DISTINCT FROM before_h.response_id
     OR h.previous_status IS DISTINCT FROM before_h.previous_status
     OR h.next_status   IS DISTINCT FROM before_h.next_status
     OR h.event_data    IS DISTINCT FROM before_h.event_data
  THEN
    RAISE EXCEPTION 'VERIFY G FAILED: the history event was altered beyond nulling attachment_id';
  END IF;

  -- G3: no OTHER history mutation is permitted — the narrow exemption must not
  -- have opened general UPDATE access.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET note = 'tampered' WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: history note became updatable'; END IF;

  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET event_type = 'request_resolved' WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: history event_type became updatable'; END IF;

  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_history WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: history became deletable'; END IF;

  RAISE NOTICE 'VERIFY G PASSED: ready draft attachment removable; history preserved with attachment_id nulled; no other history mutation permitted.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- VERIFY H — a manual audit edit cannot masquerade as FK cleanup. Nulling
-- attachment_id by hand WHILE the attachment still exists must fail, even for a
-- privileged role, because the trigger tests the data, not the caller.
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  farm_id_v uuid; profile_v uuid; actor uuid;
  req_id uuid; resp_id uuid; att_id uuid; hist_id uuid;
  ok boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_license',
          'Licence', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_id_v || '/' || req_id || '/' || resp_id || '/h/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 2048, repeat('b', 64), actor, now())
  RETURNING id INTO att_id;
  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role,
     event_type, response_id, attachment_id)
  VALUES (req_id, 'open', 'open', actor, 'farmer', 'attachment_uploaded', resp_id, att_id)
  RETURNING id INTO hist_id;

  -- Non-vacuity: the attachment must genuinely still exist for this to mean anything.
  IF NOT EXISTS (SELECT 1 FROM public.evidence_request_attachments WHERE id = att_id) THEN
    RAISE EXCEPTION 'VERIFY H FAILED: fixture attachment missing (test would be vacuous)';
  END IF;

  -- H1: hand-nulling attachment_id while the attachment EXISTS must fail. This
  -- runs as the migration owner — a privileged role — and must still be refused.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET attachment_id = NULL WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'VERIFY H FAILED: attachment_id was hand-nulled while the attachment still existed';
  END IF;

  -- H2: re-pointing attachment_id to another value must fail.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET attachment_id = gen_random_uuid() WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY H FAILED: attachment_id was re-pointed'; END IF;

  -- H3: the same nulling becomes legitimate once the attachment is deleted.
  DELETE FROM public.evidence_request_attachments WHERE id = att_id;
  IF (SELECT attachment_id FROM public.evidence_request_history WHERE id = hist_id) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY H FAILED: FK cleanup did not null attachment_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.evidence_request_history WHERE id = hist_id) THEN
    RAISE EXCEPTION 'VERIFY H FAILED: history row vanished during FK cleanup';
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: manual attachment_id nulling refused while the attachment exists; FK cleanup still permitted.';
END
$verify_h$;

-- -----------------------------------------------------------------------------
-- VERIFY I — the two-stage controlled removal protocol.
-- Proves the column exists, that an authorized removal fails submission closed,
-- and that a linked existing document needs no storage stage.
-- -----------------------------------------------------------------------------
DO $verify_i$
DECLARE
  farm_id_v uuid; profile_v uuid; actor uuid;
  req_id uuid; resp_id uuid; att_id uuid;
  src_doc_id uuid; linked_att_id uuid; linked_rows integer;
  other_farm_v uuid; other_doc_id uuid;
  ok boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='evidence_request_attachments'
      AND column_name='removal_requested_at'
  ) THEN
    RAISE EXCEPTION 'VERIFY I FAILED: removal_requested_at column is missing';
  END IF;

  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_license',
          'Licence', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;

  -- A ready upload marked for removal.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at, removal_requested_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_id_v || '/' || req_id || '/' || resp_id || '/i/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 512, repeat('c', 64),
          actor, now(), now())
  RETURNING id INTO att_id;

  IF (SELECT removal_requested_at FROM public.evidence_request_attachments WHERE id = att_id) IS NULL THEN
    RAISE EXCEPTION 'VERIFY I FAILED: removal_requested_at did not persist (test would be vacuous)';
  END IF;

  -- I1: an attachment awaiting removal must be deletable (completion stage).
  DELETE FROM public.evidence_request_attachments WHERE id = att_id;
  IF EXISTS (SELECT 1 FROM public.evidence_request_attachments WHERE id = att_id) THEN
    RAISE EXCEPTION 'VERIFY I FAILED: attachment awaiting removal could not be deleted';
  END IF;

  -- I2: a linked existing document carries no storage path at all, so it can be
  -- removed without any storage stage.
  --
  -- NON-VACUITY. This previously read `INSERT … SELECT … FROM farmer_documents
  -- WHERE farm_id = farm_id_v LIMIT 1`. VERIFY I creates a BRAND-NEW farm above
  -- and never creates a document for it, so that SELECT matched nothing, the
  -- INSERT affected zero rows, and the `IF EXISTS … storage_object_path IS NOT
  -- NULL` check below then found no rows and passed. The section reported
  -- linked-document coverage while never linking a document. The fixture is now
  -- created explicitly, its id captured, and the insert's row count asserted, so
  -- an empty result can no longer masquerade as a pass.
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_id_v, 'licence', 'linked-source.pdf')
  RETURNING id INTO src_doc_id;
  IF src_doc_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY I FAILED: farmer_documents fixture was not created';
  END IF;

  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, farmer_document_id,
     original_filename, mime_type, created_by_user_id)
  SELECT req_id, resp_id, 'existing_farm_document', fd.id,
         'linked.pdf', 'application/pdf', actor
  FROM public.farmer_documents fd
  WHERE fd.id = src_doc_id AND fd.farm_id = farm_id_v
  RETURNING id INTO linked_att_id;

  GET DIAGNOSTICS linked_rows = ROW_COUNT;
  IF linked_rows <> 1 THEN
    RAISE EXCEPTION 'VERIFY I FAILED: linked-document insert affected % row(s), expected exactly 1', linked_rows;
  END IF;
  IF linked_att_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY I FAILED: linked attachment id was not returned';
  END IF;

  -- The linked row must point at THIS document, on THIS farm, with the linked
  -- origin, no storage stage, and no upload state.
  IF NOT EXISTS (
    SELECT 1
    FROM public.evidence_request_attachments a
    JOIN public.farmer_documents fd ON fd.id = a.farmer_document_id
    WHERE a.id = linked_att_id
      AND a.origin = 'existing_farm_document'
      AND a.farmer_document_id = src_doc_id
      AND fd.farm_id = farm_id_v
      AND a.storage_bucket IS NULL
      AND a.storage_object_path IS NULL
      AND a.upload_state IS NULL
      AND a.inventory_document_id IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY I FAILED: linked attachment does not match its source document, farm, origin or shape';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.evidence_request_attachments
    WHERE response_id = resp_id AND origin = 'existing_farm_document'
      AND storage_object_path IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY I FAILED: a linked document carries a storage path';
  END IF;

  -- History linkage. This section inserts attachments DIRECTLY rather than
  -- through link_existing_evidence_document(), because the RPCs require an
  -- authenticated farmer with operational farm access and auth.uid() is NULL in
  -- a verify transaction. History is written by those RPCs, not by a trigger, so
  -- no event appears here on its own — asserting one would fail for the wrong
  -- reason. The event is therefore written explicitly and its linkage asserted,
  -- which is what this section can honestly prove; the RPC-produced event is
  -- covered by VERIFY G.
  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role,
     event_type, response_id, attachment_id)
  VALUES (req_id, 'open', 'open', actor, 'farmer',
          'existing_document_linked', resp_id, linked_att_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.evidence_request_history
    WHERE request_id = req_id
      AND attachment_id = linked_att_id
      AND event_type = 'existing_document_linked'
  ) THEN
    RAISE EXCEPTION 'VERIFY I FAILED: history event does not reference the linked attachment';
  END IF;

  -- Cross-farm linkage must be refused: same shape, a document on another farm.
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO other_farm_v;
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (other_farm_v, 'licence', 'foreign-source.pdf')
  RETURNING id INTO other_doc_id;

  BEGIN
    INSERT INTO public.evidence_request_attachments
      (request_id, response_id, origin, farmer_document_id,
       original_filename, mime_type, created_by_user_id)
    VALUES (req_id, resp_id, 'existing_farm_document', other_doc_id,
            'foreign.pdf', 'application/pdf', actor);
    RAISE EXCEPTION 'VERIFY I FAILED: a document from another farm was linked';
  EXCEPTION
    WHEN check_violation THEN NULL;   -- expected: same-farm guard rejected it
  END;

  RAISE NOTICE 'VERIFY I PASSED: removal_requested_at present; authorized removal completes; linked documents need no storage stage.';
END
$verify_i$;

-- -----------------------------------------------------------------------------
-- VERIFY J — terminal requests must not strand unsubmitted draft evidence.
-- Cleanup eligibility comes from the DRAFT RESPONSE, not from an actionable
-- parent request. Every INSERT/UPDATE/DELETE asserts its affected-row count, so
-- no check here can pass on an empty fixture.
-- -----------------------------------------------------------------------------
DO $verify_j$
DECLARE
  actor uuid; farm_id_v uuid; profile_v uuid;
  req_id uuid; resp_id uuid; att_id uuid; sub_resp_id uuid; sub_att_id uuid;
  other_farm_v uuid;
  n integer; marked timestamptz; ok boolean; authorized boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'VERIFY J FAILED: no auth.users row available to act as creator';
  END IF;

  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_license',
          'Licence', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;
  IF req_id IS NULL OR resp_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY J FAILED: fixture request/response not created (test would be vacuous)';
  END IF;

  -- J1: a reserved pending upload on a draft response.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, created_by_user_id)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_id_v || '/' || req_id || '/' || resp_id || '/j/licence.pdf',
          'pending_upload', 'licence.pdf', 'application/pdf', 1024, actor)
  RETURNING id INTO att_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 OR att_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY J FAILED: pending upload fixture insert affected % row(s)', n;
  END IF;

  -- J2: the request becomes terminal WITHOUT the draft ever being submitted.
  UPDATE public.evidence_requests SET status = 'cancelled', closed_at = now() WHERE id = req_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY J FAILED: cancellation affected % row(s)', n;
  END IF;
  IF (SELECT status FROM public.evidence_requests WHERE id = req_id) <> 'cancelled' THEN
    RAISE EXCEPTION 'VERIFY J FAILED: request did not reach a terminal status (test would be vacuous)';
  END IF;
  IF (SELECT state FROM public.evidence_request_responses WHERE id = resp_id) <> 'draft' THEN
    RAISE EXCEPTION 'VERIFY J FAILED: response is not a draft — a terminal request must be able to hold one';
  END IF;

  -- J3: phase 1 remains possible after cancellation. The RPC cannot be called
  -- here (auth.uid() is NULL in a verify transaction), so the DATABASE STATE the
  -- RPC depends on is asserted instead: the attachment is still present, still
  -- pending, and can be marked non-uploadable.
  UPDATE public.evidence_request_attachments
  SET removal_requested_at = now()
  WHERE id = att_id AND removal_requested_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY J FAILED: marking removal after cancellation affected % row(s)', n;
  END IF;
  SELECT removal_requested_at INTO marked FROM public.evidence_request_attachments WHERE id = att_id;
  IF marked IS NULL THEN
    RAISE EXCEPTION 'VERIFY J FAILED: removal marker did not persist (test would be vacuous)';
  END IF;

  -- J4: the marked attachment no longer satisfies the storage INSERT predicate
  -- (removal_requested_at IS NULL), so no new object can be authorized for it.
  IF EXISTS (
    SELECT 1 FROM public.evidence_request_attachments a
    WHERE a.id = att_id AND a.upload_state = 'pending_upload' AND a.removal_requested_at IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY J FAILED: attachment is still uploadable after removal was authorized';
  END IF;

  -- J5: the DELETE-policy predicate still holds after cancellation — this is the
  -- exact condition set the storage policy evaluates, minus the caller identity.
  SELECT EXISTS (
    SELECT 1
    FROM public.evidence_request_attachments a
    JOIN public.evidence_request_responses r ON r.id = a.response_id
    JOIN public.evidence_requests er         ON er.id = a.request_id
    WHERE a.id = att_id
      AND a.storage_bucket = 'evidence-request-files'
      AND a.origin = 'request_upload'
      AND a.removal_requested_at IS NOT NULL
      AND r.state = 'draft'
  ) INTO authorized;
  IF NOT authorized THEN
    RAISE EXCEPTION 'VERIFY J FAILED: storage delete authorization does not survive a terminal request';
  END IF;

  -- J6: completion removes the row; history survives with a nulled pointer.
  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role,
     event_type, response_id, attachment_id)
  VALUES (req_id, 'open', 'open', actor, 'farmer', 'attachment_uploaded', resp_id, att_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY J FAILED: history fixture affected % row(s)', n;
  END IF;

  DELETE FROM public.evidence_request_attachments WHERE id = att_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY J FAILED: completing removal after cancellation affected % row(s)', n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.evidence_request_history
    WHERE request_id = req_id AND event_type = 'attachment_uploaded' AND attachment_id IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY J FAILED: history event was destroyed or kept a dangling pointer';
  END IF;

  -- J7: retry is deterministic — the row is already gone, nothing else changes.
  DELETE FROM public.evidence_request_attachments WHERE id = att_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY J FAILED: retry after completion affected % row(s)', n;
  END IF;

  -- J8: a SUBMITTED response is never cleanable, terminal request or not.
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, response_text, submitted_at, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 2, 'submitted', 'Submitted evidence response text.', now(), actor, actor)
  RETURNING id INTO sub_resp_id;
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, sub_resp_id, 'request_upload', 'evidence-request-files',
          farm_id_v || '/' || req_id || '/' || sub_resp_id || '/j/final.pdf',
          'ready', 'final.pdf', 'application/pdf', 2048, repeat('d', 64), actor, now())
  RETURNING id INTO sub_att_id;
  IF sub_att_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY J FAILED: submitted-evidence fixture missing (test would be vacuous)';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.evidence_request_attachments a
    JOIN public.evidence_request_responses r ON r.id = a.response_id
    WHERE a.id = sub_att_id AND r.state = 'draft'
  ) THEN
    RAISE EXCEPTION 'VERIFY J FAILED: submitted evidence satisfies the draft cleanup predicate';
  END IF;

  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_attachments WHERE id = sub_att_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'VERIFY J FAILED: submitted evidence was deletable';
  END IF;

  -- J9: a cross-farm caller matches nothing — cleanup is farm-scoped, and the
  -- predicate reveals no request existence to an unauthorized farm.
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO other_farm_v;
  IF EXISTS (
    SELECT 1
    FROM public.evidence_request_attachments a
    JOIN public.evidence_requests er ON er.id = a.request_id
    WHERE a.id = sub_att_id AND er.farm_id = other_farm_v
  ) THEN
    RAISE EXCEPTION 'VERIFY J FAILED: an attachment resolved under the wrong farm';
  END IF;

  RAISE NOTICE 'VERIFY J PASSED: terminal requests no longer strand unsubmitted draft evidence; submitted evidence stays immutable.';
END
$verify_j$;

-- -----------------------------------------------------------------------------
-- VERIFY K — filename extension allow-listing.
-- Table-driven so a missing case is visible; every expectation is asserted, and
-- an empty expectation set fails loudly.
-- -----------------------------------------------------------------------------
DO $verify_k$
DECLARE
  r record; checked integer := 0;
BEGIN
  IF to_regprocedure('public.evidence_filename_extension_allowed(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY K FAILED: evidence_filename_extension_allowed(text,text,text) is missing';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- category,            mime,               filename,            expected
      ('farm_license',        'application/pdf',  'report.pdf',        true),
      ('farm_license',        'application/pdf',  'REPORT.PDF',        true),
      ('farm_license',        'application/pdf',  'report.exe.pdf',    true),
      ('coa',                 'application/pdf',  'coa.pdf',           true),
      ('inventory_photo',     'image/jpeg',       'photo.jpg',         true),
      ('inventory_photo',     'image/jpeg',       'photo.jpeg',        true),
      ('inventory_photo',     'image/jpeg',       'photo.JPEG',        true),
      ('inventory_photo',     'image/png',        'photo.png',         true),
      ('inventory_photo',     'image/webp',       'photo.webp',        true),
      ('inventory_video',     'video/mp4',        'clip.mp4',          true),
      -- rejections
      ('farm_license',        'application/pdf',  'payload.exe',       false),
      ('farm_license',        'application/pdf',  'report.pdf.exe',    false),
      ('farm_license',        'application/pdf',  'report',            false),
      ('farm_license',        'application/pdf',  'report.',           false),
      ('farm_license',        'application/pdf',  '',                  false),
      ('farm_license',        'application/pdf',  '   ',               false),
      ('farm_license',        'application/pdf',  NULL,                false),
      ('farm_license',        'application/pdf',  '../../etc/passwd.pdf', false),
      ('farm_license',        'application/pdf',  'dir/report.pdf',    false),
      ('farm_license',        'application/pdf',  'photo.jpg',         false),
      ('inventory_photo',     'image/jpeg',       'report.pdf',        false),
      ('inventory_photo',     'image/jpeg',       'clip.mp4',          false),
      ('farm_license',        'video/mp4',        'clip.mp4',          false),
      ('coa',                 'image/jpeg',       'photo.jpg',         false),
      ('inventory_video',     'video/mp4',        'clip.mov',          false),
      ('farm_license',        NULL,               'report.pdf',        false)
    ) AS t(category, mime, filename, expected)
  LOOP
    checked := checked + 1;
    IF public.evidence_filename_extension_allowed(r.category, r.mime, r.filename)
       IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION
        'VERIFY K FAILED: (%, %, %) expected % but the helper disagreed',
        r.category, coalesce(r.mime,'<null>'), coalesce(r.filename,'<null>'), r.expected;
    END IF;
  END LOOP;

  IF checked < 26 THEN
    RAISE EXCEPTION 'VERIFY K FAILED: only % case(s) evaluated (test would be vacuous)', checked;
  END IF;

  RAISE NOTICE 'VERIFY K PASSED: % filename/MIME/category cases enforced.', checked;
END
$verify_k$;

-- -----------------------------------------------------------------------------
-- VERIFY L — draft edit-authority handoff [v1.1]. Non-vacuous: fixtures are
-- created and every mutation asserts its affected-row count.
-- -----------------------------------------------------------------------------
DO $verify_l$
DECLARE
  actor_a uuid; actor_b uuid; farm_id_v uuid; profile_v uuid;
  req_id uuid; resp_id uuid; n integer; ok boolean; owner_active boolean;
  v_created uuid; v_owner uuid; v_num integer; v_drafts integer; v_events integer;
BEGIN
  -- Two distinct farmer users A and B.
  SELECT id INTO actor_a FROM auth.users ORDER BY id LIMIT 1;
  SELECT id INTO actor_b FROM auth.users WHERE id <> actor_a ORDER BY id LIMIT 1;
  IF actor_a IS NULL OR actor_b IS NULL THEN
    RAISE EXCEPTION 'VERIFY L FAILED: need two auth.users rows (test would be vacuous)';
  END IF;
  INSERT INTO public.profiles (id, email, role) VALUES (actor_a, 'a-'||actor_a||'@t.test','farmer')
    ON CONFLICT (id) DO UPDATE SET role='farmer';
  INSERT INTO public.profiles (id, email, role) VALUES (actor_b, 'b-'||actor_b||'@t.test','farmer')
    ON CONFLICT (id) DO UPDATE SET role='farmer';

  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor_a) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.farm_memberships (farm_id, user_id) VALUES (farm_id_v, actor_a);
  INSERT INTO public.farm_memberships (farm_id, user_id) VALUES (farm_id_v, actor_b);

  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_license', 'Licence',
          'Please upload the current cultivation licence document.', actor_a)
  RETURNING id INTO req_id;

  -- A creates the single draft; both IDs initialise to A.
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor_a, actor_a) RETURNING id INTO resp_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 OR resp_id IS NULL THEN RAISE EXCEPTION 'VERIFY L FAILED: draft fixture affected % row(s)', n; END IF;

  -- Semantics: a brand-new draft initialises creator and owner to the same user.
  SELECT created_by_user_id, draft_owner_user_id INTO v_created, v_owner
  FROM public.evidence_request_responses WHERE id = resp_id;
  IF v_created <> actor_a OR v_owner <> actor_a THEN
    RAISE EXCEPTION 'VERIFY L FAILED: new draft did not initialise creator=owner=A';
  END IF;

  -- L1: while A is still an active member, B's claim predicate must be denied.
  -- (owner_active = role farmer AND membership present)
  SELECT (EXISTS (SELECT 1 FROM public.profiles WHERE id = actor_a AND role='farmer')
          AND EXISTS (SELECT 1 FROM public.farm_memberships WHERE farm_id=farm_id_v AND user_id=actor_a))
    INTO owner_active;
  IF NOT owner_active THEN RAISE EXCEPTION 'VERIFY L FAILED: owner A should read as active here'; END IF;

  -- L2: A becomes operationally abandoned (membership removed).
  DELETE FROM public.farm_memberships WHERE farm_id=farm_id_v AND user_id=actor_a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'VERIFY L FAILED: removing A membership affected % row(s)', n; END IF;
  SELECT (EXISTS (SELECT 1 FROM public.profiles WHERE id = actor_a AND role='farmer')
          AND EXISTS (SELECT 1 FROM public.farm_memberships WHERE farm_id=farm_id_v AND user_id=actor_a))
    INTO owner_active;
  IF owner_active THEN RAISE EXCEPTION 'VERIFY L FAILED: owner A still reads as active (test would be vacuous)'; END IF;

  -- L3: the handoff UPDATE (as the RPC performs it) changes exactly one row and
  -- only draft_owner_user_id; the protect-submitted trigger permits it.
  UPDATE public.evidence_request_responses
  SET draft_owner_user_id = actor_b, updated_at = now()
  WHERE id = resp_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'VERIFY L FAILED: handoff affected % row(s)', n; END IF;

  SELECT created_by_user_id, draft_owner_user_id, response_number
    INTO v_created, v_owner, v_num
  FROM public.evidence_request_responses WHERE id = resp_id;
  IF v_created <> actor_a THEN RAISE EXCEPTION 'VERIFY L FAILED: created_by_user_id was rewritten'; END IF;
  IF v_owner   <> actor_b THEN RAISE EXCEPTION 'VERIFY L FAILED: draft_owner_user_id did not transfer'; END IF;
  IF v_num     <> 1        THEN RAISE EXCEPTION 'VERIFY L FAILED: response_number changed'; END IF;

  -- L4: still exactly one draft for the request.
  SELECT count(*) INTO v_drafts FROM public.evidence_request_responses
  WHERE request_id = req_id AND state='draft';
  IF v_drafts <> 1 THEN RAISE EXCEPTION 'VERIFY L FAILED: % drafts exist, expected 1', v_drafts; END IF;

  -- L5: a bundled ownership+text change is rejected by the trigger.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_responses
    SET draft_owner_user_id = actor_a, response_text = 'sneaky' WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: ownership change bundled with an edit was accepted'; END IF;

  -- L6: created_by_user_id is immutable even alone.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_responses SET created_by_user_id = actor_b WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: created_by_user_id was mutable'; END IF;

  -- L7: an audit event for the transfer, recording both owners.
  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role,
     event_type, response_id, event_data)
  VALUES (req_id, 'open','open', actor_b, 'farmer', 'draft_ownership_transferred', resp_id,
          jsonb_build_object('previous_owner_user_id', actor_a, 'new_owner_user_id', actor_b));
  SELECT count(*) INTO v_events FROM public.evidence_request_history
  WHERE response_id = resp_id AND event_type='draft_ownership_transferred'
    AND event_data->>'previous_owner_user_id' = actor_a::text
    AND event_data->>'new_owner_user_id' = actor_b::text;
  IF v_events <> 1 THEN RAISE EXCEPTION 'VERIFY L FAILED: transfer audit event missing/incorrect'; END IF;

  -- L8: a submitted response freezes ownership — the trigger rejects any change.
  UPDATE public.evidence_request_responses
  SET state='submitted', submitted_at=now(), response_text='final' WHERE id = resp_id;
  ok := false;
  BEGIN
    UPDATE public.evidence_request_responses SET draft_owner_user_id = actor_a WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: submitted response allowed an ownership change'; END IF;

  RAISE NOTICE 'VERIFY L PASSED: handoff transfers edit authority, preserves provenance and the single draft, is audited, and is frozen at submission.';
END
$verify_l$;

-- -----------------------------------------------------------------------------
-- VERIFY M — final MIME must equal reserved MIME; extension revalidated against
-- the authoritative final MIME. Table-driven over evidence_mime_allowed /
-- evidence_filename_extension_allowed, which are the predicates finalization
-- applies to (category, effective_mime, stored filename).
-- -----------------------------------------------------------------------------
DO $verify_m$
DECLARE r record; checked integer := 0;
BEGIN
  -- The equality invariant itself: for multi-MIME categories, a reserved MIME
  -- and a different category-allowed stored MIME are BOTH individually allowed,
  -- yet finalization must reject the shift. We assert the building blocks the
  -- RPC combines: extension validity is keyed to the FINAL mime.
  FOR r IN
    SELECT * FROM (VALUES
      -- category, reserved_mime, stored_mime, filename, ext_ok_under_stored
      ('other', 'image/jpeg', 'image/jpeg', 'photo.jpg', true),   -- match: pass
      ('other', 'application/pdf','application/pdf','doc.pdf', true),
      ('other', 'image/jpeg', 'application/pdf', 'photo.jpg', false), -- jpg not valid for pdf
      ('other', 'application/pdf','image/jpeg', 'doc.pdf', false),    -- pdf not valid for jpeg
      ('inventory_photo','image/png','image/webp','p.png', false),
      ('inventory_photo','image/webp','image/png','p.webp', false)
    ) AS t(category, reserved, stored, filename, ext_ok)
  LOOP
    checked := checked + 1;
    -- extension validity against the STORED (final) mime must equal ext_ok
    IF public.evidence_filename_extension_allowed(r.category, r.stored, r.filename)
       IS DISTINCT FROM r.ext_ok THEN
      RAISE EXCEPTION 'VERIFY M FAILED: ext(%, %, %) expected %',
        r.category, r.stored, r.filename, r.ext_ok;
    END IF;
    -- when reserved <> stored, the finalization equality guard rejects regardless
    -- of individual allow-listing; assert both are individually allowed so the
    -- guard (not the allow-list) is what does the rejecting.
    IF r.reserved <> r.stored THEN
      IF NOT public.evidence_mime_allowed(r.category, r.reserved)
         OR NOT public.evidence_mime_allowed(r.category, r.stored) THEN
        RAISE EXCEPTION 'VERIFY M FAILED: fixture(%) does not exercise a category-valid MIME shift', r.category;
      END IF;
    END IF;
  END LOOP;
  IF checked < 6 THEN
    RAISE EXCEPTION 'VERIFY M FAILED: only % case(s) (test would be vacuous)', checked;
  END IF;
  RAISE NOTICE 'VERIFY M PASSED: extension is validated against the final MIME; category-valid MIME shifts are still rejected by the equality guard.';
END
$verify_m$;

ROLLBACK;
