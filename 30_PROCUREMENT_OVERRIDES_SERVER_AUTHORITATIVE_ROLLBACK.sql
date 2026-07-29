-- ===========================================================================
-- 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_ROLLBACK.sql
-- ---------------------------------------------------------------------------
-- Reverses 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql.
--
-- *** DESTRUCTIVE — READ BEFORE RUNNING ***
-- This DROPS public.risk_overrides and public.requirement_overrides AND THE
-- AUDIT HISTORY THEY HOLD. Those rows are the only server-side record of who
-- cleared a blocking risk or requirement, when, and why. Once dropped they
-- cannot be reconstructed: the client's localStorage copy is a CACHE, carries no
-- actor, and is wiped at sign-out.
--
-- After running this, the application feature-detects the missing tables
-- (42P01/PGRST205) and degrades to its previous localStorage-only behaviour —
-- which re-opens audit finding F2 in full: browser-local, unattributed
-- clearances, invisible to other admins and destroyed by sign-out.
--
-- EXPORT FIRST if the rows have any evidentiary value:
--   \copy (SELECT * FROM public.risk_overrides ORDER BY decided_at)
--     TO 'risk_overrides_backup.csv' CSV HEADER
--   \copy (SELECT * FROM public.requirement_overrides ORDER BY decided_at)
--     TO 'requirement_overrides_backup.csv' CSV HEADER
--
-- Scope: drops only the objects migration 30 created. It does not touch
-- procurement_decisions (17), buyer_pack_snapshots (10), the issuance RPC (23/29),
-- or any pre-existing policy, privilege or column.
-- ===========================================================================

begin;

-- Views first — they depend on the tables.
DROP VIEW IF EXISTS public.risk_overrides_current;
DROP VIEW IF EXISTS public.requirement_overrides_current;

-- Triggers are dropped with their tables, but naming them keeps this reversal
-- explicit and makes a partial rollback (tables kept, triggers gone) impossible
-- to reach by accident.
DROP TRIGGER IF EXISTS trg_prevent_risk_override_mutation ON public.risk_overrides;
DROP TRIGGER IF EXISTS trg_prevent_requirement_override_mutation ON public.requirement_overrides;

DROP TABLE IF EXISTS public.risk_overrides;
DROP TABLE IF EXISTS public.requirement_overrides;

-- The trigger functions are exclusive to these tables; nothing else references
-- them. RESTRICT (the default) rather than CASCADE, so an unexpected dependency
-- aborts the rollback loudly instead of silently dropping someone else's object.
DROP FUNCTION IF EXISTS public.prevent_risk_override_mutation();
DROP FUNCTION IF EXISTS public.prevent_requirement_override_mutation();

commit;
