\set ON_ERROR_STOP on
BEGIN;

-- Hard guard: must be explicitly armed by the operator.
-- Run with:
-- psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
--   -c "SET ddp.reset.confirm='YES_RESET_STAGING'; SET ddp.reset.scope='BUSINESS_DATA_ONLY';" \
--   -f scripts/reset_staging_business_data.sql
DO $$
DECLARE
  v_confirm text := current_setting('ddp.reset.confirm', true);
  v_scope   text := current_setting('ddp.reset.scope', true);
BEGIN
  IF v_confirm IS DISTINCT FROM 'YES_RESET_STAGING' THEN
    RAISE EXCEPTION 'Refusing reset: set ddp.reset.confirm=YES_RESET_STAGING';
  END IF;
  IF v_scope IS DISTINCT FROM 'BUSINESS_DATA_ONLY' THEN
    RAISE EXCEPTION 'Refusing reset: set ddp.reset.scope=BUSINESS_DATA_ONLY';
  END IF;
END $$;

-- Candidate operational tables to clear if present.
-- Script is tolerant: only existing tables are touched.
DO $$
DECLARE
  tbl text;
  n bigint;
  before_tables text[] := ARRAY[
    'public.farms',
    'public.farm_profiles',
    'public.farm_memberships',
    'public.inventory_batches',
    'public.farmer_review_requests',
    'public.status_history',
    'public.procurement_decisions',
    'public.buyer_pack_snapshots',
    'public.buyer_pack_audit_log',
    'public.buyer_pack_download_log',
    'public.watchtower_ingestion_runs',
    'public.watchtower_ingestion_items',
    'public.compliance_reviews',
    'public.compliance_alerts',
    'public.compliance_entity_status',
    'public.documents',
    'public.ddp_scores',
    'public.risk_flags',
    'public.farmer_documents',
    'public.farmer_photos'
  ];
BEGIN
  RAISE NOTICE '---- PRE-RESET COUNTS ----';
  FOREACH tbl IN ARRAY before_tables LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', tbl) INTO n;
      RAISE NOTICE '% = %', tbl, n;
    END IF;
  END LOOP;
END $$;

-- Purge operational data.
--
-- IMPORTANT: the buyer-pack tables (buyer_pack_snapshots / buyer_pack_audit_log
-- / buyer_pack_download_log) are deliberately IMMUTABLE — they carry
-- BEFORE UPDATE/DELETE/TRUNCATE guards (prevent_buyer_pack_mutation) so an
-- issued buyer pack and its audit trail can never be rewritten. They are
-- therefore NEVER purged here. To avoid a TRUNCATE ... CASCADE from
-- inventory_batches/farms reaching (and being rejected by) those guards, this
-- clears rows with DELETE in child->parent FK order instead of TRUNCATE CASCADE.
-- (All PKs here are UUIDs, so RESTART IDENTITY is unnecessary.)
--
-- NOTE: if buyer-pack snapshots reference the rows being cleared, the immutable
-- audit intentionally blocks the delete — that is correct behaviour, not a bug.
DO $$
DECLARE
  tbl text;
  purge_tables text[] := ARRAY[
    'public.status_history',
    'public.farmer_review_requests',
    'public.farmer_documents',
    'public.farmer_photos',
    'public.documents',
    'public.ddp_scores',
    'public.risk_flags',
    'public.procurement_decisions',
    'public.compliance_alerts',
    'public.compliance_reviews',
    'public.compliance_entity_status',
    'public.watchtower_ingestion_items',
    'public.watchtower_ingestion_runs',
    'public.inventory_batches',
    'public.farm_memberships',
    'public.farm_profiles',
    'public.farms'
  ];
BEGIN
  RAISE NOTICE '---- CLEARING BUSINESS ROWS (append-only buyer-pack tables preserved) ----';
  FOREACH tbl IN ARRAY purge_tables LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %s', tbl);
      RAISE NOTICE 'CLEARED %', tbl;
    END IF;
  END LOOP;
END $$;

-- Post-check: required core tables must be empty.
DO $$
DECLARE
  tbl text;
  n bigint;
  must_be_zero text[] := ARRAY[
    'public.farms',
    'public.farm_profiles',
    'public.farm_memberships',
    'public.inventory_batches',
    'public.farmer_review_requests',
    'public.status_history'
  ];
BEGIN
  RAISE NOTICE '---- POST-RESET COUNTS ----';
  FOREACH tbl IN ARRAY must_be_zero LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', tbl) INTO n;
      RAISE NOTICE '% = %', tbl, n;
      IF n <> 0 THEN
        RAISE EXCEPTION 'Reset verification failed: % still has % row(s)', tbl, n;
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
