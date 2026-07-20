-- =============================================================================
-- Migration 24 — ROLLBACK (Evidence Request & Resolution Workflow)
--
-- Reverses ONLY migration 24. It creates nothing, and it touches no object
-- belonging to any other migration.
--
-- ORDERING REQUIREMENT: roll back the storage companion
-- (24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql) BEFORE this file if it was
-- applied. That companion's storage policy calls
-- public.can_operationally_access_farm(), which this file drops. Dropping the
-- helper first would leave a storage policy referencing a missing function.
--
-- DATA SAFETY: migration 24 tables hold operational evidence records. Contract
-- §6.6 prohibits permanent deletion of requests, submitted responses, submitted
-- attachments and history. This rollback therefore REFUSES to run while any
-- evidence request exists, unless the operator explicitly opts in by setting:
--
--     SET LOCAL evidence.rollback_destructive = 'true';
--
-- That guard makes accidental destruction of audit data impossible while still
-- leaving a real rollback path for a failed deployment with no live data.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Refuse to destroy live evidence data unless explicitly authorized.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  request_count integer := 0;
  history_count integer := 0;
  opt_in        text;
BEGIN
  IF to_regclass('public.evidence_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.evidence_requests' INTO request_count;
  END IF;
  IF to_regclass('public.evidence_request_history') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.evidence_request_history' INTO history_count;
  END IF;

  IF request_count > 0 OR history_count > 0 THEN
    BEGIN
      opt_in := current_setting('evidence.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN
      opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 24 refused: % evidence request(s) and % history event(s) exist. '
        'Contract §6.6 prohibits deleting requests, submitted responses, submitted '
        'attachments and history. To proceed deliberately, run '
        'SET LOCAL evidence.rollback_destructive = ''true''; in the same transaction.',
        request_count, history_count;
    END IF;

    RAISE NOTICE
      'rollback 24: destructive opt-in acknowledged — removing % request(s) and % history event(s).',
      request_count, history_count;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Policies (dropped before the helper functions they reference).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "evidence_requests: admin select all"                  ON public.evidence_requests;
DROP POLICY IF EXISTS "evidence_requests: operational farmer select own farm" ON public.evidence_requests;
DROP POLICY IF EXISTS "evidence_responses: admin select all"                  ON public.evidence_request_responses;
DROP POLICY IF EXISTS "evidence_responses: operational farmer select own farm" ON public.evidence_request_responses;
DROP POLICY IF EXISTS "evidence_attachments: admin select all"                ON public.evidence_request_attachments;
DROP POLICY IF EXISTS "evidence_attachments: operational farmer select own farm" ON public.evidence_request_attachments;
DROP POLICY IF EXISTS "evidence_history: admin select all"                    ON public.evidence_request_history;
DROP POLICY IF EXISTS "evidence_history: operational farmer select own farm"  ON public.evidence_request_history;

-- -----------------------------------------------------------------------------
-- 2. Triggers.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_evidence_request_validate_scope    ON public.evidence_requests;
DROP TRIGGER IF EXISTS trg_evidence_request_protect_immutable ON public.evidence_requests;
DROP TRIGGER IF EXISTS trg_evidence_request_no_delete         ON public.evidence_requests;
DROP TRIGGER IF EXISTS trg_evidence_response_protect_submitted ON public.evidence_request_responses;
DROP TRIGGER IF EXISTS trg_evidence_attachment_validate       ON public.evidence_request_attachments;
DROP TRIGGER IF EXISTS trg_evidence_history_append_only       ON public.evidence_request_history;

-- -----------------------------------------------------------------------------
-- 3. RPCs and helpers.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_evidence_request(text,uuid,text,text,text,text,date);
DROP FUNCTION IF EXISTS public.get_or_create_evidence_response_draft(uuid,integer);
DROP FUNCTION IF EXISTS public.save_evidence_response_draft(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.submit_evidence_response(uuid,uuid,integer);
DROP FUNCTION IF EXISTS public.request_evidence_clarification(uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS public.resolve_evidence_request(uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS public.reject_evidence_response(uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS public.cancel_evidence_request(uuid,text,integer);
DROP FUNCTION IF EXISTS public.reserve_evidence_attachment(uuid,uuid,text,text,bigint);
DROP FUNCTION IF EXISTS public.finalize_evidence_attachment(uuid,uuid,uuid,text,bigint,text);
DROP FUNCTION IF EXISTS public.remove_draft_evidence_attachment(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.link_existing_evidence_document(uuid,uuid,text,uuid,uuid);

DROP FUNCTION IF EXISTS public.evidence_apply_transition(uuid,integer,text,text,text,text,uuid,uuid);
DROP FUNCTION IF EXISTS public.evidence_lock_visible_request(uuid,boolean);
DROP FUNCTION IF EXISTS public.evidence_request_as_json(uuid);
DROP FUNCTION IF EXISTS public.evidence_actor_role();

DROP FUNCTION IF EXISTS public.fn_evidence_request_validate_scope();
DROP FUNCTION IF EXISTS public.fn_evidence_request_protect_immutable();
DROP FUNCTION IF EXISTS public.fn_evidence_request_no_delete();
DROP FUNCTION IF EXISTS public.fn_evidence_response_protect_submitted();
DROP FUNCTION IF EXISTS public.fn_evidence_attachment_validate();
DROP FUNCTION IF EXISTS public.fn_evidence_history_append_only();

-- -----------------------------------------------------------------------------
-- 4. Tables (child-first; every FK uses ON DELETE RESTRICT).
--    The append-only and no-delete triggers are already dropped above, so DROP
--    TABLE is not blocked by them.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.evidence_request_history;
DROP TABLE IF EXISTS public.evidence_request_attachments;
DROP TABLE IF EXISTS public.evidence_request_responses;
DROP TABLE IF EXISTS public.evidence_requests;

-- -----------------------------------------------------------------------------
-- 5. Canonical value + authorization helpers introduced by migration 24.
--    NOTE: public.has_operational_farmer_access() belongs to migration 22 and is
--    deliberately NOT dropped here.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.can_operationally_access_farm(uuid);
DROP FUNCTION IF EXISTS public.evidence_document_mime(text);
DROP FUNCTION IF EXISTS public.evidence_max_size_bytes(text,text);
DROP FUNCTION IF EXISTS public.evidence_mime_allowed(text,text);
DROP FUNCTION IF EXISTS public.evidence_category_allows_target(text,text);
DROP FUNCTION IF EXISTS public.evidence_request_categories();
DROP FUNCTION IF EXISTS public.evidence_request_priorities();
DROP FUNCTION IF EXISTS public.evidence_request_terminal_statuses();
DROP FUNCTION IF EXISTS public.evidence_request_statuses();

COMMIT;
