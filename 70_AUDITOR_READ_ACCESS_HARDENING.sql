-- ============================================================================
-- 70 — THE READ-ONLY AUDITING ROLE MAY READ THE EVIDENCE CHAIN.
-- ============================================================================
--
-- WHAT WAS OPEN. The point of a read-only auditing role is that verification
-- does not depend on the person who performed the act. Measured against
-- production on 2026-08-12, that property held for the LEDGER — the list of
-- what was applied — and stopped dead at the EVIDENCE. Who opened a farmer's
-- document, who approved or rejected it, who deleted it, how an entity's status
-- changed, what the compliance log recorded: every one of those was readable
-- only by the admins whose conduct they record.
--
--     psql "$PROD_RO_DATABASE_URL" -c "select count(*) from public.farmer_document_opens;"
--     ERROR:  permission denied for function is_ddp_admin
--
-- THE READ WAS REFUSED OUTRIGHT, NOT FILTERED TO ZERO. That distinction is why
-- this was found at all: a filtered read returns 0 and looks like "nothing
-- here".
--
-- WHY A GRANT WAS NOT ENOUGH. `has_table_privilege('ddp_ro', …, 'SELECT')` was
-- already true on every table below. The grant was never the problem. The only
-- SELECT policy on each table was `USING (is_ddp_admin())` applied to PUBLIC —
-- so it applied to ddp_ro — and ddp_ro held no EXECUTE on that function. A
-- grant on the table plus a policy calling a function the role may not execute
-- is a key to a door whose lock it may not touch.
--
-- WHY THIS DOES NOT SIMPLY GRANT EXECUTE ON is_ddp_admin(). That was measured
-- and rejected. It makes the policy evaluate, it returns false, and the role
-- reads zero rows: refusal becomes silent filtering, which is strictly worse.
-- It would also have flipped roughly twenty-six OTHER tables — every table
-- gated by is_ddp_admin() or has_operational_farmer_access() that this
-- migration does NOT cover — from loudly refused to silently empty, hiding the
-- remaining work behind a plausible zero.
--
-- WHY THIS DOES NOT AMEND THE PREDICATES EITHER. Also measured, on PostgreSQL
-- 17.10. PostgreSQL checks EXECUTE permission on every function referenced by
-- every APPLICABLE policy when the statement is planned — not lazily as the
-- expression is evaluated. So neither of these reads a single row as ddp_ro:
--
--     USING (current_user = 'ddp_ro' OR public.is_ddp_admin())   -- still ERROR
--     USING (public.is_ddp_admin() OR current_user = 'ddp_ro')   -- still ERROR
--
-- Adding a second, permissive, auditor-only policy alongside the admin one
-- fails for the same reason: the admin policy still applies to ddp_ro, so its
-- function is still planned, so the statement still errors. OR does not save
-- you here; short-circuit evaluation never happens because the failure is a
-- permission check at plan time, not an evaluation at run time.
--
-- WHAT ACTUALLY WORKS, and what this migration therefore does. A policy that
-- does not APPLY to a role is never planned for that role, and its functions
-- are never permission-checked. So for each table below:
--
--   1. the existing admin/farmer policies are re-scoped from PUBLIC to
--      `TO authenticated`, with their predicates reproduced VERBATIM; and
--   2. one new permissive SELECT policy admits the auditing roles by name.
--
-- Re-scoping is not a workaround — it is what these policies always meant.
-- `is_ddp_admin()` and `has_operational_farmer_access()` both resolve
-- `auth.uid()`, which is a JWT-derived value that only exists for a logged-in
-- application user. Applied to PUBLIC they were over-broad: they claimed to
-- govern roles for which they could never return anything but false or an
-- error.
--
-- WHO THIS CHANGES BEHAVIOUR FOR — measured on production, not assumed:
--
--   authenticated              unchanged; every predicate is reproduced verbatim
--   service_role               BYPASSRLS — policies never applied to it
--   postgres, supabase_admin,
--   supabase_read_only_user,
--   supabase_etl_admin         BYPASSRLS or superuser — unaffected
--   anon                       holds SELECT on status_history and
--                              compliance_audit_log, held no EXECUTE on
--                              is_ddp_admin(), and so was ALREADY refused on
--                              both. It now reads zero rows instead of erroring.
--                              It matches no permissive policy, so zero is the
--                              correct and only outcome; nothing is exposed.
--   authenticator,
--   dashboard_user             hold no SELECT grant on any of these five tables
--   ddp_ro, ddp_audit_reader   the point of this migration
--
-- THE RESIDUAL LOOSENING, STATED PLAINLY. `status_history` carries a
-- RESTRICTIVE policy, and a RESTRICTIVE policy NARROWS access — it is ANDed
-- with the permissive ones and grants nothing by itself. Re-scoping it to
-- `authenticated` means it no longer restricts non-authenticated roles at all.
-- No role that exists on production today gains anything by that: every other
-- role either bypasses RLS, holds no grant, or matches no permissive policy.
-- But a FUTURE non-authenticated role with a SELECT grant would escape this
-- restriction where it would previously have been caught. The alternative —
-- keeping it on PUBLIC and widening its predicate — is strictly worse, because
-- it forces the EXECUTE grants whose silent-filtering regression is described
-- above. This is a deliberate trade and the owner may reverse it.
--
-- TWO AUDITING ROLES, NOT ONE. The task named `ddp_ro`. Production also has
-- `ddp_audit_reader`: SELECT on 53 of 53 public tables, no RLS bypass, member
-- of nothing, and suffering the identical defect. It is included here
-- deliberately. If the owner wants only `ddp_ro`, strike the second name from
-- the five auditor policies below — nothing else changes.
--
-- WHY A PLAIN TEXT COMPARISON RATHER THAN `TO ddp_ro`. `CREATE POLICY … TO
-- ddp_ro` fails outright on any cluster where the role does not exist, which
-- includes every disposable-PostgreSQL test cluster. Wrapping it in a
-- role-existence check makes it skip silently and lets the VERIFY pass while
-- asserting nothing. `current_user = 'ddp_ro'` needs no role lookup, so it is
-- created and tested identically everywhere.
--
-- IS THAT STRING COMPARISON SAFE? Checked on production rather than assumed.
-- `current_user` becomes one of these names only by (a) authenticating as the
-- role, which needs its credential, or (b) a SECURITY DEFINER function OWNED by
-- it, or (c) SET ROLE by a member. Measured: both roles own zero objects and
-- zero SECURITY DEFINER functions, and the only member of either is `postgres`,
-- which is already BYPASSRLS and can read everything regardless. The standing
-- condition is therefore: NEITHER AUDITING ROLE MAY EVER OWN A SECURITY DEFINER
-- FUNCTION. Section F of the VERIFY asserts exactly that, so it cannot lapse
-- quietly.
--
-- WHAT THIS DOES NOT COVER. Thirty of the fifty-three public tables remain
-- unreadable by the auditing roles. That is deliberate scope, not an oversight:
-- the tables below record CONDUCT — what an administrator did — whereas the
-- rest hold SUBJECT data (farms, profiles, documents, batches, photos).
-- Widening a read-only credential's reach over farmer and buyer data is the
-- owner's decision, not this migration's. The measured list is in the handover.
--
-- Companion files: 70_AUDITOR_READ_ACCESS_ROLLBACK.sql and
-- 70_AUDITOR_READ_ACCESS_VERIFY.sql, whose sections B, C and D are behavioural:
-- they become each role and read, rather than confirming a policy exists.
-- ============================================================================

BEGIN;

-- ── A precondition worth failing loudly on ──────────────────────────────────
--
-- Every table below must already exist. If one does not, this migration is
-- being applied to a database whose evidence chain was never built, and
-- silently policy-ing four of five tables would be worse than stopping.
DO $preconditions$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO missing
    FROM unnest(ARRAY['farmer_document_opens', 'farmer_document_reviews',
                      'farmer_document_deletions', 'status_history',
                      'compliance_audit_log']) AS t
   WHERE to_regclass('public.' || t) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Apply the migrations that build the evidence chain (65, 68, 69) before this one. Missing: %',
      missing
      USING ERRCODE = 'check_violation';
  END IF;
END
$preconditions$;

-- ── farmer_document_opens — who was handed the bytes ────────────────────────
--
-- Created by migration 68. Its policy is FOR ALL, so it is planned for SELECT
-- too; re-scoping it is what stops is_ddp_admin() being permission-checked for
-- the auditing roles. The predicate is 68's, reproduced character for character
-- — this migration changes WHO the policy applies to and nothing else.
DROP POLICY IF EXISTS "farmer_document_opens: admin all" ON public.farmer_document_opens;
CREATE POLICY "farmer_document_opens: admin all"
  ON public.farmer_document_opens
  FOR ALL
  TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer_document_opens: auditor read" ON public.farmer_document_opens;
CREATE POLICY "farmer_document_opens: auditor read"
  ON public.farmer_document_opens
  FOR SELECT
  TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

-- ── farmer_document_reviews — who approved or rejected it ───────────────────
--
-- Created by migration 65. SELECT-only policy; there is no INSERT policy and no
-- role holds INSERT, because rows are written by trigger. Re-scoping the read
-- does not change that.
DROP POLICY IF EXISTS "farmer_document_reviews: admin read" ON public.farmer_document_reviews;
CREATE POLICY "farmer_document_reviews: admin read"
  ON public.farmer_document_reviews
  FOR SELECT
  TO authenticated
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer_document_reviews: auditor read" ON public.farmer_document_reviews;
CREATE POLICY "farmer_document_reviews: auditor read"
  ON public.farmer_document_reviews
  FOR SELECT
  TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

-- ── farmer_document_deletions — who removed it, and why ─────────────────────
--
-- Created by migration 69, whose own header says the auditing role must be able
-- to see what was removed because that is the entire purpose of keeping the
-- record. 69 granted SELECT to ddp_ro and stopped one step short: the grant was
-- there, the policy still refused. This finishes it.
--
-- Stated openly, because this corpus has been burned by a migration quietly
-- re-creating another one's object under the guise of its own work: the policy
-- below BELONGS TO 69. 70 re-scopes it, reproduces its predicate verbatim, and
-- the ROLLBACK restores it exactly as 69 left it.
DROP POLICY IF EXISTS "farmer_document_deletions: admin read" ON public.farmer_document_deletions;
CREATE POLICY "farmer_document_deletions: admin read"
  ON public.farmer_document_deletions
  FOR SELECT
  TO authenticated
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer_document_deletions: auditor read" ON public.farmer_document_deletions;
CREATE POLICY "farmer_document_deletions: auditor read"
  ON public.farmer_document_deletions
  FOR SELECT
  TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

-- ── compliance_audit_log — what the compliance machinery recorded ───────────
--
-- The INSERT policy is deliberately left alone. An INSERT policy is never
-- planned for a SELECT, so it cannot refuse the auditor's read, and touching it
-- would widen this migration for no gain.
DROP POLICY IF EXISTS "compliance_audit_log: admin select" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: admin select"
  ON public.compliance_audit_log
  FOR SELECT
  TO authenticated
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_audit_log: auditor read" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: auditor read"
  ON public.compliance_audit_log
  FOR SELECT
  TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

-- ── status_history — how an entity's status changed, and who changed it ─────
--
-- Three policies, all of which are planned for a SELECT by a PUBLIC role, so
-- all three must be re-scoped or the read still errors. The refusal measured on
-- production named has_operational_farmer_access — the RESTRICTIVE one — which
-- is the proof that a permissive addition alone could never have fixed this
-- table.
DROP POLICY IF EXISTS "status_history: admin all" ON public.status_history;
CREATE POLICY "status_history: admin all"
  ON public.status_history
  FOR ALL
  TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- Verbatim from the world migration 63 was applied to. A farmer sees their own
-- farm's history and their own batches' history, and nothing else. Reproduced
-- exactly; VERIFY section C proves it still behaves that way afterwards,
-- because a predicate this shape is precisely what a careless re-create mangles.
DROP POLICY IF EXISTS "status_history: farmer select own" ON public.status_history;
CREATE POLICY "status_history: farmer select own"
  ON public.status_history
  FOR SELECT
  TO authenticated
  USING (
    ((entity_type = 'farm') AND public.has_farm_membership(entity_id))
    OR ((entity_type = 'inventory_batch') AND (EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = status_history.entity_id
        AND ((ib.created_by = auth.uid()) OR public.has_farm_membership(ib.farm_id))
    )))
  );

-- RESTRICTIVE, from migration 22. It narrows; it grants nothing. Re-scoped to
-- authenticated for the reason set out in the header, which is the one
-- deliberate loosening in this migration.
DROP POLICY IF EXISTS "status_history: operational farmer or admin" ON public.status_history;
CREATE POLICY "status_history: operational farmer or admin"
  ON public.status_history
  AS RESTRICTIVE FOR ALL
  TO authenticated
  USING (public.has_operational_farmer_access() OR public.is_ddp_admin())
  WITH CHECK (public.has_operational_farmer_access() OR public.is_ddp_admin());

DROP POLICY IF EXISTS "status_history: auditor read" ON public.status_history;
CREATE POLICY "status_history: auditor read"
  ON public.status_history
  FOR SELECT
  TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

-- ── The grant, where the role exists ────────────────────────────────────────
--
-- SELECT was already held by both roles on all five tables in production — this
-- is belt and braces for any cluster where it is not, and a genuine no-op
-- there. It is guarded because the roles do not exist on a disposable test
-- cluster, and it is the ONLY guarded statement in this migration: nothing that
-- this migration's VERIFY asserts depends on it having run. The fixture creates
-- both roles in its pre-apply world precisely so that the behavioural sections
-- test the real thing rather than a branch that was skipped.
DO $grant$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ddp_ro', 'ddp_audit_reader'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['farmer_document_opens', 'farmer_document_reviews',
                               'farmer_document_deletions', 'status_history',
                               'compliance_audit_log'] LOOP
        EXECUTE format('GRANT SELECT ON public.%I TO %I', t, r);
      END LOOP;
    ELSE
      RAISE NOTICE 'Role % does not exist here; skipping its grant.', r;
    END IF;
  END LOOP;
END
$grant$;

-- ── This migration records itself, as its final act ─────────────────────────
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Apply 67 (the migrations ledger) before this migration.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.schema_migrations (number, name, applied_at, applied_by, evidence)
  VALUES (70, 'AUDITOR_READ_ACCESS', now(), current_user, 'self-recorded')
  ON CONFLICT (number) DO UPDATE
    SET applied_at = excluded.applied_at,
        applied_by = excluded.applied_by,
        evidence   = 'self-recorded'
    WHERE public.schema_migrations.evidence LIKE 'backfilled%';
END
$ledger$;

COMMIT;
