-- Migration 49 Rollback: AI Audit Logging Hardening
-- Purpose: Safely remove ai_audit_events, ai_human_reviews, and 
--          ai_approval_workflows tables
-- Date: 2026-08-03

BEGIN;

-- Drop dependent functions
DROP FUNCTION IF EXISTS log_audit_event() CASCADE;
DROP FUNCTION IF EXISTS prevent_audit_event_modification() CASCADE;
DROP FUNCTION IF EXISTS prevent_audit_event_truncation() CASCADE;

-- Drop tables (CASCADE drops dependent policies, indexes, and triggers)
DROP TABLE IF EXISTS ai_approval_workflows CASCADE;
DROP TABLE IF EXISTS ai_human_reviews CASCADE;
DROP TABLE IF EXISTS ai_audit_events CASCADE;

COMMIT;
