-- Pre-migration-21 world.
--
-- Migration 21's ROLLBACK opens with an ordering guard: it refuses to run while
-- migration 22 is applied, because 22's operational-farmer policies are written
-- in terms of the provisioning model 21 installs, and undoing 21 underneath them
-- would leave the farmer access path unreachable. The guard detects 22 by looking
-- for public.has_operational_farmer_access().
--
-- The substrate carries that function because five fixtures for LATER migrations
-- need it. For this fixture the guard is therefore always tripped -- not by a
-- defect, but by the substrate describing a world 21 was never meant to be rolled
-- back in. This stage puts it back into a genuine pre-22 state.
--
-- It runs BEFORE the symmetry baseline is captured (the baseline is taken
-- immediately before the first stage the rollback reverses, which is 21), so the
-- drop is part of the world, not a correction applied to the result.
--
-- What is NOT proven here: that the ordering guard fires. That property is real
-- and worth having, but this fixture is about 21's own reversibility.
DROP FUNCTION IF EXISTS public.has_operational_farmer_access();

-- The pre-21 provisioning model, copied from what 21's own ROLLBACK restores.
--
-- The substrate's handle_new_user() mints 'pending', which is the POST-21
-- behaviour -- correct for every fixture above 21 and wrong for this one. With a
-- 'pending' baseline the rollback restores a DIFFERENT function body than the one
-- it started from and the definition digest correctly reports it, so the mismatch
-- is real but belongs to the substrate, not to migration 21.
--
-- Body copied verbatim from 21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql so
-- the digests can match; the only difference that survives is the one migration 21
-- exists to make: 'farmer' here, 'pending' after.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    'farmer'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- The pre-21 role vocabulary: DEFAULT 'farmer' and a TWO-value CHECK.
--
-- Migration 21's whole purpose is to introduce 'pending' and stop new accounts
-- defaulting to an approved role, so a genuine pre-21 world has neither. The
-- substrate is modelled on current production — post-21 — and carries the
-- three-value CHECK with no default; without this stage the baseline is post-21
-- in exactly the respect the migration changes, and 21's rollback correctly
-- restoring the pre-21 shape is then reported as an asymmetry.
--
-- This was invisible until the catalog snapshot learned to see CHECK constraints
-- and column defaults (D7). Before that the fixture was passing on a baseline it
-- had never fully established, which is the same class of vacuity the coverage
-- denominator had: not a wrong answer, an unasked question.
ALTER TABLE public.profiles
  ALTER COLUMN role SET DEFAULT 'farmer';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('ddp_admin', 'farmer'));

-- profiles RLS and its three policies, as RLS_ENABLE_STAGED.sql establishes them.
-- Migration 21 replaces all three with DROP IF EXISTS + CREATE, so if its rollback
-- leaves a definition changed, that is a genuine finding rather than a gap here.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: select own or admin" ON public.profiles;
CREATE POLICY "profiles: select own or admin"
  ON public.profiles FOR SELECT
  USING (id = auth.uid() OR is_ddp_admin());

DROP POLICY IF EXISTS "profiles: update own no role change" ON public.profiles;
CREATE POLICY "profiles: update own no role change"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  );

DROP POLICY IF EXISTS "profiles: admin update role" ON public.profiles;
CREATE POLICY "profiles: admin update role"
  ON public.profiles FOR UPDATE
  USING (is_ddp_admin());
