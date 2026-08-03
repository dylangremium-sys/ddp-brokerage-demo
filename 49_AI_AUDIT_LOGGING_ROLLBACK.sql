-- Migration 49 Rollback: AI Audit Logging Hardening
-- Purpose: Safely remove ai_audit_events, ai_human_reviews, ai_approval_workflows
--          tables and associated functions
-- Date: 2026-08-03

BEGIN;

-- Drop dependent functions if they exist
-- Signature must match 49_AI_AUDIT_LOGGING_HARDENING.sql exactly. `DROP FUNCTION IF
-- EXISTS` with a signature that matches no function SUCCEEDS and drops nothing, so a
-- wrong argument list here leaves the function behind while the rollback reports rc=0.
-- The previous list — (UUID, TEXT, TEXT, JSONB, UUID) — had five arguments in the wrong
-- order; the function takes seven.
DROP FUNCTION IF EXISTS ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_audit_events_update() CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_audit_events_delete() CASCADE;

-- Drop tables (CASCADE drops dependent policies and indexes)
DROP TABLE IF EXISTS ai_approval_workflows CASCADE;
DROP TABLE IF EXISTS ai_human_reviews CASCADE;
DROP TABLE IF EXISTS ai_audit_events CASCADE;

COMMIT;
