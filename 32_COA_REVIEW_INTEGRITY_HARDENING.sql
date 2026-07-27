-- =============================================================================
-- Migration 32 — COA review integrity hardening (red-team remediation, #77)
--
-- Closes two HIGH findings from the adversarial audit of migration 31. Both
-- were confirmed empirically against staging before this migration was written,
-- and both are re-tested by src/lib/coaRedTeam.integration.test.ts.
--
-- FINDING 1 — a bound suggestion could be silently invalidated.
--   The migration-31 binding trigger fires on coa_suggestions only. Nothing
--   protected coa_source_versions, so after a suggestion was bound, the cited
--   source row could be UPDATEd to retrieval_status='timeout' (or have its
--   content_fingerprint changed) while the suggestion stayed 'bound'. The
--   result: a displayed regulatory suggestion resting on a source that no
--   longer claims to have been retrieved — exactly the state the gate forbids.
--
--   Fix: a source version becomes IMMUTABLE once a bound suggestion cites it.
--   Provenance is a historical record of one retrieval; there is no legitimate
--   reason to rewrite it afterwards.
--
-- FINDING 2 — stored provenance could be overwritten.
--   coa_extracted_fields and coa_findings carried FOR ALL admin policies, so
--   anything holding an admin token could UPDATE a value the server had read
--   from the PDF — replacing an extracted result with an arbitrary one while
--   keeping its page citation. Confirmed by overwriting total_thc with the
--   literal 'FABRICATED' on staging.
--
--   Fix: both tables become append-only. Extraction is deterministic for a
--   given set of bytes, so a re-run produces identical rows and never needs to
--   overwrite; the repository inserts-if-absent instead of upserting.
--
-- Everything here is additive and reversible.
--
-- Verify:   32_COA_REVIEW_INTEGRITY_VERIFY.sql
-- Rollback: 32_COA_REVIEW_INTEGRITY_ROLLBACK.sql
--
-- Preconditions: migration 31.
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.coa_source_versions')  IS NULL THEN missing := missing || 'public.coa_source_versions';  END IF;
  IF to_regclass('public.coa_suggestions')      IS NULL THEN missing := missing || 'public.coa_suggestions';      END IF;
  IF to_regclass('public.coa_extracted_fields') IS NULL THEN missing := missing || 'public.coa_extracted_fields'; END IF;
  IF to_regclass('public.coa_findings')         IS NULL THEN missing := missing || 'public.coa_findings';         END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 32 precondition failed: missing %. Apply migration 31 first.',
      array_to_string(missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. FINDING 1 — a cited source version is immutable.
--
-- Deliberately refuses the whole UPDATE rather than only the security-relevant
-- columns: a retrieval record is a statement about what an authority served at
-- one moment, and no column of it should drift afterwards. DELETE is already
-- blocked by coa_suggestions.source_version_id being ON DELETE RESTRICT.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_bound_source_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  citing_count integer;
BEGIN
  SELECT count(*) INTO citing_count
  FROM public.coa_suggestions
  WHERE source_version_id = OLD.id
    AND state = 'bound';

  IF citing_count > 0 THEN
    RAISE EXCEPTION
      'coa_source_versions: version % is cited by % bound suggestion(s) and is immutable; '
      'a retrieved source version is a historical record and cannot be rewritten',
      OLD.id, citing_count;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS coa_source_versions_immutable_once_bound ON public.coa_source_versions;
CREATE TRIGGER coa_source_versions_immutable_once_bound
  BEFORE UPDATE ON public.coa_source_versions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_bound_source_version_mutation();

-- acl-no-grant: prevent_bound_source_version_mutation
REVOKE EXECUTE ON FUNCTION public.prevent_bound_source_version_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_bound_source_version_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_bound_source_version_mutation() FROM authenticated;

-- -----------------------------------------------------------------------------
-- 2. FINDING 2 — extracted fields and findings are append-only.
--
-- The FOR ALL policies are replaced by SELECT + INSERT. With no UPDATE or
-- DELETE policy, RLS matches zero rows for those commands, so a rewrite affects
-- nothing. The trigger below additionally makes the refusal LOUD for any caller
-- that reaches the row (an owner connection, a future SECURITY DEFINER path),
-- rather than a silent no-op.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_coa_provenance_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    '%: extracted provenance is append-only; attempted % is not allowed. '
    'Re-extraction is deterministic and inserts only absent rows.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

-- acl-no-grant: prevent_coa_provenance_mutation
REVOKE EXECUTE ON FUNCTION public.prevent_coa_provenance_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_coa_provenance_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_coa_provenance_mutation() FROM authenticated;

DROP TRIGGER IF EXISTS coa_extracted_fields_no_update_delete ON public.coa_extracted_fields;
CREATE TRIGGER coa_extracted_fields_no_update_delete
  BEFORE UPDATE OR DELETE ON public.coa_extracted_fields
  FOR EACH ROW EXECUTE FUNCTION public.prevent_coa_provenance_mutation();

DROP TRIGGER IF EXISTS coa_findings_no_update_delete ON public.coa_findings;
CREATE TRIGGER coa_findings_no_update_delete
  BEFORE UPDATE OR DELETE ON public.coa_findings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_coa_provenance_mutation();

-- Replace FOR ALL with SELECT + INSERT only.
DROP POLICY IF EXISTS "coa_extracted_fields: admin all" ON public.coa_extracted_fields;
DROP POLICY IF EXISTS "coa_extracted_fields: admin select" ON public.coa_extracted_fields;
CREATE POLICY "coa_extracted_fields: admin select" ON public.coa_extracted_fields
  FOR SELECT USING (public.is_ddp_admin());
DROP POLICY IF EXISTS "coa_extracted_fields: admin insert" ON public.coa_extracted_fields;
CREATE POLICY "coa_extracted_fields: admin insert" ON public.coa_extracted_fields
  FOR INSERT WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_findings: admin all" ON public.coa_findings;
DROP POLICY IF EXISTS "coa_findings: admin select" ON public.coa_findings;
CREATE POLICY "coa_findings: admin select" ON public.coa_findings
  FOR SELECT USING (public.is_ddp_admin());
DROP POLICY IF EXISTS "coa_findings: admin insert" ON public.coa_findings;
CREATE POLICY "coa_findings: admin insert" ON public.coa_findings
  FOR INSERT WITH CHECK (public.is_ddp_admin());

COMMIT;
