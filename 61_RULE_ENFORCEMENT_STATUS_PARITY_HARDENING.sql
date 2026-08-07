-- =============================================================================
-- 61_RULE_ENFORCEMENT_STATUS_PARITY_HARDENING.sql
--
-- Makes the database agree with the application about which compliance rule
-- statuses are enforced.
--
-- Depends on migration 41, which created both functions this replaces.
--
-- WHAT IS WRONG TODAY
-- Two places answer "is this rule enforced?" and they disagree about one status:
--
--   application  src/lib/complianceRuleEnforcement.ts  isRuleEnforcedNow
--                -> 'approved' OR 'active', inside the effective window
--   database     public.compliance_rules_currently_enforced()   (migration 41)
--                -> 'active' ONLY, inside the effective window
--
-- Since #157 the application's answer is the one that actually stops a buyer
-- pack being issued. So today a rule at status 'approved' blocks output while
-- `compliance_rules_currently_enforced()` reports it as not enforced. Anyone
-- reconciling a blocked pack against the database is told the rule that blocked
-- it is not in force. That is not a cosmetic mismatch: it is a gate whose
-- reason cannot be verified from the data.
--
-- THE DECISION THIS ENCODES
-- The owner decided on 2026-08-07 that `approved` MEANS SWITCHED ON. It is not
-- a staging state ahead of activation — an approved rule enforces.
--
-- That decision resolves the divergence in the application's favour, so it is
-- the DATABASE that widens here. The alternative — narrowing the application to
-- 'active' only — was rejected because it would silently stop a rule that
-- blocks a buyer pack today from blocking it tomorrow, which is a weakening of a
-- safety gate and not something to do as a side effect of tidying a mismatch.
--
-- WHY BOTH FUNCTIONS CHANGE
-- `compliance_rules_currently_enforced()` answers the present-tense question and
-- obviously changes. `compliance_rules_in_force(date)` answers the historical
-- one — "what applied on this day" — and already admits 'paused' and 'retired'
-- precisely because those rules WERE switched on at some point and a past
-- shipment must still be judged by them. Under "approved means switched on",
-- 'approved' belongs in that set by exactly the same reasoning. Widening only
-- one of the two would replace the divergence rather than close it.
--
-- 'draft', 'suggested' and 'rejected' remain excluded from both. Those have
-- never been switched on, and nothing in this migration changes that.
--
-- WHAT DOES NOT CHANGE
-- Effective-window semantics are untouched: effective_from inclusive,
-- effective_to exclusive, in both functions. The SECURITY DEFINER declaration,
-- the pinned `search_path`, the STABLE volatility and the existing grants are
-- all preserved exactly. A CREATE OR REPLACE keeps existing privileges, but the
-- REVOKE/GRANT pair is re-asserted at the end so the end state is stated in one
-- place rather than inherited silently.
-- =============================================================================

BEGIN;

-- 1. The historical question: "what applied on this day?"
--    'approved' joins 'active', 'paused' and 'retired' — every status that
--    represents a rule which has been switched on at some point.
CREATE OR REPLACE FUNCTION public.compliance_rules_in_force(p_as_of date DEFAULT current_date)
RETURNS SETOF public.compliance_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.compliance_rules r
  WHERE r.status IN ('approved', 'active', 'paused', 'retired')
    AND r.effective_from <= p_as_of
    AND (r.effective_to IS NULL OR r.effective_to > p_as_of)
$$;

-- 2. The present-tense question: "what must be enforced right now?"
--    'paused' and 'retired' stay excluded — a paused rule is paused, and must
--    not block a shipment today even though its effective window is still open.
--    'approved' is now included, because approved means switched on.
CREATE OR REPLACE FUNCTION public.compliance_rules_currently_enforced()
RETURNS SETOF public.compliance_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.compliance_rules r
  WHERE r.status IN ('approved', 'active')
    AND r.effective_from <= current_date
    AND (r.effective_to IS NULL OR r.effective_to > current_date)
$$;

COMMENT ON FUNCTION public.compliance_rules_in_force(date) IS
  'Rules whose effective window covers p_as_of and whose status means they have been switched on at some point (approved, active, paused, retired). The historical question. Status vocabulary matched to the application''s isRuleEnforcedNow by migration 61.';

COMMENT ON FUNCTION public.compliance_rules_currently_enforced() IS
  'Rules enforced right now: status approved or active, inside the effective window. Matches the application''s isRuleEnforcedNow (src/lib/complianceRuleEnforcement.ts) exactly, by migration 61. If either side changes, change both.';

-- 3. Re-assert the privilege end state. CREATE OR REPLACE preserves grants, so
--    this is belt and braces rather than repair — but a reader should not have
--    to look in migration 41 to learn who may execute these.
REVOKE EXECUTE ON FUNCTION public.compliance_rules_in_force(date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compliance_rules_in_force(date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.compliance_rules_currently_enforced() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compliance_rules_currently_enforced() TO authenticated, service_role;

COMMIT;
