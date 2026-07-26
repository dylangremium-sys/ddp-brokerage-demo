-- =============================================================================
-- Migration 27 — Evidence digest de-duplication & extraction provenance
--
-- Closes three gaps left open by the existing evidence surfaces. It is ADDITIVE:
-- it creates one table, adds two columns to public.farmer_documents, and adds
-- indexes/constraints/triggers. It changes no existing table's semantics and
-- rewrites no existing function.
--
-- GAP 1 — digests were captured but never compared.
--   Migration 24 stores evidence_request_attachments.sha256_hex and constrains
--   its shape, but nothing ever looks a digest UP. A byte-identical file could
--   be attached to the same response twice under two filenames and no surface
--   would say so. This migration adds the lookup index, refuses the
--   within-one-response duplicate, and adds a cross-surface lookup function.
--
-- GAP 2 — the COA upload path carried no digest at all.
--   Migration 8 routes COA PDFs into the private farmer-documents bucket and
--   records the path on inventory_batches, but public.farmer_documents has no
--   digest column, so a COA uploaded that way is uncomparable with anything.
--
-- GAP 3 — extracted COA field values carried no provenance and no confidence.
--   public.farmer_documents holds lab_name, report_number, total_thc … as bare
--   columns. Nothing distinguishes a value transcribed verbatim from a document,
--   a value a human typed, and a value a machine guessed — nor records how
--   confident the machine was, nor that a field was unreadable rather than
--   absent. Downstream that is indistinguishable from certainty.
--
-- Verify:   27_EVIDENCE_DIGEST_DEDUP_VERIFY.sql
-- Rollback: 27_EVIDENCE_DIGEST_DEDUP_ROLLBACK.sql
--
-- Preconditions:
--   * public.is_ddp_admin()                     (migration 3 / AUTH_RLS_SCHEMA)
--   * public.can_operationally_access_farm(uuid) (migration 24)
--   * public.evidence_request_attachments,
--     public.evidence_requests                   (migration 24)
--   * public.farmer_documents, public.documents  (FARMER_MVP_MIGRATION /
--                                                 SUPABASE_SCHEMA)
--
-- ORDERING REQUIREMENT (rollback): this migration's RLS policies call
-- public.can_operationally_access_farm(), which migration 24's ROLLBACK drops.
-- Roll back 27 BEFORE 24. Rolling back 24 first would leave a policy on
-- public.document_field_extractions referencing a missing function.
--
-- NOT IN SCOPE, deliberately:
--   * No back-fill of digests for existing rows. Nothing measured them, and a
--     computed-later digest cannot prove what the bytes were at upload time.
--     Inventing one would be fabricated provenance — the same reasoning
--     migration 24 applied to size_bytes on linked existing documents.
--   * No global uniqueness on any digest. The same lab report legitimately
--     recurs — re-submitted after a clarification request, or covering two
--     batches. Duplication is surfaced for a human to judge, not blocked.
--   * No change to migration 24's RPCs. The new constraint is enforced at the
--     table, so it holds for every writer including those RPCs.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions — fail loudly and atomically before creating anything.
-- -----------------------------------------------------------------------------
DO $precondition$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  f text;
  tables text[] := ARRAY['evidence_request_attachments','evidence_requests',
                         'farmer_documents','documents'];
  fns    text[] := ARRAY['is_ddp_admin','can_operationally_access_farm'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      missing := missing || ('table public.' || t);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = f
    ) THEN
      missing := missing || ('function public.' || f || '()');
    END IF;
  END LOOP;

  -- The digest column this migration indexes must already exist: migration 27
  -- compares digests, it does not introduce the attachment digest itself.
  IF to_regclass('public.evidence_request_attachments') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'evidence_request_attachments'
         AND column_name = 'sha256_hex'
     ) THEN
    missing := missing || 'column public.evidence_request_attachments.sha256_hex';
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 27 precondition failed: missing required object(s): %. '
      'Apply migration 24 (and the base schema) before migration 27.',
      array_to_string(missing, ', ');
  END IF;
END
$precondition$;


-- =============================================================================
-- PART 1 — GAP 1: make captured digests comparable.
-- =============================================================================

-- 1.1 Lookup index. Partial on NOT NULL because a digest is NULL for the whole
--     pending_upload window (migration 24 forbids a digest before finalization),
--     and those rows are not comparable evidence yet.
CREATE INDEX IF NOT EXISTS idx_evidence_attachments_sha256_hex
  ON public.evidence_request_attachments (sha256_hex)
  WHERE sha256_hex IS NOT NULL;

-- 1.2 The one duplication that is never legitimate: the same bytes attached
--     TWICE TO ONE RESPONSE. There is no reading under which a farmer needs to
--     submit one file twice in one response; it also silently inflates the
--     aggregate byte budget migration 24 enforces.
--
--     Scoped to response_id — NOT global — because the same digest across
--     different responses or requests is legitimate (re-submission after a
--     clarification request; one lab report covering two batches).
--
--     Tombstoned uploads are excluded: migration 24's removal protocol sets
--     removal_requested_at and treats it as immutable once set, so a tombstoned
--     row is no longer live evidence and must not block re-uploading the file it
--     used to hold.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_evidence_attachments_response_digest
  ON public.evidence_request_attachments (response_id, sha256_hex)
  WHERE sha256_hex IS NOT NULL AND removal_requested_at IS NULL;

-- 1.3 A trigger raising the same rule with an operator-readable message.
--     The unique index above is the authority; this exists so the failure a
--     client sees names the duplicate instead of surfacing a bare 23505 from an
--     index whose name means nothing to the person uploading.
--
--     Fires before trg_evidence_attachment_validate (PostgreSQL runs same-event
--     triggers in name order; digest_dedup < validate), and deliberately defers
--     to that trigger for structural problems: if the response row is missing,
--     this returns and lets migration 24 raise its own foreign-key error rather
--     than mis-reporting the cause.
CREATE OR REPLACE FUNCTION public.fn_evidence_attachment_digest_dedup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  clash record;
BEGIN
  -- Nothing to compare until the digest is measured, and a tombstoned row is not
  -- live evidence.
  IF NEW.sha256_hex IS NULL OR NEW.removal_requested_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.id, a.original_filename
    INTO clash
  FROM public.evidence_request_attachments a
  WHERE a.response_id = NEW.response_id
    AND a.sha256_hex = NEW.sha256_hex
    AND a.removal_requested_at IS NULL
    AND a.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'evidence attachment: file "%" is byte-identical (sha256 %) to attachment % '
      '("%") already on this response. Attach the file once; if this is a revised '
      'document its bytes will differ.',
      NEW.original_filename, NEW.sha256_hex, clash.id, clash.original_filename
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_attachment_digest_dedup
  ON public.evidence_request_attachments;
CREATE TRIGGER trg_evidence_attachment_digest_dedup
  BEFORE INSERT OR UPDATE ON public.evidence_request_attachments
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_attachment_digest_dedup();


-- =============================================================================
-- PART 2 — GAP 2: give the COA upload path a digest.
-- =============================================================================

-- 2.1 Digest + the time it was measured. Both nullable: existing rows were never
--     hashed (see NOT IN SCOPE above). They are nullable TOGETHER — a digest
--     without a measurement time is a number with no provenance, so 2.2 ties
--     them.
ALTER TABLE public.farmer_documents
  ADD COLUMN IF NOT EXISTS sha256_hex          char(64),
  ADD COLUMN IF NOT EXISTS sha256_recorded_at  timestamptz;

-- 2.2 Shape + pairing. Same 64-lowercase-hex shape migration 24 requires, so a
--     digest is comparable across both surfaces without normalisation.
ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS farmer_documents_sha256_hex_format_check;
ALTER TABLE public.farmer_documents
  ADD CONSTRAINT farmer_documents_sha256_hex_format_check
    CHECK (sha256_hex IS NULL OR sha256_hex ~ '^[0-9a-f]{64}$');

ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS farmer_documents_sha256_pairing_check;
ALTER TABLE public.farmer_documents
  ADD CONSTRAINT farmer_documents_sha256_pairing_check
    CHECK ((sha256_hex IS NULL) = (sha256_recorded_at IS NULL));

CREATE INDEX IF NOT EXISTS idx_farmer_documents_sha256_hex
  ON public.farmer_documents (sha256_hex)
  WHERE sha256_hex IS NOT NULL;

-- 2.3 Cross-surface duplicate lookup.
--
--     SECURITY INVOKER (the default) is load-bearing, not an omission. This
--     function reads two RLS-protected surfaces. As SECURITY DEFINER it would
--     run as the owner and happily report another farm's documents to any caller
--     who guessed a digest — turning a de-duplication helper into a
--     cross-tenant disclosure oracle. As INVOKER, each caller sees exactly the
--     rows their own policies already allow: an admin sees every match, a farmer
--     sees matches on their own farms.
CREATE OR REPLACE FUNCTION public.find_document_digest_matches(
  p_sha256_hex char(64)
)
RETURNS TABLE (
  surface             text,
  document_id         uuid,
  farm_id             uuid,
  inventory_batch_id  uuid,
  label               text,
  recorded_at         timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT 'evidence_request_attachment'::text,
         a.id,
         er.farm_id,
         er.inventory_batch_id,
         a.original_filename,
         a.finalized_at
  FROM public.evidence_request_attachments a
  JOIN public.evidence_requests er ON er.id = a.request_id
  WHERE a.sha256_hex = p_sha256_hex
    AND a.removal_requested_at IS NULL

  UNION ALL

  SELECT 'farmer_document'::text,
         fd.id,
         fd.farm_id,
         fd.inventory_batch_id,
         fd.file_name,
         fd.sha256_recorded_at
  FROM public.farmer_documents fd
  WHERE fd.sha256_hex = p_sha256_hex
$$;


-- =============================================================================
-- PART 3 — GAP 3: record where each extracted field value came from.
-- =============================================================================

-- 3.1 Canonical field names. IMMUTABLE so it can be used inside a CHECK.
--     Authoritative in the database; a client may mirror it for usability but is
--     never the authority.
CREATE OR REPLACE FUNCTION public.document_extraction_field_names()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY[
  'laboratory_name','accreditation_reference','report_number','sample_name',
  'sample_id','batch_reference','test_date','received_date',
  'total_thc','total_cbd','moisture_pct','water_activity',
  'heavy_metals_result','pesticides_result','microbial_result',
  'mycotoxins_result','residual_solvents_result','foreign_matter_result',
  'other'
]::text[] $$;

-- 3.2 Provenance vocabulary.
--     reported          — transcribed verbatim from the document as printed
--     operator_entered  — a person typed it, not read off the document
--     machine_extracted — produced by automated extraction
CREATE OR REPLACE FUNCTION public.document_extraction_provenances()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY['reported','operator_entered','machine_extracted']::text[] $$;

-- 3.3 The extraction record.
--
--     APPEND-ONLY BY DESIGN (3.6): re-extracting a field INSERTS a new row. The
--     current value of a field is its most recent row by extracted_at. Nothing
--     overwrites an earlier reading, so "what did we believe, when, and on what
--     basis" stays answerable — which is the whole point of recording provenance
--     rather than just a value.
CREATE TABLE IF NOT EXISTS public.document_field_extractions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which document surface this reading came from. Mirrors migration 24's origin
  -- discriminator pattern: the surface names which FK must be set.
  document_surface       text NOT NULL,
  farmer_document_id     uuid REFERENCES public.farmer_documents(id) ON DELETE RESTRICT,
  inventory_document_id  uuid REFERENCES public.documents(id)        ON DELETE RESTRICT,

  field_name             text NOT NULL,

  -- TEXT, never numeric, and deliberately so. On a real COA "ND", "<LOQ",
  -- "< 0.05", "0.0" and a blank cell mean four different things and a missing
  -- result. Parsing them into a numeric column at intake destroys that
  -- distinction permanently and reads a non-detect as a measured zero.
  -- Normalisation is a downstream decision made against a preserved original.
  field_value_text       text,

  provenance             text NOT NULL,

  -- Only meaningful for machine_extracted (3.4). NULL is not "unknown
  -- confidence" — for a human provenance it is the only correct value.
  confidence             numeric,

  -- Why a value is absent or doubtful. Mandatory when there is no value (3.5).
  extraction_warning     text,

  extracted_at           timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id    uuid REFERENCES auth.users(id) ON DELETE RESTRICT,

  CONSTRAINT dfe_surface_check
    CHECK (document_surface IN ('farmer_document','inventory_document')),

  CONSTRAINT dfe_field_name_check
    CHECK (field_name = ANY (public.document_extraction_field_names())),

  CONSTRAINT dfe_provenance_check
    CHECK (provenance = ANY (public.document_extraction_provenances())),

  -- Exactly one document FK, matching the declared surface.
  CONSTRAINT dfe_surface_shape_check CHECK (
    (document_surface = 'farmer_document'
       AND farmer_document_id IS NOT NULL AND inventory_document_id IS NULL)
    OR
    (document_surface = 'inventory_document'
       AND inventory_document_id IS NOT NULL AND farmer_document_id IS NULL)
  ),

  -- 3.4 CONFIDENCE INTEGRITY — the constraint this table exists for.
  --
  --   machine_extracted MUST carry a confidence in [0,1]: an automated reading
  --   with no stated confidence is presented downstream as though it were
  --   certain.
  --
  --   reported / operator_entered MUST have confidence NULL. A human
  --   transcription has no model confidence, and writing 1.0 there would
  --   manufacture a certainty score nobody measured — then let it be averaged,
  --   thresholded and reported as if it meant something.
  CONSTRAINT dfe_confidence_provenance_check CHECK (
    CASE provenance
      WHEN 'machine_extracted' THEN confidence IS NOT NULL AND confidence >= 0 AND confidence <= 1
      ELSE confidence IS NULL
    END
  ),

  -- 3.5 A missing value must say why. Recording NULL with no warning is
  --     indistinguishable from "this field is not on the document" and from
  --     "we could not read it", which are different compliance facts.
  CONSTRAINT dfe_absent_value_needs_warning_check
    CHECK (field_value_text IS NOT NULL OR extraction_warning IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dfe_farmer_document
  ON public.document_field_extractions (farmer_document_id)
  WHERE farmer_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dfe_inventory_document
  ON public.document_field_extractions (inventory_document_id)
  WHERE inventory_document_id IS NOT NULL;
-- Serves "current value of this field" (latest extracted_at per document/field).
CREATE INDEX IF NOT EXISTS idx_dfe_field_latest
  ON public.document_field_extractions (document_surface, field_name, extracted_at DESC);

-- 3.6 Append-only. Same shape as migration 24's history guard: an extraction is
--     evidence of what was believed at a point in time, so it is never edited
--     and never deleted.
CREATE OR REPLACE FUNCTION public.fn_dfe_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'document_field_extractions is append-only: % is not permitted. '
    'Record a corrected reading as a NEW row; the current value of a field is '
    'its most recent extracted_at.', TG_OP
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_dfe_append_only ON public.document_field_extractions;
CREATE TRIGGER trg_dfe_append_only
  BEFORE UPDATE OR DELETE ON public.document_field_extractions
  FOR EACH ROW EXECUTE FUNCTION public.fn_dfe_append_only();

-- 3.7 The one write path. SECURITY DEFINER so the caller needs no direct DML
--     (3.8 removes it), admin-gated because extraction records are back-office
--     assertions about a document, not farmer-supplied content.
CREATE OR REPLACE FUNCTION public.record_document_field_extraction(
  p_document_surface   text,
  p_document_id        uuid,
  p_field_name         text,
  p_field_value_text   text,
  p_provenance         text,
  p_confidence         numeric DEFAULT NULL,
  p_extraction_warning text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'record_document_field_extraction: admin role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_document_surface = 'farmer_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.farmer_documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extraction: farmer_document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text,
       provenance, confidence, extraction_warning, recorded_by_user_id)
    VALUES ('farmer_document', p_document_id, p_field_name, p_field_value_text,
            p_provenance, p_confidence, p_extraction_warning, auth.uid())
    RETURNING id INTO new_id;

  ELSIF p_document_surface = 'inventory_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extraction: document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO public.document_field_extractions
      (document_surface, inventory_document_id, field_name, field_value_text,
       provenance, confidence, extraction_warning, recorded_by_user_id)
    VALUES ('inventory_document', p_document_id, p_field_name, p_field_value_text,
            p_provenance, p_confidence, p_extraction_warning, auth.uid())
    RETURNING id INTO new_id;

  ELSE
    RAISE EXCEPTION
      'record_document_field_extraction: unknown document_surface "%" '
      '(expected farmer_document or inventory_document)', p_document_surface
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN new_id;
END
$$;

-- 3.8 Privileges. Every write goes through 3.7, so no client role — and not
--     service_role either — holds direct DML. Supabase's ALTER DEFAULT
--     PRIVILEGES grants service_role full DML on new public tables, which would
--     otherwise leave a path around the append-only trigger's intent; the RPC is
--     owned by postgres and is unaffected by this revoke.
REVOKE ALL ON public.document_field_extractions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.document_field_extractions TO authenticated, service_role;

-- 3.9 RLS. SELECT-only policies, mirroring migration 24: admin sees everything,
--     an operational farmer sees only farms they currently hold membership for.
ALTER TABLE public.document_field_extractions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dfe: admin select all" ON public.document_field_extractions;
CREATE POLICY "dfe: admin select all"
  ON public.document_field_extractions FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "dfe: operational farmer select own farm" ON public.document_field_extractions;
CREATE POLICY "dfe: operational farmer select own farm"
  ON public.document_field_extractions FOR SELECT
  USING (
    (farmer_document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.farmer_documents fd
      WHERE fd.id = document_field_extractions.farmer_document_id
        AND public.can_operationally_access_farm(fd.farm_id)
    ))
    OR
    (inventory_document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_field_extractions.inventory_document_id
        AND public.can_operationally_access_farm(d.farm_id)
    ))
  );


-- =============================================================================
-- PART 4 — function EXECUTE privileges, least privilege.
-- =============================================================================
-- Client-callable: the write RPC and the de-duplication lookup. anon executes
-- nothing.
REVOKE EXECUTE ON FUNCTION public.record_document_field_extraction(text,uuid,text,text,text,numeric,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_document_field_extraction(text,uuid,text,text,text,numeric,text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.find_document_digest_matches(char) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.find_document_digest_matches(char) TO authenticated, service_role;

-- Internal only. Trigger bodies are invoked solely by the trigger machinery, and
-- the vocabulary helpers are evaluated inside CHECK constraints and inside the
-- SECURITY DEFINER RPC — all in the definer's privilege context, so no client
-- role needs EXECUTE. Deliberate no-grant decisions:
--        acl-no-grant: fn_evidence_attachment_digest_dedup
--        acl-no-grant: fn_dfe_append_only
--        acl-no-grant: document_extraction_field_names
--        acl-no-grant: document_extraction_provenances
REVOKE EXECUTE ON FUNCTION public.fn_evidence_attachment_digest_dedup() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_dfe_append_only()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_extraction_field_names()     FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_extraction_provenances()     FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
