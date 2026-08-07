-- =============================================================================
-- 62_COMPLIANCE_RULE_CONDITIONS_ROLLBACK.sql
--
-- Removes the condition column, its shape CHECK and its partial index.
--
-- ROLLING BACK DESTROYS DATA, and unlike migration 61's rollback that loss is
-- real rather than a return to a disagreeing state: every authored condition is
-- dropped with the column. Nothing else stores them.
--
-- That is acceptable ONLY while no rule enforces from a condition, which is true
-- as of this migration — the column is written and read by nothing on the gate
-- path. Once alert-raising lands, rolling this back would silently stop
-- enforcement for every rule that relied on it, and this header must be revised
-- to say so.
--
-- Dropping the column removes the CHECK and the index with it; both are named
-- explicitly first so the rollback states its full intent rather than relying on
-- a cascade the reader has to know about.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_compliance_rules_with_condition;

ALTER TABLE public.compliance_rules
  DROP CONSTRAINT IF EXISTS compliance_rules_condition_shape;

ALTER TABLE public.compliance_rules
  DROP COLUMN IF EXISTS condition;

COMMIT;
