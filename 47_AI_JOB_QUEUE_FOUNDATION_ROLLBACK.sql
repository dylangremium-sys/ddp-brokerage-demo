-- Migration 47 Rollback: AI Job Queue Foundation
-- Purpose: Safely remove ai_jobs and ai_job_attempts tables and their
--          associated indexes, policies, and triggers
-- Date: 2026-08-03

BEGIN;

-- Drop triggers first (they depend on the tables)
DROP TRIGGER IF EXISTS prevent_ai_job_attempts_update ON ai_job_attempts;
DROP TRIGGER IF EXISTS prevent_ai_job_attempts_delete ON ai_job_attempts;
DROP TRIGGER IF EXISTS prevent_ai_job_attempts_truncate ON ai_job_attempts;

-- Drop associated functions
DROP FUNCTION IF EXISTS prevent_job_attempt_modification() CASCADE;
DROP FUNCTION IF EXISTS prevent_job_attempt_truncation() CASCADE;

-- Drop tables (CASCADE drops dependent policies and indexes)
DROP TABLE IF EXISTS ai_job_attempts CASCADE;
DROP TABLE IF EXISTS ai_jobs CASCADE;

COMMIT;
