-- =============================================================================
-- Migration 37 — ROLLBACK: storage bucket privacy
--
-- WHAT THIS ROLLS BACK
--   The three `farmer-photos` object policies created by section 3 of
--   37_STORAGE_BUCKET_PRIVACY_HARDENING.sql. That is all it does by default.
--
-- WHAT THIS DELIBERATELY DOES NOT DO — read this before assuming it is incomplete
--
--   1. It does NOT set either bucket back to public.
--
--      A rollback exists to undo a change, not to reintroduce a vulnerability.
--      `public = true` on a farmer bucket means every COA and every farm photo is
--      served by URL to any caller, with RLS bypassed for reads. There is no
--      failed-deployment scenario in which restoring that is the correct
--      recovery, so this file offers no path to it — not even behind an opt-in.
--      Leaving the buckets private after a rollback is the intended end state,
--      not an incomplete reversal.
--
--      If a bucket genuinely must be made public — a decision with no current
--      justification in this system — that is a deliberate product change and
--      belongs in its own reviewed migration with its own written rationale, not
--      in a rollback script where it would arrive unannounced.
--
--   2. It does NOT delete the `farmer-photos` bucket.
--
--      Dropping a bucket destroys the objects inside it. Migration 37 may have
--      CREATED that bucket, which makes deletion look like a clean reversal — but
--      the bucket may equally have pre-existed, and objects may have been
--      uploaded since. This file cannot tell those cases apart with confidence,
--      and the consequence of guessing wrong is permanent loss of farmer
--      evidence.
--
--      Section 2 therefore refuses to delete it unless the operator states
--      intent explicitly AND the bucket is provably empty. Both conditions, not
--      either.
--
--   3. It does NOT touch the three existing `farmer-documents` policies, nor
--      migration 22's RESTRICTIVE overlay. Migration 37 never created those, so
--      removing them here would exceed the rollback's scope and would strip
--      controls this migration did not install.
--
-- EFFECT OF RUNNING THE DEFAULT PATH
--   `farmer-photos` returns to having no object policies. Under RLS that means
--   the bucket becomes inaccessible to every non-superuser caller — including
--   admins, because the `farmer-documents: admin all` policy is scoped to the
--   other bucket. That is the pre-migration-37 state as measured on Production
--   on 2026-07-26 ("farmer-photos carries no policy at all"). It is fail-closed:
--   no data is exposed, but farmer photo upload and read stop working. Expect
--   that, and do not diagnose it as a new fault.
--
-- Companion: 37_STORAGE_BUCKET_PRIVACY_HARDENING.sql
-- Verify:    37_STORAGE_BUCKET_PRIVACY_VERIFY.sql (will FAIL after this rollback,
--            correctly — sections A and B assert what this file removes)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Remove the farmer-photos object policies created by migration 37.
--
--    Requires membership in the owner of storage.objects (in Supabase:
--    supabase_storage_admin), same as the hardening file.
-- -----------------------------------------------------------------------------
DO $rollback_precondition$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'rollback 37 precondition failed: storage.objects does not exist.';
  END IF;

  IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
    RAISE EXCEPTION
      'rollback 37 precondition failed: current_user "%" is not a member of "%", which owns '
      'storage.objects. DROP POLICY would fail. Re-run as a role holding that membership.',
      current_user, v_owner;
  END IF;
END
$rollback_precondition$;

-- Nothing to drop: migration 37 creates no policies. Those are migration 38 and
-- are reversed by 38_..._ROLLBACK.sql. Dropping them here would exceed this
-- rollback's scope and remove controls migration 37 never installed.

-- -----------------------------------------------------------------------------
-- 2. Bucket deletion — refused by default.
--
--    Runs ONLY when both are true:
--      (a) the operator opted in, in this same transaction:
--            SET LOCAL bucket_privacy.rollback_destructive = 'true';
--      (b) the bucket contains zero objects.
--
--    Condition (b) is not negotiable by opt-in. An opt-in expresses intent; it
--    does not make destroying farmer evidence acceptable. If the bucket has
--    objects, this refuses regardless of the setting and tells the operator to
--    empty it deliberately first — at which point the deletion is their explicit,
--    separately-taken decision rather than a side effect of a rollback.
-- -----------------------------------------------------------------------------
DO $bucket_guard$
DECLARE
  v_exists  boolean;
  v_objects bigint := 0;
  v_opt_in  text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'farmer-photos') INTO v_exists;

  IF NOT v_exists THEN
    RAISE NOTICE 'rollback 37: farmer-photos bucket does not exist; nothing to delete.';
    RETURN;
  END IF;

  BEGIN
    v_opt_in := current_setting('bucket_privacy.rollback_destructive');
  EXCEPTION WHEN undefined_object THEN
    v_opt_in := NULL;
  END;

  IF v_opt_in IS DISTINCT FROM 'true' THEN
    RAISE NOTICE
      'rollback 37: farmer-photos bucket RETAINED (policies removed only). Deleting a bucket '
      'destroys the objects in it, and this rollback will not do that implicitly. To delete it '
      'deliberately, run  SET LOCAL bucket_privacy.rollback_destructive = ''true'';  in the same '
      'transaction — it will still refuse if the bucket is not empty.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_objects FROM storage.objects WHERE bucket_id = 'farmer-photos';

  IF v_objects > 0 THEN
    RAISE EXCEPTION
      'rollback 37 refused: farmer-photos contains % object(s). The destructive opt-in was '
      'given, but this file will not delete farmer evidence. Empty the bucket as a separate, '
      'deliberate act first, then re-run.', v_objects;
  END IF;

  DELETE FROM storage.buckets WHERE id = 'farmer-photos';

  RAISE NOTICE
    'rollback 37: destructive opt-in acknowledged and bucket was empty — farmer-photos deleted.';
END
$bucket_guard$;

-- -----------------------------------------------------------------------------
-- 3. State what was NOT reverted, so the operator is not misled by a clean exit.
-- -----------------------------------------------------------------------------
DO $rollback_report$
BEGIN
  RAISE NOTICE
    'rollback 37 complete. NOT reverted, by design: bucket privacy remains public = false on '
    'both farmer buckets (a rollback does not reintroduce a vulnerability). Also untouched: the '
    'farmer-documents policies and migration 22''s RESTRICTIVE overlay, neither of which '
    'migration 37 created.';
END
$rollback_report$;

COMMIT;
