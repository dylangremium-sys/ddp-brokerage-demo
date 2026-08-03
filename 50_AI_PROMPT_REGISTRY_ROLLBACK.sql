-- Migration 50 Rollback: AI Prompt Registry Hardening
-- Purpose: Safely remove ai_prompts, ai_prompt_versions, ai_model_configs,
--          ai_prompt_experiments tables and associated functions
-- Date: 2026-08-03

BEGIN;

-- Drop dependent functions if they exist
DROP FUNCTION IF EXISTS prevent_ai_prompt_versions_update() CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_prompt_versions_delete() CASCADE;
DROP FUNCTION IF EXISTS get_active_prompt(TEXT) CASCADE;
DROP FUNCTION IF EXISTS get_model_config(TEXT) CASCADE;

-- Drop tables (CASCADE drops dependent policies and indexes)
DROP TABLE IF EXISTS ai_prompt_experiments CASCADE;
DROP TABLE IF EXISTS ai_model_configs CASCADE;
DROP TABLE IF EXISTS ai_prompt_versions CASCADE;
DROP TABLE IF EXISTS ai_prompts CASCADE;

COMMIT;
