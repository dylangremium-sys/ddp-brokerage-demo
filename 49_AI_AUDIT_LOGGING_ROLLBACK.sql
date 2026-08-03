-- Migration 49 Rollback: AI Audit Logging Hardening
-- Purpose: Safely remove ai_audit_events, ai_human_reviews, ai_approval_workflows
--          tables and associated functions
-- Date: 2026-08-03

BEGIN;

-- Drop dependent functions if they exist
DROP FUNCTION IF EXISTS ai_create_audit_event(UUID, TEXT, TEXT, JSONB, UUID) CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_audit_events_update() CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_audit_events_delete() CASCADE;

-- Drop tables (CASCADE drops dependent policies and indexes)
DROP TABLE IF EXISTS ai_approval_workflows CASCADE;
DROP TABLE IF EXISTS ai_human_reviews CASCADE;
DROP TABLE IF EXISTS ai_audit_events CASCADE;

COMMIT;
