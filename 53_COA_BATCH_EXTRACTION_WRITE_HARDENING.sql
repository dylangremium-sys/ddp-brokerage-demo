-- =============================================================================
-- 53_COA_BATCH_EXTRACTION_WRITE_HARDENING.sql
--
-- Writes a whole COA pack in ONE call and ONE transaction.
--
-- Depends on migration 28 (document_field_extractions, is_ddp_admin,
-- document_extraction_field_names) and migration 52 (report_ordinal,
-- report_label).
--
--   • Rollback: 53_COA_BATCH_EXTRACTION_WRITE_ROLLBACK.sql
--   • Verify:   53_COA_BATCH_EXTRACTION_WRITE_VERIFY.sql
--
-- WHAT WAS WRONG
-- Two separate defects with one cause: the only write path took ONE ROW.
--
--   ATOMICITY. PostgREST gives every `rpc()` call its own transaction. The
--   endpoint persisted a pack by calling the single-row function once per field,
--   so a pack that failed on its fourteenth row left thirteen rows committed
--   while the endpoint answered 503 and told the caller nothing had been
--   recorded. That statement was false, and it was false in the direction that
--   matters: a document would sit part-read, carrying some of a certificate's
--   fields and none of the rest, with provenance metadata attesting that a
--   machine had read it.
--
--   LATENCY, WHICH IS THE SAME BUG WEARING A DIFFERENT HAT. A five-report pack
--   at up to nineteen permitted field names per report is up to ~95 rows, and
--   therefore up to ~95 sequential HTTP round trips to PostgREST. Extraction
--   itself has been measured at 70, 77, 87, 90 and 95 seconds against a shipped
--   90-second function limit — already intermittent before any writing happens.
--   Adding a second per row is what turns "sometimes times out" into "times out
--   on any pack of real size", and a timeout mid-pack produces exactly the
--   partial write above.
--
-- Fixing them separately would have meant doing the work twice. One call fixes
-- both: nothing can be half-written, and ~95 round trips become 1.
--
-- WHAT THIS DOES
-- Adds `record_document_field_extractions_batch(surface, document_id, rows
-- jsonb) RETURNS integer`, which validates every element BEFORE inserting any of
-- them and returns the number of rows written. Being one function invocation it
-- is one statement, so PostgreSQL's own transaction boundary is the atomicity
-- guarantee — there is no explicit BEGIN inside it and there must not be.
--
-- ─── WHY THE SINGLE-ROW FUNCTION SURVIVES ───────────────────────────────────
-- Migration 28 §3.7 calls itself "the one write path", and this adds a second.
-- That is a real cost and it is accepted for a specific reason: the single-row
-- function is the correct instrument for a human correcting one field on a
-- reviewed document, which is a distinct operation from recording a machine's
-- reading of a whole certificate. Deleting it would force that path to
-- assemble a one-element JSON array, which is worse to read and no safer.
--
-- Both paths enforce the SAME gate — `is_ddp_admin()` — write the SAME table,
-- and are bound by the SAME constraints and the same append-only trigger. A
-- second write path is dangerous when it is a second POLICY; these two share
-- one. The property that matters is preserved: no role holds direct DML.
--
-- ─── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
--
--   • No ON CONFLICT, no upsert, no dedup inside the batch. The table is
--     append-only by design (migration 28 §3.6) and a repeated field is a
--     legitimate re-reading. Silently collapsing duplicates here would make the
--     function quietly lossy, and "how many rows did it write" would stop
--     matching "how many rows did I give it" — which is the one signal the
--     caller has that the write did what it said.
--
--   • No partial success. There is no "wrote 91 of 95, here are the failures"
--     mode. A pack is a reading of one document; a reading missing four fields
--     for reasons nobody recorded is not a smaller reading, it is an unreliable
--     one. The whole call fails and names the element that broke it.
-- =============================================================================

BEGIN;

-- ─── 1. The permitted keys of a row object ──────────────────────────────────
--
-- Declared as a function, in the database, for the same reason migration 28
-- declared its field-name and provenance vocabularies there: the authority for
-- what a valid row looks like should not be a comment that a client is trusted
-- to have read.
CREATE OR REPLACE FUNCTION public.document_extraction_batch_row_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY[
  'field_name','field_value_text','provenance','confidence',
  'extraction_warning','report_ordinal','report_label'
]::text[] $$;

-- ─── 2. The batch write path ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_document_field_extractions_batch(
  p_document_surface text,
  p_document_id      uuid,
  p_rows             jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- A ceiling on one call. A five-report pack is ~95 rows and a very large
  -- document might be several hundred; 1000 is far above anything a real
  -- certificate produces and far below a size that could hold a transaction
  -- open long enough to matter. It exists so a malformed or hostile payload
  -- cannot turn one authorised call into an unbounded write.
  k_max_rows constant integer := 1000;

  elem        jsonb;
  idx         integer := 0;
  written     integer := 0;
  bad_key     text;
  v_ordinal   integer;
  v_conf      numeric;
BEGIN
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'record_document_field_extractions_batch: admin role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'record_document_field_extractions_batch: rows must be a JSON array, got %',
      coalesce(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- An empty array is refused rather than treated as a trivially successful
  -- write of nothing. Reporting success having written nothing is the exact
  -- shape of the defect that discarded farmer photos until PR #97.
  IF jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'record_document_field_extractions_batch: rows is empty — refusing to report success for a write of nothing'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_array_length(p_rows) > k_max_rows THEN
    RAISE EXCEPTION 'record_document_field_extractions_batch: % rows exceeds the per-call maximum of %',
      jsonb_array_length(p_rows), k_max_rows
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  -- The document is checked ONCE, not per row. Same existence check the
  -- single-row function performs, and the same deliberate consequence: the
  -- surface names which foreign key must be set.
  IF p_document_surface = 'farmer_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.farmer_documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: farmer_document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF p_document_surface = 'inventory_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    RAISE EXCEPTION
      'record_document_field_extractions_batch: unknown document_surface "%" '
      '(expected farmer_document or inventory_document)', p_document_surface
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Validate EVERY element before inserting ANY ─────────────────────────
  --
  -- Validation is a separate pass on purpose. Inserting as we validate would
  -- still be atomic — one statement, one transaction — but the error a caller
  -- receives would depend on how far the loop happened to get, and a constraint
  -- violation reported from row 60 is far harder to act on than "row 60 has an
  -- unknown key". The cost is one extra pass over an array of at most 1000
  -- elements.
  FOR elem IN SELECT jsonb_array_elements(p_rows) LOOP
    idx := idx + 1;

    IF jsonb_typeof(elem) <> 'object' THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: row % is a %, expected an object',
        idx, jsonb_typeof(elem)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- An unknown key is a REJECTED row, not an ignored one — the same posture
    -- the endpoint takes on its request body. A caller who misspells
    -- 'report_ordinal' must be told, not silently given a NULL ordinal, which
    -- is precisely the ungrouped row migration 52 exists to prevent.
    SELECT k INTO bad_key
    FROM jsonb_object_keys(elem) AS k
    WHERE k <> ALL (public.document_extraction_batch_row_keys())
    LIMIT 1;

    IF bad_key IS NOT NULL THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: row % has unknown key "%"', idx, bad_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (elem->>'field_name') IS NULL THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: row % has no field_name', idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (elem->>'provenance') IS NULL THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: row % has no provenance', idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Cast defensively so a non-numeric confidence or ordinal is reported
    -- against its row number rather than aborting with a bare cast error that
    -- names neither the row nor the key.
    BEGIN
      v_conf := nullif(elem->>'confidence', '')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: row % has a non-numeric confidence "%"',
        idx, elem->>'confidence'
        USING ERRCODE = 'invalid_parameter_value';
    END;

    BEGIN
      v_ordinal := nullif(elem->>'report_ordinal', '')::integer;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'record_document_field_extractions_batch: row % has a non-integer report_ordinal "%"',
        idx, elem->>'report_ordinal'
        USING ERRCODE = 'invalid_parameter_value';
    END;
  END LOOP;

  -- ── Insert ───────────────────────────────────────────────────────────────
  --
  -- One statement. Every table constraint from migration 28 and 52 still
  -- applies to every row — the confidence/provenance pairing, the
  -- absent-value-needs-a-warning rule, the field-name and provenance
  -- vocabularies, the surface shape, and the ordinal bound. This function
  -- validates the SHAPE of the payload; the table remains the authority on
  -- whether a row is admissible, and a violation aborts the whole call.
  --
  -- recorded_by_user_id comes from auth.uid(), never from the payload, for the
  -- same reason as the single-row path: attribution is a fact about a person,
  -- and a caller must not be able to nominate somebody else.
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, inventory_document_id,
     field_name, field_value_text, provenance, confidence, extraction_warning,
     report_ordinal, report_label, recorded_by_user_id)
  SELECT
    p_document_surface,
    CASE WHEN p_document_surface = 'farmer_document'    THEN p_document_id END,
    CASE WHEN p_document_surface = 'inventory_document' THEN p_document_id END,
    r->>'field_name',
    r->>'field_value_text',
    r->>'provenance',
    nullif(r->>'confidence', '')::numeric,
    r->>'extraction_warning',
    nullif(r->>'report_ordinal', '')::integer,
    r->>'report_label',
    auth.uid()
  FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS written = ROW_COUNT;

  -- The caller gave us N rows and the table took N rows. Anything else means a
  -- row was dropped between validation and insertion, which should be
  -- impossible — so it is checked rather than assumed, and it aborts rather
  -- than returning a count the caller would reasonably trust.
  IF written <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'record_document_field_extractions_batch: wrote % of % rows — refusing to report a partial write as success',
      written, jsonb_array_length(p_rows)
      USING ERRCODE = 'data_exception';
  END IF;

  RETURN written;
END
$$;

-- ─── 3. Privileges ──────────────────────────────────────────────────────────
--
-- Same shape as migration 28 §4 and migration 52 §4. service_role is granted
-- EXECUTE for consistency with the other write path, and the grant is
-- deliberately not sufficient to write: the body calls is_ddp_admin(), which
-- resolves auth.uid() — NULL on a service-role connection carrying no user JWT.

REVOKE EXECUTE ON FUNCTION public.record_document_field_extractions_batch(text,uuid,jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_document_field_extractions_batch(text,uuid,jsonb) TO authenticated, service_role;

-- No role holds EXECUTE on the key vocabulary, and that is the intended end
-- state rather than an omission. It is called only from inside
-- record_document_field_extractions_batch, which is SECURITY DEFINER and
-- therefore executes it as the function owner — a grant to any client role
-- would widen the surface without enabling anything. Migration 28 makes the
-- same decision for document_extraction_field_names() and
-- document_extraction_provenances().
--
--   acl-no-grant: document_extraction_batch_row_keys
REVOKE EXECUTE ON FUNCTION public.document_extraction_batch_row_keys() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.record_document_field_extractions_batch(text,uuid,jsonb) IS
  'Writes a whole COA pack in one call and one transaction. Validates every '
  'element before inserting any, refuses an empty array, and returns the number '
  'of rows written. Replaces a per-row loop that could half-write a pack and '
  'cost one HTTP round trip per field.';

COMMIT;
