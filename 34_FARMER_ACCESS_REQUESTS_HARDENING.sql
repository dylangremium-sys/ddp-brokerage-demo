-- =============================================================================
-- Migration 34 — Farmer access requests (truthful onboarding intake)
--
-- Problem this fixes, observed on the live site:
--
--   The public "Supplier signup" form collected a name, phone, province and
--   role, wrote them to the visitor's OWN localStorage, and routed to a farmer
--   dashboard that requires a session the form never created. Nothing reached a
--   server. The farmer had no account, no login, and lost the data on reload.
--   It also never asked for an EMAIL — yet onboarding is invite-by-email
--   (api/admin/provision-farmer.ts), so the form could not capture the one
--   field provisioning actually needs.
--
--   (src/pages/farmer/FarmerRegister.tsx, src/data.ts saveFarmDraft ->
--    localStorage.setItem, src/App.tsx onComplete -> goTo('farmer-dashboard'))
--
-- This migration gives that form somewhere real to go. It does NOT create
-- accounts: DDP provisioning is deliberately admin-only (migration 21), and
-- that model is preserved exactly. An access request is an ENQUIRY — a queue an
-- administrator works from — never an account and never a role.
--
-- Abuse posture: the insert policy is open to anon because the form is public,
-- which is the same exposure any public contact form carries. It is bounded by
-- column-level CHECK constraints (length caps, email shape) so a request cannot
-- be used to store bulk payloads, and anon CANNOT read back a single row — only
-- an administrator can. Rate limiting belongs at the edge, not in SQL; see
-- FOLLOW-UP in the accompanying notes.
--
-- Verify:   34_FARMER_ACCESS_REQUESTS_VERIFY.sql
-- Rollback: 34_FARMER_ACCESS_REQUESTS_ROLLBACK.sql
--
-- Preconditions: public.is_ddp_admin() (AUTH_RLS_SCHEMA / migration 3).
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_ddp_admin'
  ) THEN
    RAISE EXCEPTION 'migration 34 precondition failed: public.is_ddp_admin() is missing';
  END IF;
END
$precondition$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. The intake table.
--
-- Every free-text column is length-capped. A public form is an untrusted input
-- surface, and an unbounded TEXT column is a storage-abuse vector.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.farmer_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  full_name TEXT NOT NULL
    CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),

  -- Required because provisioning invites BY EMAIL. Shape-checked only: real
  -- validation is the invite actually arriving.
  email TEXT NOT NULL
    CHECK (length(email) BETWEEN 5 AND 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  phone TEXT NOT NULL
    CHECK (length(btrim(phone)) BETWEEN 5 AND 40),

  province TEXT NOT NULL DEFAULT ''
    CHECK (length(province) <= 80),

  position TEXT NOT NULL DEFAULT ''
    CHECK (length(position) <= 60),

  preferred_language TEXT NOT NULL DEFAULT 'en'
    CHECK (preferred_language IN ('en', 'th')),

  note TEXT NOT NULL DEFAULT ''
    CHECK (length(note) <= 2000),

  -- Workflow. 'invited' means an administrator has sent a real invite through
  -- the provisioning endpoint; it does NOT itself grant anything.
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'invited', 'declined', 'duplicate')),

  review_note TEXT NOT NULL DEFAULT ''
    CHECK (length(review_note) <= 2000),

  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A reviewed request must name its reviewer, and vice versa.
  CONSTRAINT farmer_access_requests_review_pairing
    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT farmer_access_requests_reviewed_when_decided
    CHECK (status = 'new' OR reviewed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_farmer_access_requests_status
  ON public.farmer_access_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farmer_access_requests_email
  ON public.farmer_access_requests(lower(email));

-- -----------------------------------------------------------------------------
-- 2. RLS — public may SUBMIT, only an administrator may READ.
--
-- This asymmetry is the point. The form must work for a signed-out visitor, but
-- the queue contains personal data (names, phones, emails) and must never be
-- readable by the public, by a farmer, or by a pending account.
-- -----------------------------------------------------------------------------
ALTER TABLE public.farmer_access_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farmer_access_requests: public submit" ON public.farmer_access_requests;
CREATE POLICY "farmer_access_requests: public submit" ON public.farmer_access_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    -- A submitter may only create a NEW, unreviewed request. It cannot arrive
    -- pre-approved, and it cannot name a reviewer.
    status = 'new'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note = ''
  );

DROP POLICY IF EXISTS "farmer_access_requests: admin read" ON public.farmer_access_requests;
CREATE POLICY "farmer_access_requests: admin read" ON public.farmer_access_requests
  FOR SELECT USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer_access_requests: admin triage" ON public.farmer_access_requests;
CREATE POLICY "farmer_access_requests: admin triage" ON public.farmer_access_requests
  FOR UPDATE USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

-- Deliberately NO delete policy: an enquiry is a record of who asked for access.

-- -----------------------------------------------------------------------------
-- 3. Stamp the reviewer automatically, so triage cannot be attributed falsely.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_farmer_access_request_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Triage must be attributable. Without an authenticated actor the pairing
    -- constraint below would fire with an opaque message, so refuse here with a
    -- reason instead. This also blocks a SQL-level or service-role status change
    -- that would otherwise land with no named reviewer.
    IF v_actor IS NULL THEN
      RAISE EXCEPTION
        'farmer_access_requests: a status change requires an authenticated administrator; '
        'triage cannot be recorded without a named reviewer';
    END IF;

    NEW.reviewed_by := v_actor;
    NEW.reviewed_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

-- acl-no-grant: stamp_farmer_access_request_review
REVOKE EXECUTE ON FUNCTION public.stamp_farmer_access_request_review() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_farmer_access_request_review() FROM anon;
REVOKE EXECUTE ON FUNCTION public.stamp_farmer_access_request_review() FROM authenticated;

DROP TRIGGER IF EXISTS farmer_access_requests_stamp_review ON public.farmer_access_requests;
CREATE TRIGGER farmer_access_requests_stamp_review
  BEFORE UPDATE ON public.farmer_access_requests
  FOR EACH ROW EXECUTE FUNCTION public.stamp_farmer_access_request_review();

COMMIT;
