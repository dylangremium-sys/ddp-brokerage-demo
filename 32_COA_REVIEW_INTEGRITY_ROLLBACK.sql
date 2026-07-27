-- =============================================================================
-- Migration 32 — ROLLBACK (COA review integrity hardening)
--
-- Restores the migration-31 posture: FOR ALL admin policies on the provenance
-- tables and mutable source versions.
--
-- NOTE: this REOPENS two HIGH findings from the red-team audit — provenance
-- becomes overwritable again, and a bound suggestion's source version becomes
-- mutable. Roll back only to unblock, never as a steady state.
--
-- Non-destructive: no row is deleted and no column is dropped.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS coa_source_versions_immutable_once_bound ON public.coa_source_versions;
DROP TRIGGER IF EXISTS coa_extracted_fields_no_update_delete ON public.coa_extracted_fields;
DROP TRIGGER IF EXISTS coa_findings_no_update_delete ON public.coa_findings;

DROP FUNCTION IF EXISTS public.prevent_bound_source_version_mutation();
DROP FUNCTION IF EXISTS public.prevent_coa_provenance_mutation();

DROP POLICY IF EXISTS "coa_extracted_fields: admin select" ON public.coa_extracted_fields;
DROP POLICY IF EXISTS "coa_extracted_fields: admin insert" ON public.coa_extracted_fields;
DROP POLICY IF EXISTS "coa_extracted_fields: admin all" ON public.coa_extracted_fields;
CREATE POLICY "coa_extracted_fields: admin all" ON public.coa_extracted_fields
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "coa_findings: admin select" ON public.coa_findings;
DROP POLICY IF EXISTS "coa_findings: admin insert" ON public.coa_findings;
DROP POLICY IF EXISTS "coa_findings: admin all" ON public.coa_findings;
CREATE POLICY "coa_findings: admin all" ON public.coa_findings
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

COMMIT;
