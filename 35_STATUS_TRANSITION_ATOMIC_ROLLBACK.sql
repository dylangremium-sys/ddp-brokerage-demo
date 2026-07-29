-- ===========================================================================
-- 35_STATUS_TRANSITION_ATOMIC_ROLLBACK.sql
-- ---------------------------------------------------------------------------
-- Reverses 35_STATUS_TRANSITION_ATOMIC_HARDENING.sql.
--
-- NON-DESTRUCTIVE. Migration 35 creates exactly one function and owns no data.
-- Dropping it destroys no row: every status_history record it wrote is an
-- ordinary row in an ordinary table and is untouched here.
--
-- WHAT REVERTING COSTS
-- --------------------
-- The application feature-detects this function and, on 42P01/PGRST205 ONLY,
-- degrades to the pre-existing two-call path: an entity UPDATE followed by a
-- separate status_history INSERT. That path is not atomic. Removing this
-- function therefore re-opens audit finding R7 in full — a failed history insert
-- will again report failure to the operator while the row is already at the new
-- status in the database.
--
-- That degradation is deliberate and safe to trigger: it is the behaviour that
-- shipped before this migration, so a rollback returns the system to a known
-- state rather than an untested one. Deploy order does not matter in either
-- direction.
--
-- Scope: drops only the object migration 35 created. It touches no table, no
-- row, no policy, no privilege, and no other function.
-- ===========================================================================

BEGIN;

-- The full signature is named so that a future overload cannot be dropped by
-- accident, and so this statement fails loudly rather than silently matching
-- nothing if the signature ever changes.
DROP FUNCTION IF EXISTS public.record_status_transition(text, uuid, text, text, uuid);

COMMIT;
