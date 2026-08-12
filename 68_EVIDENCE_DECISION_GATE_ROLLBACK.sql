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

-- 65's function is NOT touched by 68 and so is not restored here. An earlier
-- draft replaced it and restored a body captured from production, which the
-- disposable-PostgreSQL harness correctly rejected: production's body is not
-- byte-identical to what 65's file creates, so the rollback would have rewritten
-- someone else's function into a different version of itself.
DROP TRIGGER IF EXISTS farmer_document_reviews_set_digest ON public.farmer_document_reviews;
DROP FUNCTION IF EXISTS public.set_review_digest();

ALTER TABLE public.farmer_document_reviews DROP COLUMN IF EXISTS sha256_at_decision;

DROP TRIGGER IF EXISTS farmer_document_opens_no_truncate ON public.farmer_document_opens;
DROP TRIGGER IF EXISTS farmer_document_opens_no_update_delete ON public.farmer_document_opens;
DROP TRIGGER IF EXISTS farmer_document_opens_set_actor ON public.farmer_document_opens;
DROP TABLE IF EXISTS public.farmer_document_opens;
DROP FUNCTION IF EXISTS public.set_document_open_actor();
DROP FUNCTION IF EXISTS public.refuse_document_open_mutation();

COMMIT;
