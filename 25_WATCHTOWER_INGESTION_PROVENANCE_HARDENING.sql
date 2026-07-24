-- =============================================================================
-- Migration 25 — Compliance Watchtower ingestion provenance & dedup (Phase A)
--
-- Adds the provenance and ingestion-evidence layer underneath the existing
-- Watchtower tables created by 9_COMPLIANCE_WATCHTOWER_MVP.sql.
--
-- Scope of THIS file (public schema only):
--   1. legal_updates provenance columns (content hash, canonical URL, external
--      document id, source tier snapshot, retrieval run reference)
--   2. Table: watchtower_ingestion_runs   — one row per source-check execution
--   3. Table: watchtower_ingestion_items  — one row per entry seen in a run
--   4. Dedup indexes and integrity constraints
--   5. Append-only / no-delete integrity triggers
--   6. Grants + admin-only RLS
--
-- Explicitly NOT in this migration (later phases):
--   * AI triage, AI summaries, or any AI-derived column
--   * review decisions, rule lifecycle, impact analysis, alert propagation
--   * any change to an existing column's type, default, or nullability
--
-- Backward compatibility: every column added to legal_updates is NULLABLE with
-- no default, and every constraint added is NULL-tolerant. Existing rows stay
-- valid and every existing reader (SELECT *, complianceRepository.ts) is
-- unaffected. Nothing here changes the behaviour of a manually pasted update.
--
-- Fail-conservative posture (governance constraint 3): the run status CHECKs
-- below make it structurally impossible to record an unavailable source as a
-- successful, zero-change check. A run that did not complete cleanly must
-- carry a terminal status AND a failure_reason; 'succeeded' is only reachable
-- with zero failed items.
--
-- Verify:   25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql
-- Rollback: 25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql
--
-- Preconditions:
--   * public.is_ddp_admin()          (migration 3 / AUTH_RLS_SCHEMA)
--   * public.regulatory_sources      (migration 9)
--   * public.legal_updates           (migration 9)
--   * pgcrypto (gen_random_uuid)     (migration 9)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions — fail loudly and atomically before creating anything.
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
    missing := missing || 'public.regulatory_sources';
  END IF;

  IF to_regclass('public.legal_updates') IS NULL THEN
    missing := missing || 'public.legal_updates';
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 25 precondition failed: missing required object(s): %. '
      'Apply AUTH_RLS_SCHEMA.sql and 9_COMPLIANCE_WATCHTOWER_MVP.sql before migration 25.',
      array_to_string(missing, ', ');
  END IF;
END
$precondition$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Ingestion runs — one row per source-check execution.
--
-- Provenance survives source deletion: source_id is ON DELETE SET NULL, but the
-- *_snapshot columns record what the source looked like at retrieval time, so a
-- run remains reproducible/auditable even if the registry row is later removed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watchtower_ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  source_id UUID REFERENCES public.regulatory_sources(id) ON DELETE SET NULL,
  source_name_snapshot TEXT NOT NULL DEFAULT '',
  source_url_snapshot  TEXT NOT NULL DEFAULT '',
  -- Tier as it was at retrieval time. Nullable because migration 26 introduces
  -- the tier column on regulatory_sources; runs recorded before then have none.
  source_tier_snapshot SMALLINT
    CHECK (source_tier_snapshot IS NULL OR source_tier_snapshot IN (1, 2, 3)),

  connector_kind TEXT NOT NULL
    CHECK (connector_kind IN ('rss', 'atom', 'html', 'pdf', 'government_api', 'manual', 'unsupported')),

  trigger_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger_type IN ('scheduled', 'manual', 'backfill')),
  -- Same actor vocabulary as compliance_audit_log.actor_type, minus the AI
  -- values: no AI participates in ingestion in this phase.
  actor_type TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_type IN ('admin', 'system', 'scheduler')),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  -- Closed vocabulary. Mirrors the connector error codes already defined in
  -- src/lib/complianceRssConnector.ts, plus the orchestration-level reasons.
  failure_reason TEXT
    CHECK (failure_reason IS NULL OR failure_reason IN (
      'source_unavailable',
      'not_https',
      'off_allowlist',
      'url_unsafe',
      'unsupported_connector',
      'timeout',
      'oversized_response',
      'invalid_content_type',
      'redirect_blocked',
      'fetch_failed',
      'malformed_feed',
      'not_a_feed',
      'source_policy_denied',
      'source_disabled',
      'governance_rejected',
      'persistence_failed',
      'partial_item_failure',
      'internal_error'
    )),
  -- Bounded diagnostic text. Never a stack trace, never a credential — the
  -- application is responsible for passing a sanitized, truncated message.
  error_detail TEXT CHECK (error_detail IS NULL OR length(error_detail) <= 2000),

  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,

  items_seen      INTEGER NOT NULL DEFAULT 0 CHECK (items_seen >= 0),
  items_new       INTEGER NOT NULL DEFAULT 0 CHECK (items_new >= 0),
  items_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (items_duplicate >= 0),
  items_unchanged INTEGER NOT NULL DEFAULT 0 CHECK (items_unchanged >= 0),
  items_failed    INTEGER NOT NULL DEFAULT 0 CHECK (items_failed >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Fail-conservative status algebra ───────────────────────────────────────
  -- An in-flight run has no completion timestamp and cannot claim a reason.
  CONSTRAINT watchtower_ingestion_runs_running_shape CHECK (
    status <> 'running' OR (finished_at IS NULL AND failure_reason IS NULL)
  ),
  -- A clean run must be complete and must NOT carry a failure reason.
  CONSTRAINT watchtower_ingestion_runs_succeeded_shape CHECK (
    status <> 'succeeded' OR (finished_at IS NOT NULL AND failure_reason IS NULL AND items_failed = 0)
  ),
  -- Every non-clean terminal state must be complete AND must name a reason.
  -- This is what makes "source unavailable" impossible to record as silence.
  CONSTRAINT watchtower_ingestion_runs_terminal_reason CHECK (
    status NOT IN ('partial', 'failed', 'skipped')
    OR (finished_at IS NOT NULL AND failure_reason IS NOT NULL)
  ),
  -- 'partial' means some items failed; if none failed it is not partial.
  CONSTRAINT watchtower_ingestion_runs_partial_shape CHECK (
    status <> 'partial' OR items_failed > 0
  ),
  CONSTRAINT watchtower_ingestion_runs_finished_after_started CHECK (
    finished_at IS NULL OR finished_at >= started_at
  ),
  -- The per-outcome counts must account for every item seen.
  CONSTRAINT watchtower_ingestion_runs_counts_balance CHECK (
    items_seen = items_new + items_duplicate + items_unchanged + items_failed
  )
);

COMMENT ON TABLE public.watchtower_ingestion_runs IS
  'Admin-only evidence of each regulatory source-check execution. Append-oriented: '
  'rows may be updated to record completion but never deleted. A failed or '
  'unavailable source is recorded as an explicit failed/partial/skipped run with a '
  'reason - never as a successful run with zero changes.';

-- -----------------------------------------------------------------------------
-- 2. Ingestion items — one row per entry observed within a run.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watchtower_ingestion_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  run_id UUID NOT NULL REFERENCES public.watchtower_ingestion_runs(id) ON DELETE CASCADE,
  source_id UUID REFERENCES public.regulatory_sources(id) ON DELETE SET NULL,

  -- Stable per-item identity within a source, as produced by
  -- feedItemSourceId() in src/lib/complianceRssConnector.ts.
  item_key TEXT NOT NULL CHECK (length(item_key) > 0 AND length(item_key) <= 512),

  -- Normalized metadata. Bounded lengths: strict schema assumptions, and a
  -- hostile or malformed feed cannot write an unbounded value.
  external_document_id TEXT CHECK (external_document_id IS NULL OR length(external_document_id) <= 512),
  canonical_url        TEXT CHECK (canonical_url IS NULL OR length(canonical_url) <= 2048),
  title                TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 1024),
  published_at         TIMESTAMPTZ,

  -- SHA-256 hex of the NORMALIZED content, produced by
  -- computeSourceChecksum() in src/lib/complianceSourceMonitoring.ts.
  content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  normalized_length INTEGER CHECK (normalized_length IS NULL OR normalized_length >= 0),

  dedup_decision TEXT NOT NULL
    CHECK (dedup_decision IN (
      'new',
      'unchanged',
      'duplicate_content_hash',
      'duplicate_external_id',
      'duplicate_canonical_url',
      'invalid',
      'error'
    )),
  -- The already-known record this entry collided with, when the collision was
  -- against a persisted legal_update (as opposed to another item in this run).
  dedup_matched_legal_update_id UUID REFERENCES public.legal_updates(id) ON DELETE SET NULL,
  -- The candidate legal_update this entry created. Only a 'new' decision may
  -- have created one.
  legal_update_id UUID REFERENCES public.legal_updates(id) ON DELETE SET NULL,

  failure_reason TEXT
    CHECK (failure_reason IS NULL OR failure_reason IN (
      'empty_content',
      'invalid_metadata',
      'oversized_item',
      'hash_failed',
      'persistence_failed',
      'governance_rejected',
      'internal_error'
    )),
  error_detail TEXT CHECK (error_detail IS NULL OR length(error_detail) <= 2000),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Only a 'new' decision may point at a created legal_update.
  CONSTRAINT watchtower_ingestion_items_created_only_when_new CHECK (
    legal_update_id IS NULL OR dedup_decision = 'new'
  ),
  -- Any decision that claims to have compared content must carry the hash it
  -- compared. Without this a 'duplicate' claim would be unreproducible.
  CONSTRAINT watchtower_ingestion_items_hash_required CHECK (
    dedup_decision IN ('invalid', 'error') OR content_hash IS NOT NULL
  ),
  -- A non-outcome must say why. Never silently drop an error.
  CONSTRAINT watchtower_ingestion_items_failure_reason_required CHECK (
    dedup_decision NOT IN ('invalid', 'error') OR failure_reason IS NOT NULL
  ),
  -- One row per entry per run: a run cannot double-count the same entry.
  CONSTRAINT watchtower_ingestion_items_unique_per_run UNIQUE (run_id, item_key)
);

COMMENT ON TABLE public.watchtower_ingestion_items IS
  'Admin-only per-entry outcome of an ingestion run: normalized metadata, checksum, '
  'dedup decision, and the candidate legal_update created (if any). Append-only.';

-- -----------------------------------------------------------------------------
-- 3. legal_updates provenance columns.
--
-- All NULLABLE with no default: existing rows and manual pastes are untouched.
-- -----------------------------------------------------------------------------
ALTER TABLE public.legal_updates
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS canonical_url TEXT,
  ADD COLUMN IF NOT EXISTS external_document_id TEXT,
  ADD COLUMN IF NOT EXISTS source_tier SMALLINT,
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID,
  ADD COLUMN IF NOT EXISTS ingestion_item_key TEXT;

DO $legal_update_provenance$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_updates_content_hash_format') THEN
    ALTER TABLE public.legal_updates
      ADD CONSTRAINT legal_updates_content_hash_format
      CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_updates_canonical_url_bounded') THEN
    ALTER TABLE public.legal_updates
      ADD CONSTRAINT legal_updates_canonical_url_bounded
      CHECK (canonical_url IS NULL OR length(canonical_url) <= 2048);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_updates_external_document_id_bounded') THEN
    ALTER TABLE public.legal_updates
      ADD CONSTRAINT legal_updates_external_document_id_bounded
      CHECK (external_document_id IS NULL OR length(external_document_id) <= 512);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_updates_source_tier_range') THEN
    ALTER TABLE public.legal_updates
      ADD CONSTRAINT legal_updates_source_tier_range
      CHECK (source_tier IS NULL OR source_tier IN (1, 2, 3));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_updates_ingestion_run_id_fkey') THEN
    ALTER TABLE public.legal_updates
      ADD CONSTRAINT legal_updates_ingestion_run_id_fkey
      FOREIGN KEY (ingestion_run_id)
      REFERENCES public.watchtower_ingestion_runs(id)
      ON DELETE SET NULL;
  END IF;
END
$legal_update_provenance$;

COMMENT ON COLUMN public.legal_updates.content_hash IS
  'SHA-256 hex of the normalized retrieved content. NULL for manually pasted updates.';
COMMENT ON COLUMN public.legal_updates.source_tier IS
  'Authority tier of the source AT INGESTION TIME (1 primary / 2 secondary / 3 signal). '
  'A provenance snapshot, deliberately not a live join - re-tiering a source must not '
  'retroactively re-characterise records already created under the old tier.';
COMMENT ON COLUMN public.legal_updates.ingestion_run_id IS
  'The watchtower_ingestion_runs row that produced this record. NULL for manual entry.';

-- -----------------------------------------------------------------------------
-- 4. Dedup indexes.
--
-- All are PARTIAL (WHERE ... IS NOT NULL) so they constrain machine-ingested
-- records only and leave manually pasted updates - which carry no provenance -
-- completely unaffected. This is what keeps the migration backward compatible.
-- -----------------------------------------------------------------------------

-- Global content dedup: the same notice mirrored on two pages, or re-served by
-- the same feed, can only ever become ONE legal_update. This is the primary
-- dedup guarantee; the application also checks in advance, but the index is the
-- authority (a concurrent run must lose here, not double-insert).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_legal_updates_content_hash
  ON public.legal_updates (content_hash)
  WHERE content_hash IS NOT NULL;

-- Publisher-assigned identity dedup, scoped per source: two sources may legally
-- use the same document numbering, so the pair - not the id alone - is unique.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_legal_updates_source_external_document_id
  ON public.legal_updates (source_id, external_document_id)
  WHERE source_id IS NOT NULL AND external_document_id IS NOT NULL;

-- Deliberately NON-unique: a canonical URL is expected to be seen repeatedly as
-- its content changes over time, and each genuine change is a new record.
-- Uniqueness on the URL alone would suppress exactly the changes we monitor for.
CREATE INDEX IF NOT EXISTS idx_legal_updates_canonical_url
  ON public.legal_updates (canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_legal_updates_source_detected_at
  ON public.legal_updates (source_id, detected_at DESC)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_legal_updates_ingestion_run_id
  ON public.legal_updates (ingestion_run_id)
  WHERE ingestion_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_watchtower_ingestion_runs_source_started
  ON public.watchtower_ingestion_runs (source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchtower_ingestion_runs_status
  ON public.watchtower_ingestion_runs (status, started_at DESC);

-- Supports "is anything still marked running?" stuck-run detection.
CREATE INDEX IF NOT EXISTS idx_watchtower_ingestion_runs_in_flight
  ON public.watchtower_ingestion_runs (started_at DESC)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_watchtower_ingestion_items_run
  ON public.watchtower_ingestion_items (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchtower_ingestion_items_content_hash
  ON public.watchtower_ingestion_items (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_watchtower_ingestion_items_decision
  ON public.watchtower_ingestion_items (dedup_decision, created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. Integrity triggers.
--
-- The three functions below are TRIGGER-ONLY: they are invoked by the triggers
-- attached to them and are never called directly, so they carry no EXECUTE
-- grant. Explicit ACL-exemption tokens for the repository ACL assurance check:
--        acl-no-grant: prevent_watchtower_ingestion_item_mutation
--        acl-no-grant: guard_watchtower_ingestion_run_update
--        acl-no-grant: guard_watchtower_ingestion_item_insert
-- -----------------------------------------------------------------------------

-- 5a. Items are evidence: insert once, never rewrite, never remove.
CREATE OR REPLACE FUNCTION public.prevent_watchtower_ingestion_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'watchtower_ingestion_items is append-only; attempted % is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS watchtower_ingestion_items_no_update_delete ON public.watchtower_ingestion_items;
CREATE TRIGGER watchtower_ingestion_items_no_update_delete
  BEFORE UPDATE OR DELETE ON public.watchtower_ingestion_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_watchtower_ingestion_item_mutation();

-- 5b. Runs may be updated exactly once, to record completion. Identity and
--     start facts are immutable, and a terminal run can never be reopened or
--     re-characterised - otherwise a failed check could later be rewritten as a
--     successful one and the audit trail would be worthless.
CREATE OR REPLACE FUNCTION public.guard_watchtower_ingestion_run_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'watchtower_ingestion_runs rows are retained evidence; DELETE is not allowed';
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.source_id  IS DISTINCT FROM OLD.source_id
     OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type THEN
    RAISE EXCEPTION 'watchtower_ingestion_runs: id, source_id, trigger_type, started_at and created_at are immutable';
  END IF;

  IF OLD.status <> 'running' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'watchtower_ingestion_runs: run % is already terminal (%); its status cannot be changed to %',
      OLD.id, OLD.status, NEW.status;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS watchtower_ingestion_runs_update_guard ON public.watchtower_ingestion_runs;
CREATE TRIGGER watchtower_ingestion_runs_update_guard
  BEFORE UPDATE OR DELETE ON public.watchtower_ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_watchtower_ingestion_run_update();

-- 5c. An item may only be attributed to a run that is still in flight. This
--     stops a completed run's evidence set from being extended after the fact.
CREATE OR REPLACE FUNCTION public.guard_watchtower_ingestion_item_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run_status TEXT;
BEGIN
  SELECT status INTO run_status
  FROM public.watchtower_ingestion_runs
  WHERE id = NEW.run_id;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'watchtower_ingestion_items: run % does not exist', NEW.run_id;
  END IF;

  IF run_status <> 'running' THEN
    RAISE EXCEPTION
      'watchtower_ingestion_items: run % is already terminal (%); no further items may be recorded',
      NEW.run_id, run_status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS watchtower_ingestion_items_run_open_guard ON public.watchtower_ingestion_items;
CREATE TRIGGER watchtower_ingestion_items_run_open_guard
  BEFORE INSERT ON public.watchtower_ingestion_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_watchtower_ingestion_item_insert();

-- 5d. Trigger-only functions must be callable directly by NOBODY. They fire from
--     their triggers with the table owner's rights; no role needs EXECUTE. Same
--     posture as prevent_compliance_audit_log_mutation (migration 12).
REVOKE EXECUTE ON FUNCTION public.prevent_watchtower_ingestion_item_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_watchtower_ingestion_item_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_watchtower_ingestion_item_mutation() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_watchtower_ingestion_run_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_watchtower_ingestion_run_update() FROM anon;
REVOKE EXECUTE ON FUNCTION public.guard_watchtower_ingestion_run_update() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_watchtower_ingestion_item_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_watchtower_ingestion_item_insert() FROM anon;
REVOKE EXECUTE ON FUNCTION public.guard_watchtower_ingestion_item_insert() FROM authenticated;

-- -----------------------------------------------------------------------------
-- 6. Grants.
--
-- Deny-by-default, then re-grant the minimum the admin browser client needs.
-- RLS below (is_ddp_admin()) remains the real authorization boundary; these
-- grants only bound what RLS could ever permit. DELETE and TRUNCATE are granted
-- to nobody - including service_role - so ingestion evidence cannot be erased
-- through the API at all.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.watchtower_ingestion_runs  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.watchtower_ingestion_items FROM PUBLIC, anon, authenticated;

REVOKE DELETE, TRUNCATE ON public.watchtower_ingestion_runs  FROM service_role;
REVOKE DELETE, TRUNCATE ON public.watchtower_ingestion_items FROM service_role;

-- The runner opens a run, records items, then closes the run: SELECT + INSERT
-- on both tables, plus UPDATE on runs only (guarded by the trigger above).
GRANT SELECT, INSERT, UPDATE ON public.watchtower_ingestion_runs  TO authenticated;
GRANT SELECT, INSERT         ON public.watchtower_ingestion_items TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. RLS — admin-only, matching the existing Watchtower posture (migration 9).
-- -----------------------------------------------------------------------------
ALTER TABLE public.watchtower_ingestion_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchtower_ingestion_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "watchtower_ingestion_runs: admin select" ON public.watchtower_ingestion_runs;
CREATE POLICY "watchtower_ingestion_runs: admin select" ON public.watchtower_ingestion_runs
  FOR SELECT USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "watchtower_ingestion_runs: admin insert" ON public.watchtower_ingestion_runs;
CREATE POLICY "watchtower_ingestion_runs: admin insert" ON public.watchtower_ingestion_runs
  FOR INSERT WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "watchtower_ingestion_runs: admin update" ON public.watchtower_ingestion_runs;
CREATE POLICY "watchtower_ingestion_runs: admin update" ON public.watchtower_ingestion_runs
  FOR UPDATE USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "watchtower_ingestion_items: admin select" ON public.watchtower_ingestion_items;
CREATE POLICY "watchtower_ingestion_items: admin select" ON public.watchtower_ingestion_items
  FOR SELECT USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "watchtower_ingestion_items: admin insert" ON public.watchtower_ingestion_items;
CREATE POLICY "watchtower_ingestion_items: admin insert" ON public.watchtower_ingestion_items
  FOR INSERT WITH CHECK (public.is_ddp_admin());

-- No DELETE policy on either table, and no UPDATE policy on items: the absence
-- of a policy is itself the denial, on top of the trigger and the grant.

COMMIT;
