-- ===========================================================================
-- 35_STATUS_TRANSITION_ATOMIC_HARDENING.sql
-- ---------------------------------------------------------------------------
-- Makes a farm/batch status transition and its status_history record ONE
-- transaction, closing audit finding R7.
--
-- STATUS — BY ENVIRONMENT (never state "applied" without naming the environment):
--   • Repository : committed, awaiting review.
--   • STAGING    : NOT applied. NOT run.
--   • PRODUCTION : NOT applied. NOT run. NOT deployed. A production change freeze
--                  is active (docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md); this
--                  migration is NOT part of any authorised break-glass change.
--
-- WHY (audit finding R7)
-- ----------------------
-- src/lib/db.ts:302 (farms) and src/lib/db.ts:404 (inventory_batches) each issue
-- TWO independent PostgREST calls: an entity UPDATE, then a status_history
-- INSERT. There is no transaction around them. sbInsert throws on any error
-- (src/lib/db.ts:28-34), so when the history insert fails the operator is shown a
-- FAILED action while the row is ALREADY at the new status in the database.
--
-- status_history is the compliance artefact. The failure mode is therefore silent
-- divergence between the state and the record of how it was reached, plus an
-- error message that is the opposite of what happened.
--
-- WHAT
--   • public.record_status_transition(...) — performs the UPDATE and the INSERT
--     in a single function body, which is a single transaction. Either both land
--     or neither does.
--   • Returns the id of the status_history row it wrote, so the caller has proof
--     the audit record exists rather than an assumption.
--
-- AUTHORISATION — derived from the deployed policy set, not assumed
-- -----------------------------------------------------------------
-- A SECURITY DEFINER function bypasses RLS, so its predicate IS the access
-- control. Getting this wrong converts an atomicity fix into privilege
-- escalation. The predicate below was derived by reading production's policies
-- (measured 2026-07-28, read-only via ddp_ro), not from the finding text.
--
-- Effective authorisation TODAY for the two-statement sequence this replaces:
--
--   farms UPDATE
--     RESTRICTIVE "farms: operational farmer or admin"
--        (has_operational_farmer_access() OR is_ddp_admin())
--     AND ( PERMISSIVE "farms: admin all"          is_ddp_admin()
--         OR PERMISSIVE "farms: farmer update own"  farm_memberships match )
--
--   inventory_batches UPDATE
--     RESTRICTIVE "inventory_batches: operational farmer or admin"
--     AND ( PERMISSIVE "inventory_batches: admin all"
--         OR PERMISSIVE "inventory_batches: farmer update own", whose WITH CHECK
--           additionally forbids client_visible = true, status = 'Approved', and
--           stock_status IN (approved_internal, client_visible, reserved, sold) )
--
--   status_history INSERT
--     RESTRICTIVE "status_history: operational farmer or admin"
--     AND ( PERMISSIVE "status_history: admin all"  is_ddp_admin() )
--     — and NOTHING ELSE. "status_history: farmer select own" is SELECT-only.
--
-- That last line is decisive: **only a ddp_admin can insert into status_history
-- today.** A farmer attempting this sequence already fails at the second call
-- with 42501 — which is R7's divergence firing on every farmer transition, not
-- merely on transient errors.
--
-- So this function requires is_ddp_admin(). Admitting operational farmers would
-- grant, through a SECURITY DEFINER function, a write that RLS refuses them
-- today — a widening dressed as a bug fix. Both layers are asserted separately
-- below so the reason each exists stays legible; the restrictive-overlay check is
-- redundant for an admin and is kept as documentation and as a tripwire should
-- migration 22's overlay ever be narrowed.
--
-- If a farmer-initiated transition is wanted later, that is a product decision
-- requiring its own permissive status_history INSERT policy — not a side effect
-- of this migration.
--
-- OTHER AUTHORITATIVE-SOURCE DECISIONS
--   • old_status is read from the row inside the transaction. The client's value
--     is advisory only. An audit record must say what the status ACTUALLY was,
--     not what a possibly-stale browser believed.
--   • The reviewer is auth.uid(). A caller-supplied p_reviewer_id that disagrees
--     is REFUSED rather than ignored, so a transition cannot be attributed to
--     another administrator. Same standard migrations 17, 30 and 34 set.
--
-- SAFETY
--   • Additive only. Creates one function. Touches no existing table, column,
--     policy, trigger or privilege. The old two-call path keeps working
--     unchanged for any caller that does not adopt the RPC.
--   • Idempotent (CREATE OR REPLACE, explicit REVOKE/GRANT).
--   • Paired with 35_..._VERIFY.sql and 35_..._ROLLBACK.sql per repo convention.
--   • The client feature-detects the function and degrades ONLY on 42P01/PGRST205
--     (src/lib/db.ts), so applying this before or after the app deploy is safe.
--
-- MIGRATION NUMBER
-- ----------------
-- 35. Numbers 27 and 28 are claimed by PRs #44 and #73; 31, 32 and 33 are claimed
-- by the local branch feature/coa-source-bound-watchtower-review. 35 is the
-- lowest number never claimed on any ref. See docs/MIGRATION_NUMBER_REGISTER.md.
--
-- Preconditions: public.status_history, public.farms, public.inventory_batches,
-- public.is_ddp_admin(), public.has_operational_farmer_access(), auth.uid().
--
-- Verify:   35_STATUS_TRANSITION_ATOMIC_VERIFY.sql
-- Rollback: 35_STATUS_TRANSITION_ATOMIC_ROLLBACK.sql
-- ===========================================================================

BEGIN;

DO $precondition$
DECLARE
  missing text[] := '{}';
BEGIN
  IF to_regclass('public.status_history')    IS NULL THEN missing := missing || 'public.status_history'::text; END IF;
  IF to_regclass('public.farms')             IS NULL THEN missing := missing || 'public.farms'::text; END IF;
  IF to_regclass('public.inventory_batches') IS NULL THEN missing := missing || 'public.inventory_batches'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='is_ddp_admin') THEN
    missing := missing || 'public.is_ddp_admin()'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='has_operational_farmer_access') THEN
    missing := missing || 'public.has_operational_farmer_access()'::text;
  END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'migration 35 precondition failed: missing %', array_to_string(missing, ', ');
  END IF;
END
$precondition$;

CREATE OR REPLACE FUNCTION public.record_status_transition(
  p_entity_type  text,
  p_entity_id    uuid,
  p_new_status   text,
  p_old_status   text DEFAULT NULL,
  p_reviewer_id  uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_old_status   text;
  v_history_id   uuid;
  v_updated      int;
BEGIN
  -- ---- Authorisation ------------------------------------------------------
  -- SECURITY DEFINER bypasses RLS, so these checks ARE the access control.

  -- An unauthenticated caller has no identity to attribute the transition to.
  -- Refuse with a reason rather than letting a NULL reviewer reach the record.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'record_status_transition: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;

  -- Layer 1 — migration 22's RESTRICTIVE overlay. Redundant for an admin (the
  -- next check is strictly narrower) and deliberately kept: if that overlay is
  -- ever narrowed, this function must narrow with it rather than outlive it.
  IF NOT (public.is_ddp_admin() OR public.has_operational_farmer_access()) THEN
    RAISE EXCEPTION 'record_status_transition: caller is not an operational farmer or administrator'
      USING ERRCODE = '42501';
  END IF;

  -- Layer 2 — status_history has exactly ONE permissive INSERT path, and it is
  -- is_ddp_admin(). Anything looser here would grant through this function a
  -- write that RLS refuses the same caller directly.
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION
      'record_status_transition: only a DDP administrator may record a status transition; '
      'status_history has no permissive INSERT policy for any other role'
      USING ERRCODE = '42501';
  END IF;

  -- ---- Input validation ---------------------------------------------------
  IF p_entity_type IS NULL OR p_entity_type NOT IN ('farm', 'inventory_batch') THEN
    RAISE EXCEPTION 'record_status_transition: entity_type must be ''farm'' or ''inventory_batch'', got %',
      coalesce(p_entity_type, '<null>')
      USING ERRCODE = '22023';
  END IF;

  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'record_status_transition: entity_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_new_status IS NULL OR length(btrim(p_new_status)) = 0 THEN
    RAISE EXCEPTION 'record_status_transition: new_status is required' USING ERRCODE = '22023';
  END IF;

  -- The reviewer is the authenticated caller, always. A supplied id that
  -- disagrees is a false-attribution attempt (or a client bug); either way it
  -- must not be silently accepted OR silently discarded.
  IF p_reviewer_id IS NOT NULL AND p_reviewer_id <> v_actor THEN
    RAISE EXCEPTION
      'record_status_transition: reviewer_id does not match the authenticated caller; '
      'a transition cannot be attributed to another administrator'
      USING ERRCODE = '42501';
  END IF;

  -- ---- The transition ------------------------------------------------------
  -- FOR UPDATE serialises concurrent transitions on the same row, so two
  -- administrators acting at once produce two ordered history rows rather than
  -- one lost update with a history entry that never happened.
  IF p_entity_type = 'farm' THEN
    SELECT status INTO v_old_status FROM public.farms WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_status_transition: farm % does not exist', p_entity_id
        USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.farms
       SET status      = p_new_status,
           reviewed_by = v_actor,
           updated_at  = NOW()
     WHERE id = p_entity_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSE
    SELECT status INTO v_old_status FROM public.inventory_batches WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_status_transition: inventory_batch % does not exist', p_entity_id
        USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.inventory_batches
       SET status      = p_new_status,
           reviewed_by = v_actor,
           updated_at  = NOW()
     WHERE id = p_entity_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  -- Defence in depth. The row was locked above, so this cannot legitimately be
  -- 0; if it ever is, abort rather than write a history row for an update that
  -- did not happen — which is the exact class of divergence this migration exists
  -- to prevent.
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'record_status_transition: expected to update exactly 1 row, updated %', v_updated
      USING ERRCODE = '25000';
  END IF;

  -- old_status is the value read from the row under lock. p_old_status is what
  -- the browser believed and is recorded nowhere: an audit record must state
  -- what was true, not what a stale client assumed.
  INSERT INTO public.status_history (entity_type, entity_id, old_status, new_status, note)
  VALUES (p_entity_type, p_entity_id, v_old_status, p_new_status, 'Reviewed by ' || v_actor::text)
  RETURNING id INTO v_history_id;

  RETURN v_history_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- ACL. Supabase default-grants EXECUTE on a new public function to PUBLIC, which
-- includes anon. Revoke first, then grant narrowly — the order matters, and
-- REVOKE FROM PUBLIC alone does not remove a direct grant to a role.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.record_status_transition(text, uuid, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_status_transition(text, uuid, text, text, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_status_transition(text, uuid, text, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.record_status_transition(text, uuid, text, text, uuid) IS
  'Atomically applies a farm/inventory_batch status change and its status_history '
  'record in one transaction (migration 35, audit R7). Administrator-only: '
  'status_history has no permissive INSERT policy for any other role. The reviewer '
  'is auth.uid() and old_status is read from the row under lock; both caller-supplied '
  'equivalents are advisory and a mismatched reviewer_id is refused.';

COMMIT;
