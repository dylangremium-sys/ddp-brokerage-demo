-- =============================================================================
-- 64_DOCUMENT_REVIEW_ATTRIBUTION_HARDENING.sql
--
-- Makes a document review decision say WHO made it.
--
-- WHAT IS WRONG TODAY — measured against production
--
--   farmer_documents.review_status   present  ('pending'|'accepted'|'rejected')
--   farmer_documents.reviewed_at     present
--   farmer_documents.reviewed_by     ABSENT
--
-- The register can record that a certificate was accepted, and when, and not by
-- whom. That is the same defect migration 63 closed on status_history, in the
-- one place it matters most: this is the decision a buyer ultimately relies on.
-- An accepted certificate with no named reviewer cannot be audited, cannot be
-- challenged, and cannot be defended.
--
-- Migration 63's own header called status_history "the audit-trail outlier".
-- This is the second one, and it was only visible because a review surface was
-- about to be built on top of it. Building that surface first would have shipped
-- a decision screen that could not say who decided.
--
-- WHY A TRIGGER RATHER THAN AN APPLICATION FIELD
-- The reviewer must not be chooseable by the caller. An admin able to write
-- `reviewed_by` directly could attribute their own decision to a colleague, and
-- a forged review record is worse than an absent one — it is an audit trail that
-- actively misleads. The trigger takes the identity from the session and
-- overwrites whatever was sent.
--
-- WHY THE CHECK REFUSES A DECISION WITH NO HUMAN
-- The project's standing rule is that AI may summarise verified evidence but may
-- never approve, and that only an authorised human administrator may make a
-- decision. `review_decision_requires_reviewer` is that rule expressed where it
-- cannot be bypassed. A consequence worth stating plainly rather than
-- discovering: a service-role or cron process has no auth.uid(), so it CANNOT
-- move a document out of 'pending'. That is the intent, not a limitation.
--
-- SAFE TO ADD NOW. public.farmer_documents holds 0 live rows, and no application
-- code updates review_status yet — the write path for uploads landed in #180 and
-- the review surface does not exist. The constraint therefore cannot invalidate
-- existing data, and defining it before the surface is built is the cheap order.
-- =============================================================================

BEGIN;

-- ── 1. The reviewer ─────────────────────────────────────────────────────────
-- Nullable, because a 'pending' document has not been reviewed by anyone and
-- must not pretend otherwise. ON DELETE SET NULL rather than CASCADE: removing a
-- staff account must never delete the evidence they reviewed.
ALTER TABLE public.farmer_documents
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.farmer_documents.reviewed_by IS
  'The administrator who accepted or rejected this document, forced from auth.uid() by fn_farmer_documents_set_reviewer (migration 64). NULL only while review_status is pending.';

-- ── 2. The reviewer is taken, never given ───────────────────────────────────
-- Fires only when review_status actually changes, so an unrelated UPDATE (a
-- later extraction writing lab_name, say) does not restamp a decision that was
-- made by someone else at another time.
CREATE OR REPLACE FUNCTION public.fn_farmer_documents_set_reviewer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    IF NEW.review_status = 'pending' THEN
      -- Returning a document to the queue is not a decision. Clearing both
      -- fields keeps the pairing honest rather than leaving a reviewer attached
      -- to a document nobody has currently decided on.
      NEW.reviewed_by := NULL;
      NEW.reviewed_at := NULL;
    ELSE
      -- Overwrite, never default: the caller does not get to choose who decided.
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS farmer_documents_set_reviewer ON public.farmer_documents;
CREATE TRIGGER farmer_documents_set_reviewer
  BEFORE UPDATE ON public.farmer_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_farmer_documents_set_reviewer();

-- Trigger-only function: PostgreSQL invokes it through the trigger mechanism,
-- which never checks EXECUTE, and it is SECURITY DEFINER — so a direct grant
-- would be a definer-rights entry point bought for nothing.
--
-- acl-no-grant: fn_farmer_documents_set_reviewer
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM service_role;

-- ── 3. A decision must name a human ─────────────────────────────────────────
-- The trigger fills these in; the constraint is what makes it impossible to
-- arrive at a decided state without them by any other route — a direct psql
-- UPDATE by a superuser included.
ALTER TABLE public.farmer_documents
  ADD CONSTRAINT review_decision_requires_reviewer
  CHECK (
    review_status = 'pending'
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  );

COMMIT;
