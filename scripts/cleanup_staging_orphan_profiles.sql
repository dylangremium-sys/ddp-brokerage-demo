-- Defensive orphan-profiles cleanup (guarded, staging-only).
--
-- Normally a NO-OP: public.profiles.id -> auth.users(id) is ON DELETE CASCADE,
-- so deleting a user in the Supabase dashboard already removes their profile.
-- This exists only to sweep any profile row whose auth.users row is gone (e.g.
-- if a profile was ever created out of band). It NEVER touches auth.users.
--
-- Run with:
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SET ddp.reset.confirm='YES_CLEAN_ORPHAN_PROFILES';" \
--     -f scripts/cleanup_staging_orphan_profiles.sql
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_confirm text := current_setting('ddp.reset.confirm', true);
  n_orphan  int;
BEGIN
  IF v_confirm IS DISTINCT FROM 'YES_CLEAN_ORPHAN_PROFILES' THEN
    RAISE EXCEPTION 'Refusing cleanup: set ddp.reset.confirm=YES_CLEAN_ORPHAN_PROFILES';
  END IF;

  SELECT count(*) INTO n_orphan
    FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);
  RAISE NOTICE 'orphan profiles found: %', n_orphan;

  DELETE FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);

  RAISE NOTICE 'orphan profiles deleted: %', n_orphan;
END $$;

COMMIT;
