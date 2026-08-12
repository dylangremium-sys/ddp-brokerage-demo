-- ============================================================================
-- 71 — ROLLBACK
-- ============================================================================
--
-- 71 added seventeen policies and changed nothing else. It created no tables,
-- no functions, no triggers, and it did not touch a single pre-existing policy.
-- So this file drops seventeen policies, and that is the whole reversal.
--
-- IT IS DELIBERATELY SIMPLER THAN 70's ROLLBACK. 70 re-scoped seven live
-- policies and its rollback had to put every one of them back verbatim, which
-- was the half everyone would have forgotten. 71 has no such half, because 71
-- re-scoped nothing. That asymmetry between the two files is the point: it is
-- the visible consequence of 71 being additive, and if this file ever grows a
-- second section, something has gone wrong upstream of it.
--
-- THE SELECT GRANTS ARE LEFT IN PLACE, as in 70. Both auditing roles already
-- held SELECT on all seventeen tables in production before 71 existed — that is
-- precisely why the defect was silent rather than loud. Revoking them here
-- would remove something 71 did not add and leave the database in a state
-- nobody rolled back TO. With the policies dropped the grant confers nothing:
-- no permissive policy applies to the auditing roles, so the read returns zero
-- rows again, which is the pre-apply behaviour a rollback owes.
--
-- THAT RETURN TO ZERO IS ALSO WHY THIS ROLLBACK IS WORTH READING TWICE. The
-- pre-apply behaviour here is a silent, plausible, wrong answer. Rolling 71
-- back does not restore an error that someone would notice; it restores a lie.
-- Anyone reversing this migration should know that is what they are choosing.
--
-- THE LEDGER ROW IS AMENDED, NOT DELETED. Migration 67 refuses DELETE on
-- public.schema_migrations by trigger: a record of what was applied is not
-- improved by being erasable. A rolled-back migration was still applied once.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "commercial_audit_log: auditor read"           ON public.commercial_audit_log;
DROP POLICY IF EXISTS "destination_rulesets: auditor read"           ON public.destination_rulesets;
DROP POLICY IF EXISTS "export_eligibility_evaluations: auditor read" ON public.export_eligibility_evaluations;
DROP POLICY IF EXISTS "export_gate_overrides: auditor read"          ON public.export_gate_overrides;
DROP POLICY IF EXISTS "licences: auditor read"                       ON public.licences;
DROP POLICY IF EXISTS "organisation_memberships: auditor read"       ON public.organisation_memberships;
DROP POLICY IF EXISTS "organisations: auditor read"                  ON public.organisations;
DROP POLICY IF EXISTS "permit_drawdowns: auditor read"               ON public.permit_drawdowns;
DROP POLICY IF EXISTS "permits: auditor read"                        ON public.permits;
DROP POLICY IF EXISTS "procurement_decisions: auditor read"          ON public.procurement_decisions;
DROP POLICY IF EXISTS "public_intake_attempts: auditor read"         ON public.public_intake_attempts;
DROP POLICY IF EXISTS "requirement_overrides: auditor read"          ON public.requirement_overrides;
DROP POLICY IF EXISTS "reservation_releases: auditor read"           ON public.reservation_releases;
DROP POLICY IF EXISTS "reservations: auditor read"                   ON public.reservations;
DROP POLICY IF EXISTS "risk_overrides: auditor read"                 ON public.risk_overrides;
DROP POLICY IF EXISTS "screening_checks: auditor read"               ON public.screening_checks;
DROP POLICY IF EXISTS "security_settings: auditor read"              ON public.security_settings;

-- ── The ledger keeps telling the truth about this database ──────────────────
UPDATE public.schema_migrations
   SET evidence = 'rolled back ' || to_char(now(), 'YYYY-MM-DD') || ' by ' || current_user
       || ' — was applied, then reversed by 71_AUDITOR_READ_REMAINING_ROLLBACK.sql'
 WHERE number = 71;

COMMIT;
