-- =============================================================================
-- 62_COMPLIANCE_RULE_CONDITIONS_HARDENING.sql
--
-- Gives a compliance rule somewhere to keep its machine-readable condition.
--
-- Depends on migration 41 (effective dating) and 61 (status parity). Neither is
-- changed here.
--
-- WHAT IS MISSING TODAY
-- A rule can say who it applies to (entity_type, jurisdiction), how much it
-- matters (severity, is_blocking) and whether it is in force (status,
-- effective_from/to). It cannot say what makes a batch VIOLATE it. So nothing
-- evaluates rules, and a human has to link rule to batch by hand for the gate
-- added in #157 to fire at all. That is W1.
--
-- WHAT THIS ADDS
-- One nullable JSONB column, `condition`, holding the structured predicate
-- defined by src/lib/complianceRuleCondition.ts (option A of
-- docs/W1_RULE_CONDITION_DESIGN.md). NULL means "this rule has no automatic
-- condition" — a human-linked rule, which is every rule that exists today.
--
-- NULLABLE IS THE POINT, NOT AN OVERSIGHT. All existing rules keep working
-- exactly as they do now, and a rule may deliberately never get a condition
-- because some regulations cannot be reduced to a field comparison. A NOT NULL
-- column with a placeholder default would have forced every one of those to
-- carry a meaningless condition and would have made "has no condition"
-- indistinguishable from "has an empty one".
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
--
-- 1. IT DOES NOT VALIDATE THE PREDICATE'S SEMANTICS. The CHECK below constrains
--    the SHAPE only: an object, not an array or a scalar, and carrying one of
--    the four recognised keys. Whether `field` names something real, and whether
--    the operator suits that field's type, is enforced by parseRuleCondition in
--    the application, on write, where it can return a message naming the failing
--    path.
--
--    That split is deliberate. Re-implementing the field registry as a Postgres
--    CHECK would create a SECOND definition of what a valid condition is, which
--    would then drift from the first — the exact defect migration 61 has just
--    finished closing for rule statuses. One authority, and a shape guard here
--    so a malformed blob cannot be stored even by a caller that bypasses the
--    application.
--
-- 2. IT DOES NOT MAKE ANYTHING ENFORCE. No trigger evaluates this column, no
--    alert is raised from it, and the buyer-pack gate does not read it. Storing
--    a condition changes nothing about what blocks until the alert-raising step
--    lands. A rule with a condition today behaves exactly like one without.
-- =============================================================================

BEGIN;

ALTER TABLE public.compliance_rules
  ADD COLUMN IF NOT EXISTS condition JSONB;

-- Shape guard only — see note 1 above. `jsonb_typeof(...) = 'object'` rejects a
-- bare array, string, number or boolean; the key test rejects an object that is
-- none of the four recognised node kinds. NULL passes, because NULL is the
-- normal state of a rule with no automatic condition.
ALTER TABLE public.compliance_rules
  DROP CONSTRAINT IF EXISTS compliance_rules_condition_shape;

ALTER TABLE public.compliance_rules
  ADD CONSTRAINT compliance_rules_condition_shape CHECK (
    condition IS NULL
    OR (
      jsonb_typeof(condition) = 'object'
      AND (
        condition ? 'field'
        OR condition ? 'all'
        OR condition ? 'any'
        OR condition ? 'not'
      )
    )
  );

COMMENT ON COLUMN public.compliance_rules.condition IS
  'Structured predicate deciding whether a batch violates this rule; NULL means the rule has no automatic condition and is linked to entities by a human. Shape only is constrained here — field names and operator/type agreement are validated by parseRuleCondition in src/lib/complianceRuleCondition.ts, which is the single authority. Storing a condition does NOT by itself cause anything to be enforced.';

-- Finding the rules that CAN be evaluated is the hot path for the future
-- evaluation sweep, and it is a small fraction of the table. A partial index
-- keeps it off the rows that will never match.
CREATE INDEX IF NOT EXISTS idx_compliance_rules_with_condition
  ON public.compliance_rules (status)
  WHERE condition IS NOT NULL;

COMMIT;
