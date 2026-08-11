-- 66_EVIDENCE_DECISION_GATE_HARDENING.sql
--
-- WHAT THIS CLOSES.
--
-- Evidence review is the screen that constitutes DDP's chain of custody. A
-- regulator or a buyer's compliance officer will one day ask: who looked at
-- this document, what did they check, when, and what did they conclude.
--
-- Migrations 64 and 65 answered "who" and "what did they conclude": the
-- reviewer is set from the session by a trigger and cannot be chosen by the
-- caller, and every transition appends an immutable row carrying the reason.
--
-- "Did they look at it" was answered only by a disabled button. A disabled
-- button is a presentation detail. Anything holding an admin session — the
-- REST endpoint, psql, a script, a future screen written by someone who did not
-- read this file — could record a decision on a document nobody had opened,
-- and the permanent record would look identical to one that was read.
--
-- This migration makes the read a fact the database holds, and makes a decision
-- without one impossible rather than merely discouraged.
--
-- WHAT IT DOES NOT CLAIM. The open is an INSERT by the same authenticated
-- administrator who then decides. The database enforces the PAIRING — no
-- decision without a recorded open by that reviewer — not that a human read the
-- words. That is the honest scope: it removes "I never saw it" as an available
-- account of events, and it does not pretend to measure attention.
--
-- Nothing here is destructive. It adds one table, one nullable column and one
-- trigger; 66_..._ROLLBACK.sql removes exactly those three.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The record that a named reviewer opened a document.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.farmer_document_opens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_document_id uuid NOT NULL
    REFERENCES public.farmer_documents(id) ON DELETE RESTRICT,
  -- Set from the session by the trigger below, never by the caller — the same
  -- rule migration 64 applies to `reviewed_by`, and for the same reason: an
  -- attributable record that the client can address to a colleague is not
  -- attributable.
  opened_by          uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  -- The fingerprint as it stood when the file was handed over, so an open can
  -- be tied to a specific version of the bytes. Nullable: a register entry with
  -- no digest is a real state this product reports rather than hides.
  sha256_at_open     text
);

COMMENT ON TABLE public.farmer_document_opens IS
  'Append-only: a named administrator was handed this document''s bytes at this '
  'time. Required by the trigger on farmer_documents before a decision may be '
  'recorded. Attests the pairing (no decision without an open by the same '
  'reviewer), not that a human read the contents.';

CREATE INDEX IF NOT EXISTS farmer_document_opens_doc_by_idx
  ON public.farmer_document_opens (farmer_document_id, opened_by, opened_at DESC);

-- The caller never chooses who opened a document.
CREATE OR REPLACE FUNCTION public.set_document_open_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.opened_by := auth.uid();
  IF NEW.opened_by IS NULL THEN
    RAISE EXCEPTION 'An open cannot be recorded without an authenticated session.'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.opened_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS farmer_document_opens_set_actor ON public.farmer_document_opens;
CREATE TRIGGER farmer_document_opens_set_actor
  BEFORE INSERT ON public.farmer_document_opens
  FOR EACH ROW EXECUTE FUNCTION public.set_document_open_actor();

-- Append-only, exactly as farmer_document_reviews is: a chain of custody that
-- can be edited afterwards is not one.
CREATE OR REPLACE FUNCTION public.refuse_document_open_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'farmer_document_opens is append-only.'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS farmer_document_opens_no_update_delete ON public.farmer_document_opens;
CREATE TRIGGER farmer_document_opens_no_update_delete
  BEFORE UPDATE OR DELETE ON public.farmer_document_opens
  FOR EACH ROW EXECUTE FUNCTION public.refuse_document_open_mutation();

DROP TRIGGER IF EXISTS farmer_document_opens_no_truncate ON public.farmer_document_opens;
CREATE TRIGGER farmer_document_opens_no_truncate
  BEFORE TRUNCATE ON public.farmer_document_opens
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_document_open_mutation();

ALTER TABLE public.farmer_document_opens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farmer_document_opens: admin all" ON public.farmer_document_opens;
CREATE POLICY "farmer_document_opens: admin all"
  ON public.farmer_document_opens
  FOR ALL
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

REVOKE ALL ON public.farmer_document_opens FROM anon;
GRANT SELECT, INSERT ON public.farmer_document_opens TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The fingerprint as it stood at the moment of the decision.
-- ─────────────────────────────────────────────────────────────────────────────
-- Nullable, and null is a legal value: "as it stood" includes "there was none",
-- which the review screen already states plainly rather than implying integrity
-- it cannot support.
ALTER TABLE public.farmer_document_reviews
  ADD COLUMN IF NOT EXISTS sha256_at_decision text;

COMMENT ON COLUMN public.farmer_document_reviews.sha256_at_decision IS
  'The document digest at the moment this decision was recorded. Proves which '
  'bytes were decided upon. Says nothing about whether the document is genuine.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The gate.
-- ─────────────────────────────────────────────────────────────────────────────
-- A reason of substance. Deliberately NOT a CHECK on the table: the rows already
-- in farmer_document_reviews satisfy only the weaker "not blank" test from
-- migration 65, and a stricter CHECK would either fail to add or need NOT VALID,
-- which is a constraint that lies about what it guarantees.
--
--   · more than 9 characters after trimming, so "ok", "fine" and "   " cannot
--     stand in for an account of what was checked
--   · not one character repeated — "aaaaaaaaaaaa" defeats a length test and
--     records nothing
CREATE OR REPLACE FUNCTION public.evidence_reason_is_substantive(note text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT note IS NOT NULL
     AND length(btrim(note)) > 9
     AND btrim(note) !~ '^(.)\1*$';
$$;

COMMENT ON FUNCTION public.evidence_reason_is_substantive(text) IS
  'The floor for a recorded reason. The client mirrors this predicate exactly; '
  'if the two drift, the database is the one that decides.';

CREATE OR REPLACE FUNCTION public.enforce_evidence_decision_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  deciding_reviewer uuid := auth.uid();
BEGIN
  -- ── INSERT: a document may only ARRIVE undecided. ─────────────────────────
  -- Every trigger on this table was UPDATE-only, which left the whole gate
  -- addressable by creating the row already decided instead of deciding on it.
  -- Measured on staging before this clause existed: a document could be
  -- INSERTed as 'accepted' with the reason "x", with reviewed_by chosen by the
  -- caller rather than taken from the session, and with ZERO rows in
  -- farmer_document_reviews — a decided document with no record of any
  -- decision, which is precisely the artefact this screen exists to make
  -- impossible.
  --
  -- Refused outright rather than gated, because the gate cannot be satisfied at
  -- INSERT time even in principle: an open references the document, so it
  -- cannot exist before the document does. A document enters the register
  -- undecided and is decided by an UPDATE, which is the path that is gated.
  IF TG_OP = 'INSERT' THEN
    IF NEW.review_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION
        'A document must be created undecided. Insert it as pending and record the decision, so the decision has a reviewer, a reason and an open behind it.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Only a change of review status is a decision. Every other update to a
  -- document row passes through untouched.
  IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status THEN
    RETURN NEW;
  END IF;

  -- Every decision carries a reason, including a return to the queue: taking a
  -- decision back is itself a decision someone must answer for.
  IF NOT public.evidence_reason_is_substantive(NEW.review_note) THEN
    RAISE EXCEPTION
      'A decision needs a reason of substance: more than 9 characters, and not one character repeated.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Returning a document to the queue withdraws a decision rather than
  -- recording an examination, so it does not require a fresh open. The other
  -- three all assert that this reviewer examined the document — 'accepted' and
  -- 'rejected' say so outright, and 'awaiting_clarification' records that it
  -- "was reviewed, but" — so all three require one.
  IF NEW.review_status <> 'pending' THEN
    IF deciding_reviewer IS NULL THEN
      RAISE EXCEPTION 'A decision cannot be recorded without an authenticated reviewer.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.farmer_document_opens o
       WHERE o.farmer_document_id = NEW.id
         AND o.opened_by = deciding_reviewer
    ) THEN
      RAISE EXCEPTION
        'This document has not been opened by you. Open and read it before recording a decision.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_evidence_decision_gate() IS
  'Refuses a decision that has no recorded open by the deciding reviewer, and '
  'any decision without a substantive reason. The screen disables its buttons '
  'for the same reasons; this is the enforcement.';

-- BEFORE, and ordered ahead of the reviewer-setting trigger by name so a
-- refusal happens before anything is derived from a decision that will not
-- stand. Trigger order within a timing class is alphabetical in PostgreSQL, and
-- "farmer_documents_enforce_..." sorts before "farmer_documents_set_reviewer".
DROP TRIGGER IF EXISTS farmer_documents_enforce_decision_gate ON public.farmer_documents;
CREATE TRIGGER farmer_documents_enforce_decision_gate
  BEFORE INSERT OR UPDATE ON public.farmer_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_decision_gate();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Carry the digest onto the decision record.
-- ─────────────────────────────────────────────────────────────────────────────
-- `fn_farmer_document_review_event` (AFTER UPDATE, migration 65) is the ONLY
-- writer of farmer_document_reviews. It is replaced here rather than
-- supplemented, so that stays true.
--
-- Its existing behaviour is preserved exactly and deliberately:
--   · fires only on a status transition
--   · refuses when auth.uid() is NULL, naming the transition in the message
--   · trims the note with the same character class before storing it
--   · RETURNS NULL, which is correct for an AFTER trigger
-- The only change is the digest column. Diff this against the definition
-- captured from production on 2026-08-11 before trusting that claim.
CREATE OR REPLACE FUNCTION public.fn_farmer_document_review_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN

    IF v_actor IS NULL THEN
      RAISE EXCEPTION
        'A document review transition must name an authenticated human; auth.uid() is NULL (% -> %)',
        OLD.review_status,
        NEW.review_status
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.farmer_document_reviews (
      farmer_document_id,
      previous_status,
      new_status,
      review_note,
      reviewed_by,
      sha256_at_decision
    )
    VALUES (
      NEW.id,
      OLD.review_status,
      NEW.review_status,
      btrim(NEW.review_note, E' \t\r\n\f\v'),
      v_actor,
      NEW.sha256_hex
    );

  END IF;

  RETURN NULL;
END;
$function$;

COMMIT;
