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

-- Wrapped in a transaction so the guard below can abort the WHOLE rollback. Without
-- it a client that continues past an error could drop the view/trigger and leave a
-- half-rolled-back state.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Refuse to destroy a live decision trail unless explicitly authorised.
--
--    public.procurement_decisions is the APPEND-ONLY record of who authorised the
--    release of a buyer pack (decided_by is pinned to auth.uid(); the table has a
--    mutation-prevention trigger). Migration 23 makes buyer-pack issuance
--    SERVER-AUTHORITATIVE by reading procurement_decisions_current — so dropping
--    this table destroys both the audit trail AND the evidence every future
--    issuance decision is checked against.
--
--    This mirrors the guard migration 24 already uses for evidence data: refuse
--    while rows exist unless the operator opts in deliberately, in the same
--    transaction:
--
--        SET LOCAL procurement.rollback_destructive = 'true';
-- ---------------------------------------------------------------------------
DO $destructive_guard$
DECLARE
  decision_count integer := 0;
  opt_in         text;
BEGIN
  IF to_regclass('public.procurement_decisions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.procurement_decisions' INTO decision_count;
  END IF;

  IF decision_count > 0 THEN
    BEGIN
      opt_in := current_setting('procurement.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN
      opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 17 refused: % procurement decision(s) exist. Dropping this table destroys the '
        'append-only record of who authorised each buyer-pack release, and the trail migration 23 '
        'reads to authorise future issuance. To proceed deliberately, run '
        'SET LOCAL procurement.rollback_destructive = ''true''; in the same transaction.',
        decision_count;
    END IF;

    RAISE NOTICE
      'rollback 17: destructive opt-in acknowledged — removing % procurement decision(s).',
      decision_count;
  END IF;
END
$destructive_guard$;

DROP VIEW IF EXISTS public.procurement_decisions_current;

DROP TRIGGER IF EXISTS trg_prevent_procurement_decision_mutation
  ON public.procurement_decisions;

-- The table must go before the function it depends on for the trigger.
DROP TABLE IF EXISTS public.procurement_decisions;

DROP FUNCTION IF EXISTS public.prevent_procurement_decision_mutation();

COMMIT;
