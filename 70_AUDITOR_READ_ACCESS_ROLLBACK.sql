-- ============================================================================
-- 70 — ROLLBACK
-- ============================================================================
--
-- Removes exactly what 70 added and restores exactly what it re-scoped.
--
-- 70 CREATED NO TABLES AND NO FUNCTIONS. It changed the role scope of six
-- existing policies and added five new ones. So this file has two jobs:
--
--   1. drop the five auditor policies; and
--   2. restore the six re-scoped policies to `TO public`, predicates verbatim.
--
-- BOTH HALVES MATTER EQUALLY, and the second is the one that is easy to forget.
-- A rollback that dropped only the auditor policies would leave the admin
-- policies scoped to `authenticated` forever — a permanent, undocumented
-- change to the security model, sitting behind a migration everybody believes
-- was reversed. The disposable-PostgreSQL harness snapshots each policy's
-- `roles` alongside its `qual` and `with_check`, so a half-restore is caught
-- rather than shipped. It should be: this corpus has already shipped a VERIFY
-- that passed identically before and after its own rollback.
--
-- IT TOUCHES NO OTHER MIGRATION'S OBJECTS BEYOND PUTTING THEM BACK. The
-- policies restored below belong to migrations 22, 63, 65, 68, 69 and the
-- unnumbered compliance work. Every one is restored to the definition measured
-- on production on 2026-08-12, before 70 was written.
--
-- THE LEDGER ROW IS AMENDED, NOT DELETED. Migration 67 refuses DELETE on
-- public.schema_migrations by trigger, deliberately: a record of what was
-- applied is not improved by being erasable. A rolled-back migration was still
-- applied once, so the row stays and its evidence says what happened.
--
-- AFTER THIS FILE RUNS, 70's VERIFY MUST FAIL. That is the point of it, and it
-- is checked rather than hoped for — see the handover, which runs
-- apply → VERIFY green → rollback → VERIFY red.
-- ============================================================================

BEGIN;

-- ── The auditor policies come off ───────────────────────────────────────────
DROP POLICY IF EXISTS "farmer_document_opens: auditor read"     ON public.farmer_document_opens;
DROP POLICY IF EXISTS "farmer_document_reviews: auditor read"   ON public.farmer_document_reviews;
DROP POLICY IF EXISTS "farmer_document_deletions: auditor read" ON public.farmer_document_deletions;
DROP POLICY IF EXISTS "compliance_audit_log: auditor read"      ON public.compliance_audit_log;
DROP POLICY IF EXISTS "status_history: auditor read"            ON public.status_history;

-- ── The re-scoped policies go back to PUBLIC ────────────────────────────────
--
-- Restored to the exact definitions measured on production on 2026-08-12. Note
-- the absence of `TO authenticated` on every one: PUBLIC is the default, and
-- restoring it is the whole substance of this half of the rollback.

DROP POLICY IF EXISTS "farmer_document_opens: admin all" ON public.farmer_document_opens;
CREATE POLICY "farmer_document_opens: admin all"
  ON public.farmer_document_opens
  FOR ALL
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer_document_reviews: admin read" ON public.farmer_document_reviews;
CREATE POLICY "farmer_document_reviews: admin read"
  ON public.farmer_document_reviews
  FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer_document_deletions: admin read" ON public.farmer_document_deletions;
CREATE POLICY "farmer_document_deletions: admin read"
  ON public.farmer_document_deletions
  FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_audit_log: admin select" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: admin select"
  ON public.compliance_audit_log
  FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "status_history: admin all" ON public.status_history;
CREATE POLICY "status_history: admin all"
  ON public.status_history
  FOR ALL
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "status_history: farmer select own" ON public.status_history;
CREATE POLICY "status_history: farmer select own"
  ON public.status_history
  FOR SELECT
  USING (
    ((entity_type = 'farm') AND public.has_farm_membership(entity_id))
    OR ((entity_type = 'inventory_batch') AND (EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = status_history.entity_id
        AND ((ib.created_by = auth.uid()) OR public.has_farm_membership(ib.farm_id))
    )))
  );

DROP POLICY IF EXISTS "status_history: operational farmer or admin" ON public.status_history;
CREATE POLICY "status_history: operational farmer or admin"
  ON public.status_history
  AS RESTRICTIVE FOR ALL
  USING (public.has_operational_farmer_access() OR public.is_ddp_admin())
  WITH CHECK (public.has_operational_farmer_access() OR public.is_ddp_admin());

-- ── The SELECT grants are deliberately LEFT IN PLACE ────────────────────────
--
-- They predate 70 on production — `has_table_privilege` was already true for
-- both auditing roles on all five tables before this migration existed, which
-- is exactly why the defect was a policy defect and not a grant defect.
-- Revoking them here would remove something 70 did not add, and would leave the
-- database in a state the operator never rolled back TO.
--
-- On a cluster where 70's guarded grant genuinely was the first to grant SELECT
-- the grant survives this rollback. It confers nothing on its own: with the
-- auditor policies dropped and the admin policies back on PUBLIC, the read
-- returns to being refused. That is the pre-apply behaviour, which is what a
-- rollback owes.

-- ── The ledger keeps telling the truth about this database ──────────────────
UPDATE public.schema_migrations
   SET evidence = 'rolled back ' || to_char(now(), 'YYYY-MM-DD') || ' by ' || current_user
       || ' — was applied, then reversed by 70_AUDITOR_READ_ACCESS_ROLLBACK.sql'
 WHERE number = 70;

COMMIT;
