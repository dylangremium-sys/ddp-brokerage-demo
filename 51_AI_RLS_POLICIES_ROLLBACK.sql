-- Migration 51 Rollback: AI RLS Policies Hardening
-- Purpose: Disable RLS on AI tables and drop associated policies
-- Date: 2026-08-03
-- Note: This migration is primarily policy definitions. Reverting it
--       disables RLS enforcement on the tables. Use with caution.

BEGIN;

-- Disable RLS on all AI tables (policies will remain but be inactive)
ALTER TABLE IF EXISTS ai_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_job_attempts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_usage_metrics DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_cost_alerts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_budget_caps DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_audit_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_human_reviews DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_prompts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_prompt_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_model_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_prompt_experiments DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_approval_workflows DISABLE ROW LEVEL SECURITY;

COMMIT;
