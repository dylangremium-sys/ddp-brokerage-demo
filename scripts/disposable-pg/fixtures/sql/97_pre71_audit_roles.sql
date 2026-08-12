-- Pre-migration world for fixture 71.
--
-- THE AUDITING ROLES, and the SELECT grants they already hold on production.
--
-- Created here, in the pre-apply world, for the same reasons 97_pre70 does it:
-- not by the migration, because a migration that creates login roles on every
-- cluster it touches is doing something that is not its business and would have
-- to be undone by its own rollback; and not by the VERIFY, because a VERIFY
-- that manufactures the conditions it then asserts is the vacuous-green pattern
-- this corpus keeps re-learning.
--
-- NOLOGIN: nothing here authenticates over a socket. Every behavioural section
-- reaches these roles by SET ROLE, exactly as the owner will in the Supabase SQL
-- editor. Production's are LOGIN; no policy can observe the difference.
--
-- THE GRANTS ARE THE WHOLE TRAP, so they belong in the BEFORE world rather than
-- being something 71 supplies. Measured on production on 2026-08-12:
-- `has_table_privilege` was already true for BOTH roles on ALL SEVENTEEN of
-- these tables, and every read still returned `0`. A fixture that withheld the
-- grants would let 71 appear to work by granting them, which is the one
-- explanation the production measurement rules out.

DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddp_ro') THEN
    CREATE ROLE ddp_ro NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddp_audit_reader') THEN
    CREATE ROLE ddp_audit_reader NOLOGIN;
  END IF;
END $roles$;

GRANT SELECT ON public.commercial_audit_log           TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.destination_rulesets           TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.export_eligibility_evaluations TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.export_gate_overrides          TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.licences                       TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.organisation_memberships       TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.organisations                  TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.permit_drawdowns               TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.permits                        TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.procurement_decisions          TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.public_intake_attempts         TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.requirement_overrides          TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.reservation_releases           TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.reservations                   TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.risk_overrides                 TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.screening_checks               TO ddp_ro, ddp_audit_reader;
GRANT SELECT ON public.security_settings              TO ddp_ro, ddp_audit_reader;
