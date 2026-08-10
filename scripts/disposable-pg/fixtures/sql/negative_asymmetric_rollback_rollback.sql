-- Deliberately defective ROLLBACK (see negative_asymmetric_rollback_apply.sql).
--
-- The function was created as (TEXT, TEXT, UUID). This drops (UUID, TEXT, TEXT).
-- No function has that signature, so IF EXISTS makes the statement a silent
-- success and fixture_create_audit_event survives the rollback.
--
-- Every statement here returns 0. Only comparing the catalog before apply with
-- the catalog after rollback reveals the leak.

DROP FUNCTION IF EXISTS fixture_create_audit_event(UUID, TEXT, TEXT) CASCADE;

DROP TABLE IF EXISTS fixture_audit_events CASCADE;
