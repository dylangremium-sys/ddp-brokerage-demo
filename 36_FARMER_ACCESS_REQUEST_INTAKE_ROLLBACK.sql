-- ===========================================================================
-- 36_FARMER_ACCESS_REQUEST_INTAKE_ROLLBACK.sql
-- ---------------------------------------------------------------------------
-- Reverses 36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql, restoring migration
-- 34's exact intake posture.
--
-- *** WHAT REVERTING COSTS ***
-- This RE-OPENS audit finding R5 in full: `farmer_access_requests: public submit`
-- becomes the only anon-satisfiable write policy in the database again, `anon`
-- regains table-level INSERT, and the write returns to the browser → Supabase
-- path that no edge rate limiter can see. Any party can then insert unlimited
-- rows, bounded only by the ~2.5 KB column CHECKs.
--
-- Run it anyway if /api/public/access-request is broken or unconfigured: a
-- reachable form with a known abuse ceiling is better than a supplier funnel
-- that silently rejects every legitimate enquiry. That is a deliberate,
-- time-boxed trade, not a default.
--
-- DATA: public.public_intake_attempts is dropped with its rows. They are
-- throttle bookkeeping only — a salted hash and a timestamp, with no reference
-- to any request — so nothing evidentiary is lost. No farmer_access_requests row
-- is touched, read or deleted by this file.
--
-- Scope: only the objects and privilege changes migration 36 made. The
-- `admin read` and `admin triage` policies, the stamp trigger and the table
-- itself are untouched here, exactly as they were untouched by the forward
-- migration.
-- ===========================================================================

BEGIN;

-- 1. Restore migration 34's public INSERT policy, byte-for-byte in effect.
DROP POLICY IF EXISTS "farmer_access_requests: server submit" ON public.farmer_access_requests;

DROP POLICY IF EXISTS "farmer_access_requests: public submit" ON public.farmer_access_requests;
CREATE POLICY "farmer_access_requests: public submit" ON public.farmer_access_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    status = 'new'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note = ''
  );

-- 2. Restore the table-level grant the policy needs to be reachable.
GRANT INSERT ON public.farmer_access_requests TO anon;
GRANT INSERT ON public.farmer_access_requests TO authenticated;

-- 3. Drop the functions migration 36 added. Dropped BEFORE the table they read,
--    so the rollback does not depend on CASCADE ordering.
DROP FUNCTION IF EXISTS public.reserve_public_intake_slot(text, text, jsonb);
DROP FUNCTION IF EXISTS public.has_open_access_request(text);

-- 4. Drop the throttle ledger. Its indexes and policy go with it.
DROP TABLE IF EXISTS public.public_intake_attempts;

COMMIT;
