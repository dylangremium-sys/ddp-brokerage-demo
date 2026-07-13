-- ===========================================================================
-- 17_PROCUREMENT_DECISIONS_ROLLBACK.sql
-- Reverses 17_PROCUREMENT_DECISIONS_MVP.sql.
--
-- *** DESTRUCTIVE: DROPPING THIS TABLE DESTROYS THE DECISION AUDIT TRAIL. ***
--
-- These rows are the record of who authorised the release of a controlled-
-- substance batch, and why. They are deliberately append-only and cannot be
-- reconstructed. Export before you drop:
--
--     COPY (SELECT * FROM public.procurement_decisions)
--     TO STDOUT WITH CSV HEADER;
--
-- The application feature-detects this table and falls back to its previous
-- localStorage behaviour when it is absent, so dropping it will NOT break the
-- running app — it will silently revert to browser-only decisions, which is
-- exactly the condition migration 17 exists to end. Prefer leaving the table in
-- place and rolling back only the application deploy.
--
-- Additive migration ⇒ rollback is a clean drop. No other object depends on it
-- except the view created alongside it.
-- ===========================================================================

DROP VIEW IF EXISTS public.procurement_decisions_current;

DROP TRIGGER IF EXISTS trg_prevent_procurement_decision_mutation
  ON public.procurement_decisions;

-- The table must go before the function it depends on for the trigger.
DROP TABLE IF EXISTS public.procurement_decisions;

DROP FUNCTION IF EXISTS public.prevent_procurement_decision_mutation();
