-- 68_EVIDENCE_DECISION_GATE_ROLLBACK.sql
--
-- Undoes 66 exactly: the gate trigger, the two functions it introduced, the
-- opens table with its own triggers, and the digest column.
--
-- `fn_farmer_document_review_event` is RESTORED to its migration-65 body rather
-- than dropped — it is the only writer of farmer_document_reviews and dropping
-- it would silently stop the append-only log. The body below is the definition
-- captured from production on 2026-08-11, byte for byte apart from the digest
-- column this migration added.
--
-- Dropping farmer_document_opens DESTROYS the record of who opened what. That
-- is the intended meaning of rolling this back — the claim goes away with the
-- evidence for it — but it is not recoverable, so read that sentence twice.

BEGIN;

DROP TRIGGER IF EXISTS farmer_documents_enforce_decision_gate ON public.farmer_documents;
DROP FUNCTION IF EXISTS public.enforce_evidence_decision_gate();
DROP FUNCTION IF EXISTS public.evidence_reason_is_substantive(text);

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
      reviewed_by
    )
    VALUES (
      NEW.id,
      OLD.review_status,
      NEW.review_status,
      btrim(NEW.review_note, E' \t\r\n\f\v'),
      v_actor
    );

  END IF;

  RETURN NULL;
END;
$function$;

ALTER TABLE public.farmer_document_reviews DROP COLUMN IF EXISTS sha256_at_decision;

DROP TRIGGER IF EXISTS farmer_document_opens_no_truncate ON public.farmer_document_opens;
DROP TRIGGER IF EXISTS farmer_document_opens_no_update_delete ON public.farmer_document_opens;
DROP TRIGGER IF EXISTS farmer_document_opens_set_actor ON public.farmer_document_opens;
DROP TABLE IF EXISTS public.farmer_document_opens;
DROP FUNCTION IF EXISTS public.set_document_open_actor();
DROP FUNCTION IF EXISTS public.refuse_document_open_mutation();

COMMIT;
