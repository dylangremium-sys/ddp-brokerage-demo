-- Migration 51: AI RLS Policies & Verification
-- Purpose: Add missing RLS verification and tighten access controls
-- Status: Hardening
-- Date: 2026-08-02

BEGIN;

-- ============================================================================
-- VERIFY: RLS is enabled on all ai_* tables
-- ============================================================================

-- ai_jobs
ALTER TABLE IF EXISTS ai_jobs ENABLE ROW LEVEL SECURITY;

-- ai_job_attempts
ALTER TABLE IF EXISTS ai_job_attempts ENABLE ROW LEVEL SECURITY;

-- ai_usage_metrics
ALTER TABLE IF EXISTS ai_usage_metrics ENABLE ROW LEVEL SECURITY;

-- ai_cost_alerts
ALTER TABLE IF EXISTS ai_cost_alerts ENABLE ROW LEVEL SECURITY;

-- ai_budget_caps
ALTER TABLE IF EXISTS ai_budget_caps ENABLE ROW LEVEL SECURITY;

-- ai_audit_events
ALTER TABLE IF EXISTS ai_audit_events ENABLE ROW LEVEL SECURITY;

-- ai_human_reviews
ALTER TABLE IF EXISTS ai_human_reviews ENABLE ROW LEVEL SECURITY;

-- ai_approval_workflows
ALTER TABLE IF EXISTS ai_approval_workflows ENABLE ROW LEVEL SECURITY;

-- ai_prompts
ALTER TABLE IF EXISTS ai_prompts ENABLE ROW LEVEL SECURITY;

-- ai_prompt_versions
ALTER TABLE IF EXISTS ai_prompt_versions ENABLE ROW LEVEL SECURITY;

-- ai_model_configs
ALTER TABLE IF EXISTS ai_model_configs ENABLE ROW LEVEL SECURITY;

-- ai_prompt_experiments
ALTER TABLE IF EXISTS ai_prompt_experiments ENABLE ROW LEVEL SECURITY;

-- ai_provider_pricing
ALTER TABLE IF EXISTS ai_provider_pricing ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Populate initial data: AI approval workflows
-- ============================================================================

INSERT INTO ai_approval_workflows (feature_code, action_type, approval_role, approval_sla_hours, requires_secondary_approval)
VALUES
  ('coa_extraction', 'extraction_approval', 'admin', 24, false),
  ('risk_detection', 'risk_escalation', 'compliance_team', 8, true),
  ('buyer_matching', 'buyer_pack_release', 'admin', 24, false),
  ('farmer_assistant', 'escalation', 'admin', 4, false),
  ('watchtower_ai', 'rule_approval', 'legal', 48, true)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Populate initial data: Model configs (defaults)
-- ============================================================================

INSERT INTO ai_model_configs (feature_code, action_type, primary_provider, primary_model, fallback_provider, fallback_model, ab_test_enabled)
VALUES
  ('coa_extraction', 'extraction', 'anthropic', 'claude-opus-5', 'anthropic', 'claude-sonnet-5', false),
  ('risk_detection', 'analysis', 'anthropic', 'claude-opus-5', 'anthropic', 'claude-sonnet-5', false),
  ('buyer_matching', 'matching', 'anthropic', 'claude-sonnet-5', NULL, NULL, false),
  ('farmer_assistant', 'chat', 'anthropic', 'claude-sonnet-5', NULL, NULL, false),
  ('watchtower_ai', 'summarisation', 'anthropic', 'claude-opus-5', 'anthropic', 'claude-sonnet-5', false),
  ('enquiry_assistant', 'drafting', 'anthropic', 'claude-sonnet-5', NULL, NULL, false),
  ('compliance_gap_analysis', 'analysis', 'anthropic', 'claude-opus-5', NULL, NULL, false),
  ('readiness_scoring', 'analysis', 'anthropic', 'claude-sonnet-5', NULL, NULL, false),
  ('marketplace_analytics', 'summarisation', 'anthropic', 'claude-sonnet-5', NULL, NULL, false)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Populate initial data: Default budget caps (per farm, global)
-- ============================================================================

-- TODO: This will be inserted per-farm during onboarding
-- For now, just ensure default system-wide caps exist

-- ============================================================================
-- VERIFY: Service role has appropriate access
-- ============================================================================

-- Service role should be able to:
-- - INSERT into ai_jobs (create new jobs)
-- - UPDATE ai_jobs (change status during processing)
-- - INSERT into ai_job_attempts (record retry history)
-- - INSERT into ai_usage_metrics (aggregate usage)
-- - INSERT into ai_cost_alerts (log budget events)
-- - INSERT into ai_audit_events (audit trail)

-- These are granted via DEFAULT PRIVILEGES at table creation time
-- Verify they're in place:

-- Note: If service role needs explicit grants, uncomment below:
-- GRANT INSERT, UPDATE ON ai_jobs TO service_role;
-- GRANT INSERT ON ai_job_attempts TO service_role;
-- GRANT INSERT, UPDATE ON ai_usage_metrics TO service_role;
-- GRANT INSERT ON ai_cost_alerts TO service_role;
-- GRANT INSERT ON ai_audit_events TO service_role;
-- GRANT INSERT ON ai_human_reviews TO service_role;

-- ============================================================================
-- VERIFY: Test data seeds (for unit/integration testing)
-- ============================================================================

-- Seed test user roles (if not already present)
-- TODO: Move to separate test seed file if using fixtures
-- INSERT INTO auth.users (...) would go here

-- ============================================================================
-- Migration verification script (to run as final check)
-- ============================================================================

-- Verify all ai_* tables exist and have RLS enabled:
-- SELECT tablename FROM pg_tables 
-- WHERE schemaname = 'public' AND tablename LIKE 'ai_%' 
-- ORDER BY tablename;

-- Verify append-only constraints on ai_job_attempts, ai_audit_events, etc:
-- SELECT trigger_name FROM information_schema.triggers 
-- WHERE trigger_name LIKE 'prevent_%' 
-- ORDER BY trigger_name;

-- Verify RLS policies exist:
-- SELECT policyname FROM pg_policies 
-- WHERE tablename LIKE 'ai_%' 
-- ORDER BY tablename, policyname;

COMMIT;
