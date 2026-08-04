-- Pre-migration-22 RLS posture.
--
-- Migration 22's hardening enables row-level security on eleven tables and
-- comments the statement "Safety no-op if RLS is already enabled (it is, per the
-- audit)". Its ROLLBACK correspondingly disables RLS on none of them -- which is
-- correct if, and only if, RLS really was already on before 22 ran.
--
-- The repository does record that state, in RLS_ENABLE_STAGED.sql, but that file
-- cannot be chained here: it issues bare CREATE POLICY statements for policies the
-- substrate already carries and collides instead of layering. This stage
-- reproduces only the part migration 22 depends on -- the RLS flags, on the tables
-- RLS_ENABLE_STAGED.sql names -- and creates no policy.
--
-- Without it the fixture reports five tables left RLS-enabled by 22's rollback and
-- accuses a correct rollback of a defect that belongs to the substrate.

ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ddp_scores    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_flags    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;

-- Remove migration 22's own helper from the pre-22 world.
--
-- The substrate defines has_operational_farmer_access() because five fixtures for
-- LATER migrations reference it and legitimately run in a world where 22 is
-- applied. For this fixture -- the one that applies 22 itself -- carrying it is
-- simply wrong: 22 creates the function and its rollback drops it, so a baseline
-- holding it makes that correct DROP look like over-reach on the function and its
-- three grants.
--
-- This stage runs BEFORE the symmetry baseline is captured (the baseline is taken
-- immediately before the first stage the rollback reverses, which is 22), so
-- dropping it here is what puts the substrate into a genuine pre-22 state rather
-- than papering over the result.
DROP FUNCTION IF EXISTS public.has_operational_farmer_access();
