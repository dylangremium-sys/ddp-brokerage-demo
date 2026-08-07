-- =============================================================================
-- 61_RULE_ENFORCEMENT_STATUS_PARITY_ROLLBACK.sql
--
-- Restores both rule resolvers to their migration-41 definitions.
--
-- WHAT ROLLING BACK MEANS HERE, STATED PLAINLY
-- This does not return the system to a safe state; it returns it to a
-- DISAGREEING one. After this runs, `compliance_rules_currently_enforced()`
-- reports only 'active' again, while the application continues to block buyer
-- packs on 'approved' rules — because that behaviour lives in TypeScript
-- (isRuleEnforcedNow) and is not touched by any migration.
--
-- So the post-rollback state is the pre-61 defect: a pack can be blocked by a
-- rule the database says is not enforced. Roll back only to unblock a failed
-- apply, and treat the divergence as re-opened until 61 is re-applied.
--
-- The bodies below are copied verbatim from
-- 41_EFFECTIVE_DATED_RULESETS_HARDENING.sql so the restore is exact rather than
-- reconstructed. The comment restored on each function is 41's intent, not 61's.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.compliance_rules_in_force(p_as_of date DEFAULT current_date)
RETURNS SETOF public.compliance_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.compliance_rules r
  WHERE r.status IN ('active', 'paused', 'retired')
    AND r.effective_from <= p_as_of
    AND (r.effective_to IS NULL OR r.effective_to > p_as_of)
$$;

CREATE OR REPLACE FUNCTION public.compliance_rules_currently_enforced()
RETURNS SETOF public.compliance_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.compliance_rules r
  WHERE r.status = 'active'
    AND r.effective_from <= current_date
    AND (r.effective_to IS NULL OR r.effective_to > current_date)
$$;

COMMENT ON FUNCTION public.compliance_rules_in_force(date) IS NULL;
COMMENT ON FUNCTION public.compliance_rules_currently_enforced() IS NULL;

-- Grants are unchanged by a CREATE OR REPLACE, but re-asserted so a rollback
-- leaves the same explicit end state the forward migration does.
REVOKE EXECUTE ON FUNCTION public.compliance_rules_in_force(date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compliance_rules_in_force(date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.compliance_rules_currently_enforced() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compliance_rules_currently_enforced() TO authenticated, service_role;

COMMIT;
