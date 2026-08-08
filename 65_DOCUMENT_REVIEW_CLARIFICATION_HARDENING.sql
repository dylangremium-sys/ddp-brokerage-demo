-- =============================================================================
-- 65_DOCUMENT_REVIEW_CLARIFICATION_HARDENING.sql
--
-- Lets an administrator say "I reviewed this, and I can neither accept nor
-- reject it until something is clarified" — and makes that statement durable,
-- attributed and reasoned.
--
-- WHAT IS WRONG TODAY — measured against production 217cfe8
--
--   farmer_documents_review_status_check   admits exactly pending|accepted|rejected
--   review note                            NO COLUMN ANYWHERE
--   document-review history                NO TABLE, NO WRITER
--   fn_farmer_documents_set_reviewer       NULLs reviewed_by on return-to-pending
--
-- The consequence, and it is not a UI gap: the only non-accept, non-reject state
-- is 'pending', and migration 64's trigger deliberately strips the reviewer from
-- a pending row. So an ATTRIBUTED NON-DECISION IS UNREPRESENTABLE. An
-- administrator who has genuinely examined a certificate and found it wanting
-- has exactly two options that record anything: accept it, or reject it. Both
-- are false when the honest answer is "this needs clarification".
--
-- That is the ordinary compliance outcome for the case that prompted this: a
-- laboratory report whose contents name one sample while the farmer attached it
-- to a differently-named batch. Accepting it would assert a mapping the evidence
-- does not support. Rejecting it would condemn a document that may be perfectly
-- valid and merely misfiled.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- It does not touch status_history, whose append-only semantics migration 63
-- established for BATCH statuses. That trail and this one are separate entities
-- and are deliberately kept so. An earlier report combined them and concluded
-- document reviews already had an append-only attributed trail; they did not.
-- It also manufactures no batch association — 'awaiting_clarification' exists
-- precisely because the association is unknown.
--
-- WHY THE EVENT TABLE IS THE AUTHORITY
-- farmer_documents.review_status and .review_note are CURRENT STATE, overwritten
-- by the next decision. public.farmer_document_reviews is the history, one row
-- per transition, append-only for every role including ddp_admin, service_role
-- and the table owner. A decision you can silently rewrite is not an audit
-- trail, and the current-state columns exist only so the queue can render
-- without a join.
--
-- WHY EVERY TRANSITION NEEDS A HUMAN, RETURN-TO-QUEUE INCLUDED
-- The event row's reviewed_by is NOT NULL and is taken from auth.uid(). A
-- service-role or cron process has no auth.uid(), so its event INSERT fails and
-- the whole transaction is refused. Migration 64 made that true of accept and
-- reject; it is now true of returning a document to the queue as well, which
-- was previously an unattributed way to erase a decision.
--
-- EXISTING ROWS. review_note is new, so any row already in a decided state would
-- violate the new note constraint. Section 3 backfills those rows with a note
-- that states plainly that no reason was captured, rather than inventing one.
-- It runs BEFORE the trigger is replaced, so the old trigger — which ignores
-- review_note entirely — is what sees it.
-- =============================================================================

BEGIN;

-- ── 1. The vocabulary gains one value ───────────────────────────────────────
-- Named constraint, dropped and re-added rather than altered: PostgreSQL has no
-- ALTER CONSTRAINT for a CHECK. The name is the one PostgreSQL assigned to the
-- inline CHECK in the original CREATE TABLE, and is identical in production and
-- in the harness substrate — verified before writing this, because DROP
-- CONSTRAINT by a name that differs between the two would pass here and fail
-- there.
ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS farmer_documents_review_status_check;

ALTER TABLE public.farmer_documents
  ADD CONSTRAINT farmer_documents_review_status_check
  CHECK (review_status = ANY (ARRAY['pending', 'awaiting_clarification', 'accepted', 'rejected']));

-- ── 2. The reason, as current state ─────────────────────────────────────────
ALTER TABLE public.farmer_documents
  ADD COLUMN IF NOT EXISTS review_note text;

COMMENT ON COLUMN public.farmer_documents.review_note IS
  'The reason given for the CURRENT review_status. Overwritten by the next decision — public.farmer_document_reviews is the authoritative history. Required nonblank for every status other than pending (migration 65).';

-- ── 3. Existing decided rows get an honest placeholder ──────────────────────
-- Deliberately NOT a fabricated reason. Runs before section 6 replaces the
-- trigger, so the trigger in force here is migration 64's, which does not look
-- at review_note and will not raise.
UPDATE public.farmer_documents
SET review_note = 'Decision recorded before migration 65. The schema in force at the time captured no reason for it.'
WHERE review_status <> 'pending'
  AND coalesce(review_note, '') !~ '[^[:space:]]';

-- ── 4. A decision must carry a reason ───────────────────────────────────────
-- Sibling of migration 64's review_decision_requires_reviewer, which is left
-- exactly as it is: it already reads "pending OR attributed", so
-- 'awaiting_clarification' falls on its attributed side with no edit.
-- "Nonblank" is tested with a whitespace CHARACTER CLASS, not btrim(). Default
-- btrim() strips SPACES ONLY, so a note of one tab or one newline survives it
-- and reads as a reason. The harness caught exactly that: a document reached
-- awaiting_clarification carrying E'\t\n' as its justification. `~ '[^[:space:]]'`
-- asks the only question that matters — is there a single non-whitespace
-- character in here — and is used identically everywhere a note is validated.
ALTER TABLE public.farmer_documents
  ADD CONSTRAINT review_decision_requires_note
  CHECK (
    review_status = 'pending'
    OR coalesce(review_note, '') ~ '[^[:space:]]'
  );

-- ── 5. The history ──────────────────────────────────────────────────────────
-- reviewed_by is ON DELETE RESTRICT, NOT the SET NULL that migration 64 chose
-- for the current-state column. The two differ on purpose. On the document row,
-- losing the reviewer degrades a record that still exists. Here, the actor IS
-- the record: an audit event that has forgotten who acted is worse than absent,
-- because it still looks like evidence. The cost is stated rather than
-- discovered — a staff account that has ever reviewed a document cannot be hard
-- deleted while its events stand.
--
-- farmer_document_id is RESTRICT for the same reason: CASCADE would be a delete
-- path through an append-only table.
CREATE TABLE IF NOT EXISTS public.farmer_document_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_document_id uuid NOT NULL REFERENCES public.farmer_documents(id) ON DELETE RESTRICT,
  previous_status    text NOT NULL,
  new_status         text NOT NULL,
  review_note        text NOT NULL,
  reviewed_by        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT farmer_document_reviews_previous_status_check
    CHECK (previous_status = ANY (ARRAY['pending', 'awaiting_clarification', 'accepted', 'rejected'])),
  CONSTRAINT farmer_document_reviews_new_status_check
    CHECK (new_status = ANY (ARRAY['pending', 'awaiting_clarification', 'accepted', 'rejected'])),
  CONSTRAINT farmer_document_reviews_note_not_blank
    CHECK (review_note ~ '[^[:space:]]'),
  -- An event that changed nothing is noise in an audit trail.
  CONSTRAINT farmer_document_reviews_status_actually_changed
    CHECK (previous_status <> new_status)
);

COMMENT ON TABLE public.farmer_document_reviews IS
  'Append-only history of document review decisions, one row per review_status transition. UPDATE, DELETE and TRUNCATE are refused by trigger for EVERY role, including ddp_admin, service_role and the table owner. Rows are written only by fn_farmer_document_review_event; there is no INSERT policy and no role holds INSERT. Added by migration 65.';

CREATE INDEX IF NOT EXISTS farmer_document_reviews_document_idx
  ON public.farmer_document_reviews (farmer_document_id, reviewed_at DESC);

-- ── 6. The reviewer rule, extended ──────────────────────────────────────────
-- Replaces migration 64's function. Three changes, each stated:
--
--   a) Every transition now requires a nonblank note, return-to-pending
--      included. A decision erased without a reason is itself a decision.
--   b) review_note is NEVER cleared. On return-to-pending it holds the reason
--      for the return, which is what the AFTER trigger records. Clearing it
--      would leave the event writer with nothing to record.
--   c) A note cannot be edited without a transition, or current state would
--      silently diverge from the history that explains it.
--
-- Unchanged from 64, and load-bearing: the trigger fires only when
-- review_status actually changes, and the reviewer is OVERWRITTEN from
-- auth.uid() rather than defaulted, so a caller cannot attribute a decision to
-- a colleague. 'awaiting_clarification' takes the attributed branch — it is a
-- decision, not an absence of one.
CREATE OR REPLACE FUNCTION public.fn_farmer_documents_set_reviewer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    -- Whitespace class, not btrim() — see the note on review_decision_requires_note.
    IF coalesce(NEW.review_note, '') !~ '[^[:space:]]' THEN
      RAISE EXCEPTION
        'a document review transition requires a nonblank review note (% -> %)',
        OLD.review_status, NEW.review_status
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.review_status = 'pending' THEN
      -- Returning a document to the queue is not a decision about the document,
      -- so it carries no reviewer forward. The event written by the AFTER
      -- trigger is what records who returned it and why; that record is made
      -- before this clearing is visible to anyone.
      NEW.reviewed_by := NULL;
      NEW.reviewed_at := NULL;
    ELSE
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    END IF;
  ELSIF NEW.review_note IS DISTINCT FROM OLD.review_note THEN
    RAISE EXCEPTION
      'review_note cannot be changed without a review transition; the note belongs to the decision that set it'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- acl-no-grant: fn_farmer_documents_set_reviewer
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_documents_set_reviewer() FROM service_role;

-- ── 7. The event writer ─────────────────────────────────────────────────────
-- AFTER UPDATE, so it records a transition that actually committed to the row.
--
-- The actor is auth.uid() read HERE, not NEW.reviewed_by — on a return to
-- pending the BEFORE trigger has already NULLed that column, and an event with
-- no actor is the thing this table exists to prevent. Because the column is NOT
-- NULL, a session with no auth.uid() cannot write an event, and since the INSERT
-- is part of the updating transaction, the UPDATE itself is refused. That is
-- how return-to-queue acquires the human requirement accept and reject already
-- had.
CREATE OR REPLACE FUNCTION public.fn_farmer_document_review_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION
        'a document review transition must name an authenticated human; auth.uid() is NULL (% -> %)',
        OLD.review_status, NEW.review_status
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.farmer_document_reviews
      (farmer_document_id, previous_status, new_status, review_note, reviewed_by)
    VALUES
      (NEW.id, OLD.review_status, NEW.review_status,
       btrim(NEW.review_note, E' \t\r\n\f\v'), v_actor);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS farmer_documents_write_review_event ON public.farmer_documents;
CREATE TRIGGER farmer_documents_write_review_event
  AFTER UPDATE ON public.farmer_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_farmer_document_review_event();

-- acl-no-grant: fn_farmer_document_review_event
REVOKE EXECUTE ON FUNCTION public.fn_farmer_document_review_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_document_review_event() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_document_review_event() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_farmer_document_review_event() FROM service_role;

-- ── 8. The history is append-only, for every role ───────────────────────────
-- Same shape as prevent_status_history_mutation (migration 63). RLS cannot bind
-- service_role or the table owner; a trigger can.
CREATE OR REPLACE FUNCTION public.prevent_farmer_document_review_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'farmer_document_reviews is append-only; attempted % is not allowed.', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS farmer_document_reviews_no_update_delete ON public.farmer_document_reviews;
CREATE TRIGGER farmer_document_reviews_no_update_delete
  BEFORE DELETE OR UPDATE ON public.farmer_document_reviews
  FOR EACH ROW EXECUTE FUNCTION public.prevent_farmer_document_review_mutation();

-- TRUNCATE needs its own statement-level trigger: a row-level trigger never
-- fires for it, so a table guarded only by the first is still emptiable in one
-- statement by any role that bypasses RLS.
DROP TRIGGER IF EXISTS farmer_document_reviews_no_truncate ON public.farmer_document_reviews;
CREATE TRIGGER farmer_document_reviews_no_truncate
  BEFORE TRUNCATE ON public.farmer_document_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_farmer_document_review_mutation();

-- acl-no-grant: prevent_farmer_document_review_mutation
REVOKE EXECUTE ON FUNCTION public.prevent_farmer_document_review_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_farmer_document_review_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_farmer_document_review_mutation() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_farmer_document_review_mutation() FROM service_role;

-- ── 9. Who may read the history ─────────────────────────────────────────────
-- SELECT only, and only for an administrator. No INSERT policy exists and no
-- role is granted INSERT: the sole writer is the SECURITY DEFINER trigger in
-- section 7, which runs as the table owner and is not subject to either.
--
-- relforcerowsecurity is left OFF deliberately — forcing RLS on the owner would
-- block that definer INSERT and there would be no way to write an event at all.
ALTER TABLE public.farmer_document_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farmer_document_reviews: admin read" ON public.farmer_document_reviews;
CREATE POLICY "farmer_document_reviews: admin read"
  ON public.farmer_document_reviews
  FOR SELECT
  USING (public.is_ddp_admin());

REVOKE ALL ON public.farmer_document_reviews FROM PUBLIC;
REVOKE ALL ON public.farmer_document_reviews FROM anon;
REVOKE ALL ON public.farmer_document_reviews FROM authenticated;
REVOKE ALL ON public.farmer_document_reviews FROM service_role;

-- Read is all any application role gets. RLS then narrows that to an admin.
GRANT SELECT ON public.farmer_document_reviews TO authenticated;

COMMENT ON COLUMN public.farmer_document_reviews.reviewed_by IS
  'The administrator who made this transition, taken from auth.uid() by fn_farmer_document_review_event. NOT NULL: an event that cannot name its actor is refused, which is what makes every transition — return-to-queue included — require a human.';

COMMIT;
