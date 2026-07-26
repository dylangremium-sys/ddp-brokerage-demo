-- Destructive-guard seed for the 28_digest fixture.
--
-- Creates the two kinds of provenance data migration 28's ROLLBACK guard must
-- refuse to destroy without an explicit opt-in: one append-only extraction
-- record, and one farmer_documents row carrying a recorded digest. This is
-- HARNESS TEST DATA, not migration SQL — it mirrors the migration's own VERIFY
-- control inserts rather than duplicating any DDL.
--
-- After this seed the guard must REFUSE a rollback without the opt-in (leaving
-- both rows intact), and SUCCEED with it — the property no static test can prove.
DO $seed$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  ext_id uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: no auth.users row available to act as recorder';
  END IF;

  INSERT INTO public.farms (id, created_by)
    VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;

  -- A COA-path document whose digest was measured at intake.
  INSERT INTO public.farmer_documents
    (farm_id, document_type, file_name, sha256_hex, sha256_recorded_at)
  VALUES (farm_v, 'coa', 'guard-seed-coa.pdf', repeat('7', 64), now())
  RETURNING id INTO fd_id;

  -- One machine-extracted reading, with its confidence, against that document.
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, field_name, field_value_text,
     provenance, confidence, recorded_by_user_id)
  VALUES ('farmer_document', fd_id, 'report_number', 'GS-2026-001',
          'machine_extracted', 0.82, actor)
  RETURNING id INTO ext_id;

  IF fd_id IS NULL OR ext_id IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: control inserts produced no row (guard test would be vacuous)';
  END IF;

  RAISE NOTICE
    'guard seed: 1 recorded digest (farmer_document %) and 1 extraction record (%) created.',
    fd_id, ext_id;
END
$seed$;
