-- =============================================================================
-- 65_DOCUMENT_REVIEW_CLARIFICATION_ROLLBACK.sql
--
-- Restores farmer_documents to its post-64, pre-65 state: three review states,
-- no note, no document-review history.
--
-- READ THIS BEFORE RUNNING IT. It is destructive in two distinct ways, and the
-- second is worse than the first.
--
--   1. public.farmer_document_reviews is DROPPED. Every recorded review event —
--      who decided what, when, and why — is discarded. This is an audit trail;
--      re-applying migration 65 does not bring it back.
--
--   2. Any document currently in 'awaiting_clarification' is forced to
--      'pending', because the restored constraint does not admit the value.
--      A reasoned "this needs clarification" becomes an untouched upload, and
--      the note explaining it is dropped with the column. Section 3 does this
--      explicitly rather than letting the ADD CONSTRAINT fail, so that the
--      rollback is executable — but the information loss is real and is the
--      reason to prefer fixing forward.
--
-- It exists because the repo's rollback-symmetry check requires every migration
-- to have a proven reversal, and the check is right — not because reverting is
-- neutral.
-- =============================================================================

BEGIN;

-- ── 1. The event writer and the append-only guards ──────────────────────────
-- Guards first: while they stand, nothing may remove a row from the history,
-- and DROP TABLE on a guarded table is cleaner without them in place.
DROP TRIGGER IF EXISTS farmer_documents_write_review_event ON public.farmer_documents;
DROP TRIGGER IF EXISTS farmer_document_reviews_no_update_delete ON public.farmer_document_reviews;
DROP TRIGGER IF EXISTS farmer_document_reviews_no_truncate ON public.farmer_document_reviews;

DROP TABLE IF EXISTS public.farmer_document_reviews;

DROP FUNCTION IF EXISTS public.fn_farmer_document_review_event();
DROP FUNCTION IF EXISTS public.prevent_farmer_document_review_mutation();

-- ── 2. Migration 64's reviewer function, restored verbatim ──────────────────
-- Byte-for-byte the body migration 64 installed. The harness compares function
-- definitions across apply and rollback, so any drift here — a reworded comment
-- included — is a failure, and rightly: a rollback that leaves a subtly
-- different function behind has not restored anything, it has written a third
-- version nobody reviewed.
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

-- acl-no-grant: fn_farmer_documents_set_reviewer
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM service_role;

-- ── 3. Retire the value the restored vocabulary cannot hold ─────────────────
-- Runs after section 2, so the trigger in force is migration 64's, which asks
-- for no note and clears the attribution on the way to 'pending'. Doing this
-- before the ADD CONSTRAINT in section 5 is what stops that statement failing
-- on live data. See the header: this is information loss, not a no-op.
UPDATE public.farmer_documents
SET review_status = 'pending'
WHERE review_status = 'awaiting_clarification';

-- ── 4. The note, and the constraint that required it ────────────────────────
ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS review_decision_requires_note;

ALTER TABLE public.farmer_documents
  DROP COLUMN IF EXISTS review_note;

-- ── 5. The three-value vocabulary ───────────────────────────────────────────
ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS farmer_documents_review_status_check;

ALTER TABLE public.farmer_documents
  ADD CONSTRAINT farmer_documents_review_status_check
  CHECK (review_status = ANY (ARRAY['pending', 'accepted', 'rejected']));

COMMIT;
