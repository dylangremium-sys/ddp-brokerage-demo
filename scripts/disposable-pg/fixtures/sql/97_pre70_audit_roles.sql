-- Pre-migration world for fixture 70.
--
-- Two things production has that the substrate does not, both of which must
-- exist BEFORE 70 is applied or the fixture tests a world that is not the one
-- the migration is for.
--
-- 1. THE AUDITING ROLES. `ddp_ro` and `ddp_audit_reader` exist on production
--    and on no disposable cluster. They are created HERE, in the pre-apply
--    world, and deliberately not by the migration and not by the VERIFY:
--
--      - not by the migration, because creating login roles on every cluster a
--        migration touches is not its business, and because the harness's
--        rollback-symmetry check compares the database against its pre-apply
--        shape — a role the migration created would have to be dropped again,
--        and a role it created conditionally would be worse still;
--      - not by the VERIFY, because a VERIFY that manufactures the conditions
--        it then asserts is the vacuous-green pattern this corpus keeps
--        re-learning. Section B has to become a role that was already there.
--
--    They are created NOLOGIN. Nothing here authenticates over a socket; every
--    behavioural section reaches them by SET ROLE, exactly as the owner will in
--    the Supabase SQL editor. Production's are LOGIN, which is the one
--    difference, and it is not one any policy can observe.
--
-- 2. compliance_audit_log's POLICIES AND GRANTS. The substrate creates that
--    table bare — no RLS, no policies, no grants — so without this stage the
--    table would be wide open, migration 70's re-scope would have nothing to
--    re-scope, and VERIFY sections A and C would assert against a straw man.
--    Reproduced EXACTLY as measured on production on 2026-08-12:
--
--      compliance_audit_log: admin select   PERMISSIVE  SELECT  TO public  is_ddp_admin()
--      compliance_audit_log: admin insert   PERMISSIVE  INSERT  TO public  is_ddp_admin()
--      anon=r  authenticated=ar  service_role=arwdDxtm  ddp_ro=r  ddp_audit_reader=r
--
--    The INSERT policy is included even though 70 leaves it alone, because its
--    presence is part of what section A's "nothing else is still on PUBLIC"
--    check has to tolerate: an INSERT policy is never planned for a SELECT, and
--    a fixture without it would not prove that.
--
-- The status_history policies come from 97_pre63_status_history.sql followed by
-- migration 63, which is the same route production took.

-- 3. farmer_documents.sha256_hex. Added by migration 28, which production has
--    and this fixture's chain does not. It is reproduced here rather than by
--    applying 28, because 28 is digest-dedup work that reaches tables outside
--    this chain and 70 has nothing to do with digests — but the column cannot
--    simply be left out. Migration 68's set_review_digest() trigger reads
--    `d.sha256_hex` by name on every INSERT into farmer_document_reviews, so
--    without it VERIFY section B cannot write the probe row it then reads:
--
--      ERROR:  column d.sha256_hex does not exist
--
--    Reproduced with production's exact type, measured 2026-08-12:
--    character(64), nullable.

-- ── 1. The auditing roles ───────────────────────────────────────────────────
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddp_ro') THEN
    CREATE ROLE ddp_ro NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddp_audit_reader') THEN
    CREATE ROLE ddp_audit_reader NOLOGIN;
  END IF;
END $roles$;

-- ── 1b. The digest column migration 28 adds on production ───────────────────
ALTER TABLE public.farmer_documents
  ADD COLUMN IF NOT EXISTS sha256_hex character(64);

-- ── 2. compliance_audit_log, as production has it ───────────────────────────
ALTER TABLE public.compliance_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "compliance_audit_log: admin select" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: admin select"
  ON public.compliance_audit_log
  FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_audit_log: admin insert" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: admin insert"
  ON public.compliance_audit_log
  FOR INSERT
  WITH CHECK (public.is_ddp_admin());

GRANT SELECT                 ON public.compliance_audit_log TO anon;
GRANT SELECT, INSERT         ON public.compliance_audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compliance_audit_log TO service_role;

-- ── 3. The SELECT grants the auditing roles already hold on production ──────
--
-- This is the measured pre-apply state and it is the whole reason the defect
-- was subtle: the grant was ALWAYS there. `has_table_privilege` returned true
-- on all five tables for both roles while every read was refused. Granting it
-- here means fixture 70 reproduces that trap rather than accidentally proving
-- that a grant fixes it.
GRANT SELECT ON public.farmer_document_opens     TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.farmer_document_reviews   TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.farmer_document_deletions TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.status_history            TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.compliance_audit_log      TO ddp_ro, ddp_audit_reader;
