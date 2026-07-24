-- =============================================================================
-- Migration 26 — Watchtower source governance & tiering (Phase B)
--
-- Adds explicit authority governance to regulatory_sources: tier (1 primary /
-- 2 secondary / 3 signal), authority type, category, monitoring method, and
-- priority. Also installs the Tier-3 authority guard so a Tier 3 (intelligence
-- signal) source can never be treated as a direct authority in downstream
-- compliance state at the database level.
--
-- Scope of THIS file (public schema only):
--   1. regulatory_sources governance columns + allowed-value CHECK constraints
--   2. Conservative backfill of existing rows (Tier 3 signal — least authority)
--   3. Governance helper functions (tier lookup + direct-authority predicate)
--   4. A guard trigger preventing a Tier-3 source from sourcing an ENFORCED
--      compliance_rule (approved/active) — the downstream-state boundary
--   5. Indexes for tier/priority-ordered monitoring
--
-- Explicitly NOT in this migration (later phases): rule activation logic,
-- impact analysis, alert propagation, AI. The Tier-3 guard here is a structural
-- boundary only — it blocks a forbidden state, it does not implement lifecycle.
--
-- Backward compatibility: the new columns are added NULLABLE, backfilled, and
-- only THEN defaulted, so the ALTER never rewrites existing rows against a
-- volatile default and no existing reader breaks. is_active / jurisdiction are
-- reused as the enable flag and jurisdiction fields (not duplicated).
--
-- Verify:   26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql
-- Rollback: 26_WATCHTOWER_SOURCE_GOVERNANCE_ROLLBACK.sql
--
-- Preconditions:
--   * public.is_ddp_admin()          (migration 3 / AUTH_RLS_SCHEMA)
--   * public.regulatory_sources      (migration 9)
--   * public.compliance_rules        (migration 9)
--   * public.legal_updates.source_tier (migration 25) — provenance snapshot
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

  IF to_regclass('public.regulatory_sources') IS NULL THEN
    missing := missing || 'public.regulatory_sources'; END IF;
  IF to_regclass('public.compliance_rules') IS NULL THEN
    missing := missing || 'public.compliance_rules'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='legal_updates' AND column_name='source_tier'
  ) THEN missing := missing || 'public.legal_updates.source_tier (apply migration 25 first)'; END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 26 precondition failed: missing required object(s): %. '
      'Apply migrations 3, 9 and 25 before migration 26.',
      array_to_string(missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Add governance columns — NULLABLE first (no table rewrite, no default yet).
-- -----------------------------------------------------------------------------
ALTER TABLE public.regulatory_sources
  ADD COLUMN IF NOT EXISTS tier              SMALLINT,
  ADD COLUMN IF NOT EXISTS authority_type    TEXT,
  ADD COLUMN IF NOT EXISTS category          TEXT,
  ADD COLUMN IF NOT EXISTS monitoring_method TEXT,
  ADD COLUMN IF NOT EXISTS priority          SMALLINT;

-- -----------------------------------------------------------------------------
-- 2. Backfill existing rows conservatively BEFORE any NOT NULL / default.
--
-- Every pre-existing source is classified as the LEAST authoritative shape
-- (Tier 3 intelligence signal) so nothing silently gains authority on upgrade.
-- The operator must consciously promote a source to Tier 1/2. monitoring_method
-- is left NULL here (unknown for legacy rows) and defaulted to 'manual' in step 3.
-- -----------------------------------------------------------------------------
UPDATE public.regulatory_sources
SET tier           = COALESCE(tier, 3),
    authority_type = COALESCE(authority_type, 'aggregator'),
    category       = COALESCE(category, 'general'),
    priority       = COALESCE(priority, 100)
WHERE tier IS NULL
   OR authority_type IS NULL
   OR category IS NULL
   OR priority IS NULL;

UPDATE public.regulatory_sources
SET monitoring_method = 'manual'
WHERE monitoring_method IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Constraints + defaults + NOT NULL (now safe: every row is populated).
--
-- Defaults are the conservative Tier-3 signal shape, mirroring
-- defaultSourceGovernance() in src/lib/complianceSourceGovernance.ts, so a row
-- inserted without governance fields is a signal, never an authority.
-- -----------------------------------------------------------------------------
ALTER TABLE public.regulatory_sources
  ALTER COLUMN tier              SET DEFAULT 3,
  ALTER COLUMN authority_type    SET DEFAULT 'aggregator',
  ALTER COLUMN category          SET DEFAULT 'general',
  ALTER COLUMN monitoring_method SET DEFAULT 'manual',
  ALTER COLUMN priority          SET DEFAULT 100;

ALTER TABLE public.regulatory_sources
  ALTER COLUMN tier              SET NOT NULL,
  ALTER COLUMN authority_type    SET NOT NULL,
  ALTER COLUMN category          SET NOT NULL,
  ALTER COLUMN monitoring_method SET NOT NULL,
  ALTER COLUMN priority          SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regulatory_sources_tier_range') THEN
    ALTER TABLE public.regulatory_sources
      ADD CONSTRAINT regulatory_sources_tier_range CHECK (tier IN (1, 2, 3));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regulatory_sources_authority_type_allowed') THEN
    ALTER TABLE public.regulatory_sources
      ADD CONSTRAINT regulatory_sources_authority_type_allowed CHECK (authority_type IN (
        'primary_regulator','ministry','official_gazette','court','standards_body',
        'industry_association','news_media','aggregator','other'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regulatory_sources_category_allowed') THEN
    ALTER TABLE public.regulatory_sources
      ADD CONSTRAINT regulatory_sources_category_allowed CHECK (category IN (
        'cultivation','export_import','pharmaceutical','data_protection',
        'licensing','testing_quality','general'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regulatory_sources_monitoring_method_allowed') THEN
    ALTER TABLE public.regulatory_sources
      ADD CONSTRAINT regulatory_sources_monitoring_method_allowed CHECK (monitoring_method IN (
        'rss','atom','html','pdf','government_api','manual'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regulatory_sources_priority_range') THEN
    ALTER TABLE public.regulatory_sources
      ADD CONSTRAINT regulatory_sources_priority_range CHECK (priority BETWEEN 1 AND 100);
  END IF;

  -- Cross-field contradiction guard (mirrors validateSourceGovernance): a
  -- primary authority cannot be classified as news/aggregator.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regulatory_sources_tier1_not_aggregator') THEN
    ALTER TABLE public.regulatory_sources
      ADD CONSTRAINT regulatory_sources_tier1_not_aggregator CHECK (
        tier <> 1 OR authority_type NOT IN ('news_media','aggregator'));
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.regulatory_sources.tier IS
  'Authority tier: 1 primary authority, 2 authoritative secondary, 3 intelligence signal. '
  'Tier 3 must never act as a direct authority in downstream compliance state.';
COMMENT ON COLUMN public.regulatory_sources.priority IS
  'Monitoring urgency, 1 (most urgent) .. 100 (least). Lower is checked first.';

-- -----------------------------------------------------------------------------
-- 4. Governance helper functions.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.regulatory_source_tier(p_source_id UUID)
RETURNS SMALLINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tier FROM public.regulatory_sources WHERE id = p_source_id;
$$;

-- The database-side mirror of canActAsDirectAuthority(): true only for Tier 1/2.
-- A NULL/absent tier fails closed to false.
CREATE OR REPLACE FUNCTION public.source_can_act_as_authority(p_source_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT tier IN (1, 2) FROM public.regulatory_sources WHERE id = p_source_id), false);
$$;

-- -----------------------------------------------------------------------------
-- 5. The downstream-state boundary trigger.
--
-- Governance constraint: "Tier 3 cannot be treated as direct authority in
-- downstream state." The concrete downstream state that exists TODAY is an
-- ENFORCED compliance_rule (status approved/active) that traces to a source via
-- its source_legal_update_id → legal_updates.source_id. This trigger refuses to
-- let such a rule reach an enforced status when its originating source is Tier 3
-- (or unclassified). A Tier-3 finding can still exist as a draft/suggested rule
-- and go through human review; it simply cannot be ENFORCED on a Tier-3 basis
-- alone. Re-point the rule's source_legal_update_id at a corroborating Tier 1/2
-- update, or leave the rule non-enforced.
--
-- This is intentionally minimal and fail-closed: it does not implement rule
-- lifecycle (that is a later phase); it only forbids the one state the
-- governance model says must never occur.
--
-- guard_rule_source_authority is TRIGGER-ONLY (invoked by the trigger below,
-- never called directly), so it carries no EXECUTE grant. ACL-exemption token
-- for the repository ACL assurance check:
--        acl-no-grant: guard_rule_source_authority
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_rule_source_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  origin_tier SMALLINT;
BEGIN
  -- Only enforced statuses are gated; drafts/suggestions/rejections are free to
  -- reference any tier (that is exactly the human-review path a signal feeds).
  IF NEW.status NOT IN ('approved', 'active') THEN
    RETURN NEW;
  END IF;

  -- A rule with no traced source is out of scope for THIS guard (its authority
  -- basis is established elsewhere — e.g. a manually authored rule). We only
  -- block the specific case of an enforced rule tracing to a Tier-3 source.
  IF NEW.source_legal_update_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.tier
  INTO origin_tier
  FROM public.legal_updates lu
  JOIN public.regulatory_sources s ON s.id = lu.source_id
  WHERE lu.id = NEW.source_legal_update_id;

  -- If the update has no linked source, or the source is Tier 1/2, allow it.
  IF origin_tier IS NULL OR origin_tier IN (1, 2) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'governance violation: compliance_rule % cannot be % because it traces to a Tier % '
    '(intelligence-signal) source. A Tier 3 source may raise an item for human review but '
    'must not be the direct authority for an enforced rule. Corroborate against a Tier 1/2 '
    'source (re-point source_legal_update_id) or keep the rule non-enforced.',
    NEW.rule_code, NEW.status, origin_tier;
END;
$$;

DROP TRIGGER IF EXISTS compliance_rules_tier3_authority_guard ON public.compliance_rules;
CREATE TRIGGER compliance_rules_tier3_authority_guard
  BEFORE INSERT OR UPDATE OF status, source_legal_update_id ON public.compliance_rules
  FOR EACH ROW EXECUTE FUNCTION public.guard_rule_source_authority();

-- Trigger-only function: callable directly by nobody.
REVOKE EXECUTE ON FUNCTION public.guard_rule_source_authority() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_rule_source_authority() FROM anon;
REVOKE EXECUTE ON FUNCTION public.guard_rule_source_authority() FROM authenticated;

-- -----------------------------------------------------------------------------
-- 6. Indexes for tier/priority-ordered monitoring.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_regulatory_sources_tier_priority
  ON public.regulatory_sources (tier, priority)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_regulatory_sources_category
  ON public.regulatory_sources (category);

-- -----------------------------------------------------------------------------
-- 7. Grants for the helper functions (SELECT on the table is already governed
--    by migration-9 RLS; nothing changes there).
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.regulatory_source_tier(UUID)       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.source_can_act_as_authority(UUID)  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.regulatory_source_tier(UUID)       TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.source_can_act_as_authority(UUID)  TO authenticated, service_role;

COMMIT;
