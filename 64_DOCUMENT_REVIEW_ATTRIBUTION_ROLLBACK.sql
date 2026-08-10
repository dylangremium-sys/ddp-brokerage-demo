-- =============================================================================
-- 64_DOCUMENT_REVIEW_ATTRIBUTION_ROLLBACK.sql
--
-- Restores farmer_documents to its pre-64 state: no reviewer column, no trigger,
-- no constraint requiring a decision to name a human.
--
-- READ THIS BEFORE RUNNING IT. It re-opens a real gap: a certificate can again
-- be accepted or rejected with no record of who did it, which is the decision a
-- buyer ultimately relies on. It exists because the repo's rollback-symmetry
-- check requires every migration to have a proven reversal, and the check is
-- right — not because reverting is neutral.
--
-- The column drop is destructive: reviewer attributions recorded since 64
-- applied are discarded and cannot be recovered by re-applying it.
-- =============================================================================

BEGIN;

-- 1. The constraint first — the column cannot be dropped while it is referenced.
ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS review_decision_requires_reviewer;

-- 2. Trigger and its function.
DROP TRIGGER IF EXISTS farmer_documents_set_reviewer ON public.farmer_documents;
DROP FUNCTION IF EXISTS public.fn_farmer_documents_set_reviewer();

-- 3. The reviewer column. Destructive — see the header.
ALTER TABLE public.farmer_documents DROP COLUMN IF EXISTS reviewed_by;

COMMIT;
