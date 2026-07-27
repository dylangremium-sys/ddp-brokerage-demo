-- =============================================================================
-- Migration 31 — Source-bound COA review (Gate P0, issue #77)
--
-- Persists one end-to-end COA review inside the existing Compliance Watchtower:
--
--   supplied COA PDF -> server-side extraction with page provenance
--                    -> deterministic findings
--                    -> freshly retrieved official source version
--                    -> source-bound preliminary suggestion
--                    -> authorized administrator decision
--                    -> durable audit record
--
-- Scope of THIS file (public schema only):
--   1. coa_documents         — one row per processed PDF, keyed by byte hash
--   2. coa_extracted_fields  — every field WITH its PDF page and status
--   3. coa_findings          — deterministic observations, idempotent per doc
--   4. coa_source_versions   — one row per official-source RETRIEVAL ATTEMPT
--   5. coa_suggestions       — preliminary suggestions, bound or quarantined
--   6. coa_decisions         — the administrator's recorded decision
--   7. compliance_audit_log  — two additive columns + new COA action values
--   8. RLS (admin-only) + the fail-closed suggestion-binding guard
--
-- THE CENTRAL CONTROL (step 8): a trigger refuses to store a suggestion in the
-- 'bound' state unless it references a source version whose retrieval actually
-- SUCCEEDED and carries a content fingerprint. "No verified source retrieval =
-- no regulatory suggestion" is therefore enforced by the database, not merely
-- by application code — an uncited or unverified suggestion cannot be written
-- as bound even by a caller that skips the application layer.
--
-- Explicitly NOT in this migration: legal thresholds, pass/fail evaluation,
-- rule activation, AI. Nothing here encodes a compliance conclusion; the schema
-- stores observations, a retrieved source, and a human decision.
--
-- Backward compatibility: every change is additive. New audit-log columns are
-- NULLABLE so existing writers keep working unchanged, and the action CHECK is
-- widened (never narrowed), so no existing row can be invalidated.
--
-- Verify:   31_COA_SOURCE_BOUND_REVIEW_VERIFY.sql
-- Rollback: 31_COA_SOURCE_BOUND_REVIEW_ROLLBACK.sql
--
-- Preconditions:
--   * public.is_ddp_admin()        (migration 3 / AUTH_RLS_SCHEMA)
--   * public.compliance_audit_log  (migration 9)
--   * pgcrypto                     (gen_random_uuid)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions.
-- -----------------------------------------------------------------------------
DO $precondition$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_ddp_admin'
  ) THEN missing := missing || 'public.is_ddp_admin()'; END IF;

  IF to_regclass('public.compliance_audit_log') IS NULL THEN
    missing := missing || 'public.compliance_audit_log'; END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 31 precondition failed: missing required object(s): %. '
      'Apply migrations 3 and 9 before migration 31.',
      array_to_string(missing, ', ');
  END IF;
END
$precondition$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. coa_documents — one row per set of PDF bytes.
--
-- document_fingerprint is UNIQUE: re-uploading identical bytes cannot create a
-- second record, which is what makes an extraction retry idempotent. The
-- denormalised report_number is stored so document reuse (same report number,
-- different bytes) can be detected with an index rather than a scan of fields.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_fingerprint TEXT NOT NULL UNIQUE
    CHECK (document_fingerprint ~ '^[0-9a-f]{64}$'),
  source_filename TEXT NOT NULL DEFAULT '',
  byte_length BIGINT NOT NULL CHECK (byte_length > 0),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  document_format TEXT NOT NULL DEFAULT 'tnr-3page-v1',
  parser_version TEXT NOT NULL,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN (
    'ok', 'empty', 'too_large', 'not_a_pdf', 'no_text_layer', 'parse_failed', 'unsupported_format'
  )),
  unsupported_reason TEXT,
  -- Denormalised identifiers, for duplicate detection and display.
  report_number TEXT,
  sample_name TEXT,
  batch_number TEXT,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 2. coa_extracted_fields — a value is meaningless without its provenance.
--
-- page_number is stored per field so the UI can cite the PDF page for EVERY
-- displayed value. It is nullable only because a field that was never found
-- has no page; a field with status 'extracted' must have one (CHECK below).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_extracted_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coa_document_id UUID NOT NULL REFERENCES public.coa_documents(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  raw_value TEXT,
  normalized_value TEXT,
  page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('extracted', 'missing', 'unreadable', 'ambiguous')),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (coa_document_id, field_key),
  -- An extracted value must be able to say where it came from.
  CONSTRAINT coa_extracted_fields_page_required_when_extracted
    CHECK (extraction_status <> 'extracted' OR page_number IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- 3. coa_findings — deterministic, idempotent per document.
--
-- UNIQUE (coa_document_id, finding_fingerprint) lets a re-run upsert without
-- duplicating: the same document always yields the same fingerprints.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coa_document_id UUID NOT NULL REFERENCES public.coa_documents(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN (
    'unsupported_document',
    'missing_identifier',
    'malformed_date',
    'implausible_date_order',
    'missing_panel',
    'reported_failure',
    'malformed_value',
    'duplicate_document',
    'duplicate_report_number'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  field_key TEXT,
  panel_key TEXT,
  page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
  finding_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (coa_document_id, finding_fingerprint)
);

-- -----------------------------------------------------------------------------
-- 4. coa_source_versions — one row per RETRIEVAL ATTEMPT, successful or not.
--
-- Failures are recorded, not discarded: "the source could not be verified" is
-- exactly the state that must block a regulatory suggestion, so it has to be
-- persistable and displayable.
--
-- content_fingerprint identifies the exact bytes the authority served, which is
-- what a suggestion binds to — binding to a URL alone would let the page change
-- underneath a stored suggestion.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_source_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL,
  authority TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  jurisdiction_code TEXT NOT NULL DEFAULT '',
  requested_url TEXT NOT NULL,
  final_url TEXT,
  retrieval_status TEXT NOT NULL CHECK (retrieval_status IN (
    'retrieved',
    'rejected_invalid_url',
    'rejected_not_https',
    'rejected_not_allowlisted',
    'rejected_private_network',
    'rejected_disallowed_port',
    'rejected_redirect',
    'too_many_redirects',
    'rejected_content_type',
    'too_large',
    'timeout',
    'http_error',
    'fetch_failed'
  )),
  http_status INTEGER,
  content_type TEXT,
  byte_length BIGINT NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  content_fingerprint TEXT
    CHECK (content_fingerprint IS NULL OR content_fingerprint ~ '^[0-9a-f]{64}$'),
  redirect_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  relevant_section TEXT NOT NULL DEFAULT '',
  section_matched BOOLEAN NOT NULL DEFAULT FALSE,
  matched_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_reason TEXT,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retrieved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A successful retrieval must carry the version identity it claims to have.
  CONSTRAINT coa_source_versions_fingerprint_required_when_retrieved
    CHECK (retrieval_status <> 'retrieved' OR content_fingerprint IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- 5. coa_suggestions — preliminary only, and never displayable unless bound.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coa_document_id UUID NOT NULL REFERENCES public.coa_documents(id) ON DELETE CASCADE,
  source_version_id UUID REFERENCES public.coa_source_versions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('bound', 'quarantined', 'rejected')),
  suggestion_text TEXT NOT NULL,
  -- Why it was quarantined/rejected. Required unless the suggestion is bound.
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Structural half of the binding rule; the trigger below enforces the rest.
  CONSTRAINT coa_suggestions_bound_requires_source
    CHECK (state <> 'bound' OR source_version_id IS NOT NULL),
  CONSTRAINT coa_suggestions_unbound_requires_reason
    CHECK (state = 'bound' OR reason IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- 6. coa_decisions — only a human administrator decides.
--
-- decided_by is NOT NULL: a decision always has a named actor. The RLS policy
-- additionally pins it to auth.uid(), so an administrator cannot record a
-- decision in another user's name.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coa_document_id UUID NOT NULL REFERENCES public.coa_documents(id) ON DELETE CASCADE,
  source_version_id UUID REFERENCES public.coa_source_versions(id) ON DELETE SET NULL,
  suggestion_id UUID REFERENCES public.coa_suggestions(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN (
    'accepted_for_further_review',
    'rejected',
    'escalated_to_legal',
    'on_hold',
    'information_requested'
  )),
  previous_state TEXT NOT NULL DEFAULT 'pending_review',
  resulting_state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- The extraction identity the decision was made against.
  evidence_version TEXT NOT NULL,
  decided_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 7. compliance_audit_log — additive columns + widened action vocabulary.
--
-- The gate requires each audit event to record actor, action, evidence version,
-- source version, previous state, resulting state, note and timestamp. actor /
-- action / before_state / after_state / reason / created_at already exist from
-- migration 9; evidence and source version are added here.
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_audit_log
  ADD COLUMN IF NOT EXISTS evidence_version  TEXT,
  ADD COLUMN IF NOT EXISTS source_version_id UUID;

DO $audit_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'compliance_audit_log_source_version_fkey'
  ) THEN
    ALTER TABLE public.compliance_audit_log
      ADD CONSTRAINT compliance_audit_log_source_version_fkey
      FOREIGN KEY (source_version_id)
      REFERENCES public.coa_source_versions(id)
      ON DELETE SET NULL;
  END IF;
END
$audit_fk$;

-- Widen the action vocabulary. The constraint is DROPped and re-added with the
-- original values PLUS the COA actions, so no existing row is invalidated.
DO $audit_actions$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.compliance_audit_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%legal_update_created%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.compliance_audit_log DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE public.compliance_audit_log
    ADD CONSTRAINT compliance_audit_log_action_check CHECK (action IN (
      -- migration 9 vocabulary, preserved verbatim
      'legal_update_created',
      'legal_update_reviewed',
      'rule_suggested',
      'rule_approved',
      'rule_paused',
      'rule_retired',
      'alert_created',
      'alert_resolved',
      'readiness_status_changed',
      'document_status_changed',
      'sent_to_legal_review',
      'reviewer_note_added',
      'rule_rejected',
      'legal_update_archived',
      'alert_dismissed',
      -- migration 31 additions
      'coa_document_extracted',
      'coa_extraction_failed',
      'coa_findings_recorded',
      'coa_source_retrieved',
      'coa_source_retrieval_failed',
      'coa_suggestion_bound',
      'coa_suggestion_quarantined',
      'coa_suggestion_rejected',
      'coa_decision_recorded'
    ));
END
$audit_actions$;

-- -----------------------------------------------------------------------------
-- 8. The fail-closed binding guard.
--
-- The CHECK constraint on coa_suggestions can only see the row itself, so it
-- cannot verify that the referenced source version actually succeeded. This
-- trigger closes that gap: a 'bound' suggestion must point at a source version
-- whose retrieval_status is 'retrieved' AND which carries a content
-- fingerprint. Anything else is refused at write time.
--
-- This is the database-level expression of the gate's rule:
--   "No verified source retrieval = no regulatory suggestion."
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_coa_suggestion_source_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_fingerprint text;
BEGIN
  IF NEW.state <> 'bound' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_version_id IS NULL THEN
    RAISE EXCEPTION
      'coa_suggestions: a bound suggestion must cite a source version (uncited suggestions are not permitted)';
  END IF;

  SELECT retrieval_status, content_fingerprint
    INTO v_status, v_fingerprint
  FROM public.coa_source_versions
  WHERE id = NEW.source_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'coa_suggestions: cited source version % does not exist', NEW.source_version_id;
  END IF;

  IF v_status <> 'retrieved' THEN
    RAISE EXCEPTION
      'coa_suggestions: cited source version % was not successfully retrieved (status %); '
      'no regulatory suggestion may rest on an unverified source',
      NEW.source_version_id, v_status;
  END IF;

  IF v_fingerprint IS NULL THEN
    RAISE EXCEPTION
      'coa_suggestions: cited source version % has no content fingerprint, so the retrieved version cannot be identified',
      NEW.source_version_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS coa_suggestions_enforce_binding ON public.coa_suggestions;
CREATE TRIGGER coa_suggestions_enforce_binding
  BEFORE INSERT OR UPDATE ON public.coa_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_coa_suggestion_source_binding();

-- A decision is a permanent record of what a person decided at a point in time.
CREATE OR REPLACE FUNCTION public.prevent_coa_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'coa_decisions is append-only; attempted % is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS coa_decisions_no_update_delete ON public.coa_decisions;
CREATE TRIGGER coa_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON public.coa_decisions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_coa_decision_mutation();

-- Trigger-only functions: callable directly by nobody. Both are SECURITY
-- DEFINER, so leaving the default PUBLIC EXECUTE in place would let any caller
-- invoke a guard out of its trigger context. They are deliberately granted to
-- NO role — the trigger executes them as the table owner:
--   acl-no-grant: enforce_coa_suggestion_source_binding
--   acl-no-grant: prevent_coa_decision_mutation
REVOKE EXECUTE ON FUNCTION public.enforce_coa_suggestion_source_binding() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_coa_suggestion_source_binding() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enforce_coa_suggestion_source_binding() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.prevent_coa_decision_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_coa_decision_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_coa_decision_mutation() FROM authenticated;

-- -----------------------------------------------------------------------------
-- 9. Indexes.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_coa_documents_report_number
  ON public.coa_documents(report_number) WHERE report_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coa_documents_extracted_at
  ON public.coa_documents(extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_coa_extracted_fields_document
  ON public.coa_extracted_fields(coa_document_id);
CREATE INDEX IF NOT EXISTS idx_coa_findings_document
  ON public.coa_findings(coa_document_id);
CREATE INDEX IF NOT EXISTS idx_coa_findings_severity
  ON public.coa_findings(severity);
CREATE INDEX IF NOT EXISTS idx_coa_source_versions_retrieved_at
  ON public.coa_source_versions(retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_coa_source_versions_status
  ON public.coa_source_versions(retrieval_status);
CREATE INDEX IF NOT EXISTS idx_coa_suggestions_document
  ON public.coa_suggestions(coa_document_id);
CREATE INDEX IF NOT EXISTS idx_coa_decisions_document
  ON public.coa_decisions(coa_document_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_source_version
  ON public.compliance_audit_log(source_version_id) WHERE source_version_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 10. Row Level Security — admin-only, matching migration 9's posture.
--
-- Every new table is compliance data and is never exposed to farmer, buyer or
-- public surfaces. coa_decisions additionally pins decided_by to auth.uid() so
-- an administrator can only record a decision in their own name — an
-- unauthorized decision attempt fails at the database boundary.
-- -----------------------------------------------------------------------------
ALTER TABLE public.coa_documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coa_extracted_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coa_findings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coa_source_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coa_suggestions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coa_decisions        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coa_documents: admin all" ON public.coa_documents;
CREATE POLICY "coa_documents: admin all" ON public.coa_documents
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_extracted_fields: admin all" ON public.coa_extracted_fields;
CREATE POLICY "coa_extracted_fields: admin all" ON public.coa_extracted_fields
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_findings: admin all" ON public.coa_findings;
CREATE POLICY "coa_findings: admin all" ON public.coa_findings
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_source_versions: admin all" ON public.coa_source_versions;
CREATE POLICY "coa_source_versions: admin all" ON public.coa_source_versions
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_suggestions: admin all" ON public.coa_suggestions;
CREATE POLICY "coa_suggestions: admin all" ON public.coa_suggestions
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

-- Decisions: admins may read all, but may only INSERT in their own name, and
-- may never update or delete (the append-only trigger also blocks that).
DROP POLICY IF EXISTS "coa_decisions: admin select" ON public.coa_decisions;
CREATE POLICY "coa_decisions: admin select" ON public.coa_decisions
  FOR SELECT USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_decisions: admin insert own" ON public.coa_decisions;
CREATE POLICY "coa_decisions: admin insert own" ON public.coa_decisions
  FOR INSERT WITH CHECK (public.is_ddp_admin() AND decided_by = auth.uid());

COMMIT;
