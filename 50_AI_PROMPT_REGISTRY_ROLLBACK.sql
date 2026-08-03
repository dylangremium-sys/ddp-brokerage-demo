-- Migration 50 Rollback: AI Prompt Registry Hardening
-- Purpose: Safely remove ai_prompts, ai_prompt_versions, ai_model_configs,
--          and ai_prompt_experiments tables
-- Date: 2026-08-03

BEGIN;

-- Drop dependent functions
DROP FUNCTION IF EXISTS create_prompt_version() CASCADE;
DROP FUNCTION IF EXISTS validate_prompt_schema() CASCADE;

-- Drop tables (CASCADE drops dependent policies and indexes)
DROP TABLE IF EXISTS ai_prompt_experiments CASCADE;
DROP TABLE IF EXISTS ai_model_configs CASCADE;
DROP TABLE IF EXISTS ai_prompt_versions CASCADE;
DROP TABLE IF EXISTS ai_prompts CASCADE;

COMMIT;
