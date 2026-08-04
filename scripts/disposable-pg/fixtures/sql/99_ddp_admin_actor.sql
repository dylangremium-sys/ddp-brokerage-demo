-- A ddp_admin profile, so migration 18's synthetic runtime checks actually run.
--
-- 18_SYNTHETIC_RUNTIME_VERIFY.sql opens by looking for a ddp_admin profile to act
-- as. Finding none it emits
--
--   NOTICE: SKIP  no ddp_admin profile exists — cannot supply a valid actor.
--                 Block 1 not run.
--
-- and continues. A fixture that applied 18 against an empty substrate would
-- therefore pass while its first block never executed — the same shape of
-- vacuity as the coverage denominator this whole phase exists to remove, one
-- level down. The SKIP is a NOTICE, not an error, so nothing about the run's
-- exit status would have revealed it.
--
-- The substrate ships auth.users rows but no profiles rows: profiles is
-- populated by handle_new_user(), which fires on INSERT to auth.users and so
-- never ran for rows the bootstrap created directly.
DO $actor$
DECLARE
  actor uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'fixture actor stage failed: no auth.users row to promote to ddp_admin';
  END IF;

  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (actor, 'fixture-admin@example.test', 'Fixture Admin', 'ddp_admin')
  ON CONFLICT (id) DO UPDATE SET role = 'ddp_admin';

  RAISE NOTICE 'fixture actor stage: ddp_admin profile % available.', actor;
END
$actor$;
