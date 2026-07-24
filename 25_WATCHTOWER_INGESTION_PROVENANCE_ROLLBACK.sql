-- =============================================================================
-- Migration 25 — ROLLBACK (Watchtower ingestion provenance & dedup)
--
-- Reverses ONLY migration 25. It creates nothing, and it touches no object
-- belonging to any other migration. The Watchtower tables created by
-- 9_COMPLIANCE_WATCHTOWER_MVP.sql are left exactly as migration 25 found them.
--
-- ORDERING REQUIREMENT: roll back migration 26 (source governance & tiering)
-- BEFORE this file if it was applied. Migration 26's Tier-3 authority guard
-- reads legal_updates.source_tier, which this file drops.
--
-- DATA SAFETY: migration 25's tables hold ingestion evidence — the record of
-- which sources were checked, when, with what outcome. That is audit data, and
-- the forward migration deliberately makes it undeletable. This rollback
-- therefore REFUSES to run while any run or item exists, unless the operator
-- explicitly opts in by setting, in the same transaction:
--
--     SET LOCAL watchtower.rollback_destructive = 'true';
--
-- WHAT IS LOST on a destructive rollback: every ingestion run and item record,
-- and the provenance columns on legal_updates (content_hash, canonical_url,
-- external_document_id, source_tier, ingestion_run_id, ingestion_item_key).
-- The legal_updates ROWS themselves are NOT deleted — only their provenance
-- columns are dropped, so records created by ingestion survive as ordinary
-- (manual-looking) updates. Re-applying migration 25 afterwards cannot
-- reconstruct that provenance; capture a dump first if it matters.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Refuse to destroy live ingestion evidence unless explicitly authorized.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  run_count       integer := 0;
  item_count      integer := 0;
  provenance_rows integer := 0;
  opt_in          text;
BEGIN
  IF to_regclass('public.watchtower_ingestion_runs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.watchtower_ingestion_runs' INTO run_count;
  END IF;
  IF to_regclass('public.watchtower_ingestion_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.watchtower_ingestion_items' INTO item_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'legal_updates' AND column_name = 'content_hash'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.legal_updates WHERE content_hash IS NOT NULL'
      INTO provenance_rows;
  END IF;

  IF run_count > 0 OR item_count > 0 OR provenance_rows > 0 THEN
    BEGIN
      opt_in := current_setting('watchtower.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN
      opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 25 refused: % ingestion run(s), % item(s) and % legal update(s) with '
        'provenance exist. This data is retained monitoring evidence. To proceed '
        'deliberately, run SET LOCAL watchtower.rollback_destructive = ''true''; in the '
        'same transaction.',
        run_count, item_count, provenance_rows;
    END IF;

    RAISE NOTICE
      'rollback 25: destructive opt-in acknowledged — removing % run(s), % item(s) and the '
      'provenance of % legal update(s).',
      run_count, item_count, provenance_rows;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Triggers (dropped before their functions).
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS watchtower_ingestion_items_no_update_delete ON public.watchtower_ingestion_items;
DROP TRIGGER IF EXISTS watchtower_ingestion_items_run_open_guard   ON public.watchtower_ingestion_items;
DROP TRIGGER IF EXISTS watchtower_ingestion_runs_update_guard      ON public.watchtower_ingestion_runs;

-- -----------------------------------------------------------------------------
-- 2. legal_updates provenance — indexes, constraints, then columns.
--
-- Dropping a column would remove its dependent index/constraint anyway; they
-- are named explicitly first so this file reads as an exact inverse of the
-- forward migration and leaves nothing to infer.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uniq_legal_updates_content_hash;
DROP INDEX IF EXISTS public.uniq_legal_updates_source_external_document_id;
DROP INDEX IF EXISTS public.idx_legal_updates_canonical_url;
DROP INDEX IF EXISTS public.idx_legal_updates_source_detected_at;
DROP INDEX IF EXISTS public.idx_legal_updates_ingestion_run_id;

ALTER TABLE public.legal_updates
  DROP CONSTRAINT IF EXISTS legal_updates_ingestion_run_id_fkey,
  DROP CONSTRAINT IF EXISTS legal_updates_content_hash_format,
  DROP CONSTRAINT IF EXISTS legal_updates_canonical_url_bounded,
  DROP CONSTRAINT IF EXISTS legal_updates_external_document_id_bounded,
  DROP CONSTRAINT IF EXISTS legal_updates_source_tier_range;

ALTER TABLE public.legal_updates
  DROP COLUMN IF EXISTS content_hash,
  DROP COLUMN IF EXISTS canonical_url,
  DROP COLUMN IF EXISTS external_document_id,
  DROP COLUMN IF EXISTS source_tier,
  DROP COLUMN IF EXISTS ingestion_run_id,
  DROP COLUMN IF EXISTS ingestion_item_key;

-- -----------------------------------------------------------------------------
-- 3. Ingestion evidence tables (items first — it references runs).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.watchtower_ingestion_items;
DROP TABLE IF EXISTS public.watchtower_ingestion_runs;

-- -----------------------------------------------------------------------------
-- 4. Trigger functions.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.prevent_watchtower_ingestion_item_mutation();
DROP FUNCTION IF EXISTS public.guard_watchtower_ingestion_item_insert();
DROP FUNCTION IF EXISTS public.guard_watchtower_ingestion_run_update();

-- -----------------------------------------------------------------------------
-- 5. Post-conditions — prove the reversal is complete.
-- -----------------------------------------------------------------------------
DO $postcondition$
DECLARE
  leftovers text[] := ARRAY[]::text[];
  c text;
BEGIN
  IF to_regclass('public.watchtower_ingestion_runs')  IS NOT NULL THEN
    leftovers := leftovers || 'table watchtower_ingestion_runs'; END IF;
  IF to_regclass('public.watchtower_ingestion_items') IS NOT NULL THEN
    leftovers := leftovers || 'table watchtower_ingestion_items'; END IF;

  FOR c IN SELECT unnest(ARRAY['content_hash','canonical_url','external_document_id',
                               'source_tier','ingestion_run_id','ingestion_item_key'])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='legal_updates' AND column_name=c)
    THEN leftovers := leftovers || ('legal_updates.' || c); END IF;
  END LOOP;

  IF array_length(leftovers,1) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 25 incomplete: % still present', array_to_string(leftovers, ', ');
  END IF;

  -- The migration-9 tables this rollback must NOT have touched.
  IF to_regclass('public.legal_updates') IS NULL OR to_regclass('public.regulatory_sources') IS NULL THEN
    RAISE EXCEPTION 'rollback 25 overreached: a migration-9 Watchtower table is missing';
  END IF;

  RAISE NOTICE 'rollback 25 complete: migration-25 objects removed; migration-9 tables intact.';
END
$postcondition$;

COMMIT;
