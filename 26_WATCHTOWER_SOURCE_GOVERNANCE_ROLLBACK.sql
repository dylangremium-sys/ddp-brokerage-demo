-- =============================================================================
-- Migration 26 — ROLLBACK (Watchtower source governance & tiering)
--
-- Reverses ONLY migration 26. It creates nothing and touches no object
-- belonging to another migration. It removes governance columns, constraints,
-- helpers and the Tier-3 authority guard trigger, returning regulatory_sources
-- to its migration-9 + migration-25-consumer shape.
--
-- DATA SAFETY: this rollback drops the governance CLASSIFICATION of every source
-- (tier/authority_type/category/monitoring_method/priority). The source ROWS
-- themselves are untouched. Losing the classification means the Tier-3 authority
-- guard is gone — after this rollback, nothing at the DB level prevents a rule
-- from being enforced on a signal-source basis. That is acceptable only as part
-- of a full Phase-B rollback; do not run it in isolation on a live system that
-- relies on the guard.
--
-- Because the only loss is classification (not evidence), no destructive opt-in
-- gate is required; re-applying migration 26 re-backfills every existing row to
-- the conservative Tier-3 default, so the guard fails closed again.
--
-- ORDERING: safe to run before or after rolling back migration 25. It does not
-- touch legal_updates.source_tier (that column belongs to migration 25); it only
-- READS it via the dropped trigger, which is removed here first.
-- =============================================================================

BEGIN;

-- 1. Trigger + its function (drop the trigger before the function).
DROP TRIGGER IF EXISTS compliance_rules_tier3_authority_guard ON public.compliance_rules;
DROP FUNCTION IF EXISTS public.guard_rule_source_authority();

-- 2. Helper functions.
DROP FUNCTION IF EXISTS public.source_can_act_as_authority(UUID);
DROP FUNCTION IF EXISTS public.regulatory_source_tier(UUID);

-- 3. Indexes.
DROP INDEX IF EXISTS public.idx_regulatory_sources_tier_priority;
DROP INDEX IF EXISTS public.idx_regulatory_sources_category;

-- 4. Constraints.
ALTER TABLE public.regulatory_sources
  DROP CONSTRAINT IF EXISTS regulatory_sources_tier_range,
  DROP CONSTRAINT IF EXISTS regulatory_sources_authority_type_allowed,
  DROP CONSTRAINT IF EXISTS regulatory_sources_category_allowed,
  DROP CONSTRAINT IF EXISTS regulatory_sources_monitoring_method_allowed,
  DROP CONSTRAINT IF EXISTS regulatory_sources_priority_range,
  DROP CONSTRAINT IF EXISTS regulatory_sources_tier1_not_aggregator;

-- 5. Columns.
ALTER TABLE public.regulatory_sources
  DROP COLUMN IF EXISTS tier,
  DROP COLUMN IF EXISTS authority_type,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS monitoring_method,
  DROP COLUMN IF EXISTS priority;

-- 6. Post-conditions.
DO $postcondition$
DECLARE
  leftovers text[] := ARRAY[]::text[];
  c text;
BEGIN
  FOR c IN SELECT unnest(ARRAY['tier','authority_type','category','monitoring_method','priority']) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='regulatory_sources' AND column_name=c)
    THEN leftovers := leftovers || ('regulatory_sources.' || c); END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='compliance_rules_tier3_authority_guard') THEN
    leftovers := leftovers || 'trigger compliance_rules_tier3_authority_guard';
  END IF;

  IF array_length(leftovers,1) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 26 incomplete: % still present', array_to_string(leftovers, ', ');
  END IF;

  IF to_regclass('public.regulatory_sources') IS NULL OR to_regclass('public.compliance_rules') IS NULL THEN
    RAISE EXCEPTION 'rollback 26 overreached: a migration-9 table is missing';
  END IF;

  RAISE NOTICE 'rollback 26 complete: governance columns/constraints/helpers/trigger removed; base tables intact.';
END
$postcondition$;

COMMIT;
