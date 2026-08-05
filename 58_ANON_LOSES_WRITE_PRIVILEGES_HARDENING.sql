-- =============================================================================
-- 58_ANON_LOSES_WRITE_PRIVILEGES_HARDENING.sql
--
-- Takes INSERT, UPDATE and DELETE away from `anon` on every public table, so
-- row-level security stops being the only thing between an anonymous caller and
-- the data.
--
-- WHAT IS WRONG TODAY
-- Measured read-only on production, 2026-08-05: `anon` holds DELETE, INSERT,
-- SELECT and UPDATE at the TABLE level on roughly twenty public tables —
-- inventory_batches, farms, farmer_documents, compliance_rules, documents,
-- ddp_scores and the rest.
--
-- Nothing gets through. That was measured too, on staging: every anon SELECT
-- returns 0 rows, every anon INSERT is refused, every anon DELETE affects 0 rows.
-- RLS is doing its job.
--
-- The problem is that RLS is doing it ALONE. Every one of those tables is one
-- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, or one over-broad policy, away
-- from handing an anonymous caller full write access to the commercial spine.
-- That is a single point of failure on a control that has to be re-argued every
-- time somebody adds a policy — which, going by this repository's history, is
-- often. Two locks are not twice as good as one; they are different in kind,
-- because the second one holds while the first is being changed.
--
-- Migration 14 already took TRUNCATE, TRIGGER, REFERENCES and MAINTAIN out of
-- the default privileges. It left the four that matter. This is that gap.
--
-- WHY SELECT IS DELIBERATELY LEFT ALONE
-- Revoking `anon`'s SELECT would change an anonymous read from "0 rows" to
-- "permission denied for table X". That is not obviously better: D17 in the
-- remediation plan is a live defect about exactly that error text leaking to
-- anonymous callers, and a table name is information a silent empty result does
-- not give away. RLS already returns nothing, so the read side gains no data
-- protection from the revoke — only a louder failure.
--
-- So the residual is stated rather than closed: after this migration, disabling
-- RLS on one of those tables would expose it to anonymous READS. It would no
-- longer expose it to anonymous WRITES, which is the difference between a
-- disclosure and a corruption.
--
-- WHAT THIS CANNOT BREAK, AND HOW THAT IS KNOWN
-- `anon` can execute NO function in the public schema at all — measured: zero
-- rows for `EXECUTE` granted to anon. So no RPC path depends on these
-- privileges. Public sign-up runs through Supabase Auth against `auth.users`,
-- not through a public table, and the intake endpoints under `api/` use the
-- service-role key server-side. There is no anonymous write path to break.
--
-- `authenticated` is untouched. Farmers create and update batches; that is the
-- role that does it.
--
--   • Rollback: 58_ANON_LOSES_WRITE_PRIVILEGES_ROLLBACK.sql
--   • Verify:   58_ANON_LOSES_WRITE_PRIVILEGES_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_anon_functions int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE EXCEPTION 'Migration 58 requires the `anon` role, which does not exist.';
  END IF;

  -- If anon has gained an executable function since this was written, an RPC
  -- path may now exist and the reasoning above no longer holds unexamined.
  SELECT count(*) INTO v_anon_functions
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE n.nspname = 'public' AND a.grantee = 'anon'::regrole AND a.privilege_type = 'EXECUTE';

  IF v_anon_functions > 0 THEN
    RAISE WARNING
      'Migration 58: anon can now EXECUTE % public function(s). This migration does not touch '
      'function privileges and a SECURITY DEFINER function bypasses table grants anyway, so this '
      'is not blocking — but the header claims there is no anonymous write path, and that claim '
      'should be re-checked.', v_anon_functions;
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Existing tables
--
-- SELECT is deliberately absent from this list. See the header.
-- -----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon;

-- -----------------------------------------------------------------------------
-- 2. Tables that do not exist yet
--
-- Without this the next `CREATE TABLE` re-opens the hole, and it re-opens
-- silently — a new table arrives with anon holding write privileges and nothing
-- reports it. `FOR ROLE postgres` matches migration 14: default privileges are
-- recorded per owning role, and postgres is what owns tables here.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
REVOKE INSERT, UPDATE, DELETE
ON TABLES
FROM anon;

COMMIT;
