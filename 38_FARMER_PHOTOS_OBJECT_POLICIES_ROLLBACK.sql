-- =============================================================================
-- Migration 38 — ROLLBACK: farmer-photos object policies
--
-- Removes the three policies migration 38 created, and nothing else.
--
-- EFFECT: farmer-photos returns to having NO object policies. Under RLS that makes
-- the bucket inaccessible to every caller — including admins, because
-- `farmer-documents: admin all` is scoped to the other bucket. That is the
-- pre-migration-38 state and it is FAIL-CLOSED: no data is exposed, but photo
-- upload and read stop working. Expect it; do not diagnose it as a new fault.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--   * Bucket privacy. Migration 37 owns that, and no rollback here should make a
--     bucket public — a rollback undoes a change, it does not reintroduce a
--     vulnerability.
--   * The farmer-photos BUCKET itself, or any object in it. Policies govern access,
--     not data; dropping them destroys nothing.
--   * The three farmer-documents policies, and migration 22's RESTRICTIVE overlay.
--     Migration 38 created neither.
--
-- Requires ownership of storage.objects, same as the hardening file.
-- =============================================================================

BEGIN;

DO $rollback_precondition$
DECLARE
  v_owner     text;
  v_owner_oid oid;
BEGIN
  SELECT c.relowner, pg_get_userbyid(c.relowner)
    INTO v_owner_oid, v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'rollback 38 precondition failed: storage.objects does not exist.';
  END IF;

  IF NOT pg_has_role(current_user, v_owner_oid, 'USAGE') THEN
    RAISE EXCEPTION
      'rollback 38 precondition failed: current_user "%" is not a member of "%", which owns '
      'storage.objects. DROP POLICY would fail. Re-run as a role holding that membership.',
      current_user, v_owner;
  END IF;
END
$rollback_precondition$;

DROP POLICY IF EXISTS "farmer-photos: admin all"         ON storage.objects;
DROP POLICY IF EXISTS "farmer-photos: farmer read own"   ON storage.objects;
DROP POLICY IF EXISTS "farmer-photos: farmer upload own" ON storage.objects;

DO $rollback_report$
BEGIN
  RAISE NOTICE
    'rollback 38 complete: the 3 farmer-photos object policies are removed. The bucket and '
    'every object in it are untouched, and bucket privacy remains public = false. '
    'farmer-photos is now inaccessible to all callers (fail-closed) until migration 38 is '
    're-applied.';
END
$rollback_report$;

COMMIT;
