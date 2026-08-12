-- ============================================================================
-- 71 — THE SEVENTEEN TABLES THAT TOLD THE AUDITOR "NOTHING HERE".
-- ============================================================================
--
-- WHAT WAS OPEN, and why it is worse than what migration 70 closed. 70 fixed
-- the tables where the auditing role was REFUSED — a loud, obvious error that
-- gets investigated. These seventeen never errored. They returned `0`.
--
-- A refused read gets investigated. A zero gets believed.
--
-- Measured against production on 2026-08-12, reading as `ddp_ro`, and
-- cross-checked against `pg_stat_user_tables.n_live_tup`:
--
--     public_intake_attempts    auditor reads 0    table holds 14
--     security_settings         auditor reads 0    table holds  1
--
-- Those two are lying today. The other fifteen are empty today and would lie
-- the moment anything landed in them — which is the worse property, because the
-- lie arrives silently and later, long after anyone was looking.
--
-- WHY THEY RETURN ZERO. Not the mechanism 70 dealt with. Every policy on these
-- tables is scoped `TO authenticated` (or `TO service_role`), and
-- `pg_has_role('ddp_ro','authenticated','member')` is FALSE. So no permissive
-- policy applies to the auditing roles at all, and PostgreSQL's default with
-- row level security enabled and no applicable policy is to return nothing.
-- Not an error. Nothing.
--
-- WHY THIS MIGRATION IS PURELY ADDITIVE, unlike 70. Measured on production
-- before writing a line of this:
--
--   - not one of the seventeen carries a RESTRICTIVE policy, so there is
--     nothing ANDed that could veto a new permissive one;
--   - not one carries a policy scoped `TO public`, so no function is planned
--     for the auditing roles and the plan-time EXECUTE trap that made 70
--     complicated cannot arise here;
--   - both auditing roles already hold SELECT on all seventeen — 17 of 17,
--     twice over. The grant was never the problem here either.
--
-- So 71 touches NO existing policy. It adds seventeen, and nothing else. That
-- is the whole migration. Anything a reader might fear it changes about the
-- application's own access, it does not: the policies that govern logged-in
-- users are not dropped, not re-created, not re-scoped, and not read.
--
-- WHAT THIS EXPOSES, stated rather than buried. This widens what a read-only
-- credential can see beyond conduct records into commercial and regulatory
-- records: counterparty organisations and their memberships, licences, permits
-- and drawdowns, reservations and releases, procurement decisions, export
-- eligibility evaluations and gate overrides, screening checks, requirement and
-- risk overrides, destination rulesets, the commercial audit log, the security
-- settings register, and the public intake attempt counters.
--
-- Checked before including them, rather than assumed: none of these tables
-- holds a secret or a raw personal identifier. `security_settings` is
-- (key, enabled, note, changed_by, changed_at) — feature toggles, not keys.
-- `public_intake_attempts` is (id, bucket_key, occurred_at) — rate-limit
-- counters, not contact details. `screening_checks` records results against
-- ORGANISATIONS, not named individuals. `organisation_memberships` holds user
-- ids, not names or emails. The roles remain read-only: they hold SELECT and
-- nothing else, which VERIFY section D checks rather than assumes.
--
-- The two auditing roles are the same pair migration 70 admitted — `ddp_ro`
-- and `ddp_audit_reader` — using the same predicate, for the same reasons, and
-- resting on the same standing condition: NEITHER ROLE MAY EVER OWN A SECURITY
-- DEFINER FUNCTION, or any caller of that function would inherit this read.
-- Section F asserts it, as 70's did, because 71 widens the reach of exactly
-- that comparison.
--
-- WHAT IS STILL NOT COVERED AFTER THIS. Thirty tables remain REFUSED to the
-- auditing roles — the subject-data tables (farms, profiles, documents,
-- batches, photos, scores) plus the farmer-facing evidence request chain.
-- Those hold farmer and buyer data rather than records of conduct, and
-- widening a read-only credential over them is an owner's decision that has
-- not been asked for. This migration does not make it.
--
-- Companion files: 71_AUDITOR_READ_REMAINING_ROLLBACK.sql and
-- 71_AUDITOR_READ_REMAINING_VERIFY.sql, whose section B is the one that
-- matters: on THESE tables the failure mode IS a zero, so a section that
-- merely counted rows would pass on an empty table while proving nothing. B
-- writes a row into each of the seventeen and requires the auditor to see it.
-- ============================================================================

BEGIN;

-- ── Fail loudly rather than policy sixteen of seventeen ─────────────────────
DO $preconditions$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO missing
    FROM unnest(ARRAY['commercial_audit_log', 'destination_rulesets',
                      'export_eligibility_evaluations', 'export_gate_overrides',
                      'licences', 'organisation_memberships', 'organisations',
                      'permit_drawdowns', 'permits', 'procurement_decisions',
                      'public_intake_attempts', 'requirement_overrides',
                      'reservation_releases', 'reservations', 'risk_overrides',
                      'screening_checks', 'security_settings']) AS t
   WHERE to_regclass('public.' || t) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'This database is missing tables 71 policies. Apply 17, 30, 36, 39-44 first. Missing: %',
      missing
      USING ERRCODE = 'check_violation';
  END IF;
END
$preconditions$;

-- ── The seventeen policies ──────────────────────────────────────────────────
--
-- One shape, seventeen times, deliberately written out rather than generated in
-- a loop: a policy is a security object, and a reader auditing this file should
-- be able to see every one of them without executing anything in their head.
--
-- `TO public` is required, not lazy. `TO ddp_ro` cannot be created on a cluster
-- where that role does not exist, which includes every disposable test cluster;
-- a plain text comparison needs no role lookup and so is created and tested
-- identically everywhere. It is the same predicate migration 70 uses.

DROP POLICY IF EXISTS "commercial_audit_log: auditor read" ON public.commercial_audit_log;
CREATE POLICY "commercial_audit_log: auditor read"
  ON public.commercial_audit_log FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "destination_rulesets: auditor read" ON public.destination_rulesets;
CREATE POLICY "destination_rulesets: auditor read"
  ON public.destination_rulesets FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "export_eligibility_evaluations: auditor read" ON public.export_eligibility_evaluations;
CREATE POLICY "export_eligibility_evaluations: auditor read"
  ON public.export_eligibility_evaluations FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "export_gate_overrides: auditor read" ON public.export_gate_overrides;
CREATE POLICY "export_gate_overrides: auditor read"
  ON public.export_gate_overrides FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "licences: auditor read" ON public.licences;
CREATE POLICY "licences: auditor read"
  ON public.licences FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "organisation_memberships: auditor read" ON public.organisation_memberships;
CREATE POLICY "organisation_memberships: auditor read"
  ON public.organisation_memberships FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "organisations: auditor read" ON public.organisations;
CREATE POLICY "organisations: auditor read"
  ON public.organisations FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "permit_drawdowns: auditor read" ON public.permit_drawdowns;
CREATE POLICY "permit_drawdowns: auditor read"
  ON public.permit_drawdowns FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "permits: auditor read" ON public.permits;
CREATE POLICY "permits: auditor read"
  ON public.permits FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "procurement_decisions: auditor read" ON public.procurement_decisions;
CREATE POLICY "procurement_decisions: auditor read"
  ON public.procurement_decisions FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "public_intake_attempts: auditor read" ON public.public_intake_attempts;
CREATE POLICY "public_intake_attempts: auditor read"
  ON public.public_intake_attempts FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "requirement_overrides: auditor read" ON public.requirement_overrides;
CREATE POLICY "requirement_overrides: auditor read"
  ON public.requirement_overrides FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "reservation_releases: auditor read" ON public.reservation_releases;
CREATE POLICY "reservation_releases: auditor read"
  ON public.reservation_releases FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "reservations: auditor read" ON public.reservations;
CREATE POLICY "reservations: auditor read"
  ON public.reservations FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "risk_overrides: auditor read" ON public.risk_overrides;
CREATE POLICY "risk_overrides: auditor read"
  ON public.risk_overrides FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "screening_checks: auditor read" ON public.screening_checks;
CREATE POLICY "screening_checks: auditor read"
  ON public.screening_checks FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

DROP POLICY IF EXISTS "security_settings: auditor read" ON public.security_settings;
CREATE POLICY "security_settings: auditor read"
  ON public.security_settings FOR SELECT TO public
  USING (current_user IN ('ddp_ro', 'ddp_audit_reader'));

-- ── The grant, where the role exists ────────────────────────────────────────
--
-- Both roles already hold SELECT on all seventeen in production — measured, not
-- hoped. This is belt and braces for any cluster where they do not, and a
-- genuine no-op there. It is the only guarded statement in this migration, and
-- nothing the VERIFY asserts depends on it having run: the fixture creates both
-- roles in its pre-apply world so the behavioural sections test the real thing
-- rather than a branch that was skipped.
DO $grant$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ddp_ro', 'ddp_audit_reader'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['commercial_audit_log', 'destination_rulesets',
                               'export_eligibility_evaluations', 'export_gate_overrides',
                               'licences', 'organisation_memberships', 'organisations',
                               'permit_drawdowns', 'permits', 'procurement_decisions',
                               'public_intake_attempts', 'requirement_overrides',
                               'reservation_releases', 'reservations', 'risk_overrides',
                               'screening_checks', 'security_settings'] LOOP
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
  VALUES (71, 'AUDITOR_READ_REMAINING', now(), current_user, 'self-recorded')
  ON CONFLICT (number) DO UPDATE
    SET applied_at = excluded.applied_at,
        applied_by = excluded.applied_by,
        evidence   = 'self-recorded'
    WHERE public.schema_migrations.evidence LIKE 'backfilled%';
END
$ledger$;

COMMIT;
