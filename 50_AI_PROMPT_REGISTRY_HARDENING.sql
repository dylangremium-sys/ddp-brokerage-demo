-- Migration 50: Prompt Registry & Model Version Tracking
-- Purpose: Manage prompt templates and model configurations for reproducibility
-- Tables: ai_prompts, ai_prompt_versions, ai_model_configs
-- Status: Hardening
-- Date: 2026-08-02

BEGIN;

-- ============================================================================
-- ai_prompts: Prompt template registry (versioned)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_prompts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Prompt identification
  prompt_key TEXT NOT NULL UNIQUE,  -- 'coa_extraction_v1', 'risk_detection_v2', etc.
  feature_code TEXT NOT NULL,       -- 'coa_extraction', 'risk_detection'
  action_type TEXT NOT NULL,        -- 'extraction', 'analysis', 'summary', 'translation'
  
  -- Current version
  current_version INT NOT NULL DEFAULT 1,
  
  -- Prompt content (system + user template)
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,  -- May contain {field} placeholders
  
  -- Metadata
  description TEXT,
  input_schema JSONB,   -- JSON Schema for prompt inputs
  output_schema JSONB,  -- Expected output format and fields
  
  -- Configuration
  max_input_tokens INT,
  max_output_tokens INT,
  temperature NUMERIC(3, 2) DEFAULT 0.2,  -- Lower = more deterministic
  
  -- Safety and quality
  guardrails TEXT[],  -- ['no_compliance_claims', 'cite_sources', 'no_hallucination']
  allowed_models TEXT[] DEFAULT ARRAY['claude-opus-5', 'claude-sonnet-5'],
  
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_ai_prompts_feature ON ai_prompts(feature_code);
CREATE INDEX IF NOT EXISTS idx_ai_prompts_active ON ai_prompts(is_active);

ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;

-- Admin only
CREATE POLICY "ai_prompts: admin all" ON ai_prompts
  FOR ALL USING (is_ddp_admin());

-- ============================================================================
-- ai_prompt_versions: Append-only version history for prompts
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  prompt_id TEXT NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
  
  -- Version info
  version_number INT NOT NULL,
  
  -- Prompt content at this version
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  
  -- Configuration at this version
  max_input_tokens INT,
  max_output_tokens INT,
  temperature NUMERIC(3, 2),
  
  -- Safety guardrails at this version
  guardrails TEXT[],
  
  -- Change tracking
  change_reason TEXT,  -- e.g., "Improved extraction accuracy", "Added safety guardrail"
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- Immutable audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(prompt_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_versions_prompt_id ON ai_prompt_versions(prompt_id);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_versions_version ON ai_prompt_versions(version_number);

ALTER TABLE ai_prompt_versions ENABLE ROW LEVEL SECURITY;

-- Prevent UPDATE/DELETE
CREATE OR REPLACE FUNCTION prevent_ai_prompt_versions_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_prompt_versions is append-only; UPDATE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_prompt_versions_update
  BEFORE UPDATE ON ai_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_prompt_versions_update();

CREATE OR REPLACE FUNCTION prevent_ai_prompt_versions_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_prompt_versions is append-only; DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION prevent_ai_prompt_versions_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_prompt_versions_delete() FROM anon;
-- acl-no-grant: prevent_ai_prompt_versions_delete

CREATE TRIGGER prevent_ai_prompt_versions_delete
  BEFORE DELETE ON ai_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_prompt_versions_delete();

-- Admin only
CREATE POLICY "ai_prompt_versions: admin all" ON ai_prompt_versions
  FOR ALL USING (is_ddp_admin());

-- ============================================================================
-- ai_model_configs: Model selection and fallback strategy
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_model_configs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Configuration scope
  feature_code TEXT NOT NULL UNIQUE,  -- 'coa_extraction', 'risk_detection', etc.
  action_type TEXT,                   -- Optional: specific action within feature
  
  -- Primary model
  primary_provider TEXT NOT NULL,  -- 'anthropic', 'azure', 'ollama'
  primary_model TEXT NOT NULL,     -- 'claude-opus-5', 'gpt-4-turbo', 'mistral', etc.
  
  -- Fallback strategy
  fallback_enabled BOOLEAN DEFAULT true,
  fallback_provider TEXT,  -- 'azure', 'ollama', null
  fallback_model TEXT,
  
  -- Model behavior
  max_retries INT DEFAULT 3,
  timeout_seconds INT DEFAULT 60,
  
  -- Cost constraints
  max_input_tokens INT DEFAULT 4000,
  max_output_tokens INT DEFAULT 2000,
  cost_limit_per_job_usd NUMERIC(10, 4) DEFAULT 5.00,  -- Skip if cost would exceed
  
  -- A/B Testing
  ab_test_enabled BOOLEAN DEFAULT false,
  ab_test_split_percent INT DEFAULT 50,  -- % of jobs to send to variant
  variant_provider TEXT,
  variant_model TEXT,
  
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_ai_model_configs_feature ON ai_model_configs(feature_code);
CREATE INDEX IF NOT EXISTS idx_ai_model_configs_active ON ai_model_configs(is_active);

ALTER TABLE ai_model_configs ENABLE ROW LEVEL SECURITY;

-- Admin only
CREATE POLICY "ai_model_configs: admin all" ON ai_model_configs
  FOR ALL USING (is_ddp_admin());

-- ============================================================================
-- ai_prompt_experiments: Track A/B test results for prompt iterations
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_prompt_experiments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Experiment setup
  prompt_id TEXT NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
  variant_prompt_id TEXT REFERENCES ai_prompts(id) ON DELETE SET NULL,
  
  experiment_name TEXT NOT NULL,
  experiment_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  experiment_end_date DATE,
  
  -- Control vs variant
  control_model TEXT NOT NULL,
  variant_model TEXT NOT NULL,
  split_percent INT DEFAULT 50,
  
  -- Sample results (materialized from jobs + reviews)
  control_sample_size INT DEFAULT 0,
  variant_sample_size INT DEFAULT 0,
  
  control_avg_confidence NUMERIC(5, 4),
  variant_avg_confidence NUMERIC(5, 4),
  
  control_human_approval_rate NUMERIC(5, 4),  -- % of reviews that approved
  variant_human_approval_rate NUMERIC(5, 4),
  
  control_avg_cost_usd NUMERIC(10, 4),
  variant_avg_cost_usd NUMERIC(10, 4),
  
  -- Winner (if experiment ended)
  winner TEXT,  -- 'control', 'variant', 'no_clear_winner'
  winner_reason TEXT,
  
  -- Audit
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_experiments_prompt_id ON ai_prompt_experiments(prompt_id);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_experiments_dates ON ai_prompt_experiments(experiment_start_date, experiment_end_date);

ALTER TABLE ai_prompt_experiments ENABLE ROW LEVEL SECURITY;

-- Admin only
CREATE POLICY "ai_prompt_experiments: admin all" ON ai_prompt_experiments
  FOR ALL USING (is_ddp_admin());

-- ============================================================================
-- ACL for functions
-- ============================================================================

REVOKE EXECUTE ON FUNCTION prevent_ai_prompt_versions_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_prompt_versions_update() FROM anon;
-- acl-no-grant: prevent_ai_prompt_versions_update

-- REVOKE EXECUTE ON FUNCTION prevent_ai_prompt_versions_delete() FROM PUBLIC;
-- REVOKE EXECUTE ON FUNCTION prevent_ai_prompt_versions_delete() FROM anon;
-- -- acl-no-grant: prevent_ai_prompt_versions_delete
-- 
-- REVOKE EXECUTE ON FUNCTION get_active_prompt(TEXT) FROM PUBLIC;
-- REVOKE EXECUTE ON FUNCTION get_active_prompt(TEXT) FROM anon;
-- -- acl-no-grant: get_active_prompt


-- ============================================================================
-- Grant restrictions
-- ============================================================================

-- Only admin can write to ai_prompts
REVOKE INSERT, UPDATE, DELETE ON ai_prompts FROM authenticated, anon;

-- Only admin can write to ai_prompt_versions
REVOKE INSERT ON ai_prompt_versions FROM authenticated, anon;
REVOKE UPDATE, DELETE ON ai_prompt_versions FROM authenticated, anon;

-- Only admin can write to ai_model_configs
REVOKE INSERT, UPDATE, DELETE ON ai_model_configs FROM authenticated, anon;

-- Only admin can write to ai_prompt_experiments
REVOKE INSERT, UPDATE, DELETE ON ai_prompt_experiments FROM authenticated, anon;

-- ============================================================================
-- Helper functions
-- ============================================================================

-- Get the current active prompt for a feature
CREATE OR REPLACE FUNCTION get_active_prompt(p_feature_code TEXT)
RETURNS TABLE(
  prompt_id TEXT,
  prompt_key TEXT,
  version INT,
  system_prompt TEXT,
  user_prompt_template TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT ap.id, ap.prompt_key, ap.current_version, ap.system_prompt, ap.user_prompt_template
  FROM ai_prompts ap
  WHERE ap.feature_code = p_feature_code AND ap.is_active
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get model config for a feature
CREATE OR REPLACE FUNCTION get_model_config(p_feature_code TEXT)
RETURNS TABLE(
  primary_provider TEXT,
  primary_model TEXT,
  fallback_provider TEXT,
  fallback_model TEXT,
  max_retries INT,
  timeout_seconds INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT amc.primary_provider, amc.primary_model, amc.fallback_provider, amc.fallback_model,
         amc.max_retries, amc.timeout_seconds
  FROM ai_model_configs amc
  WHERE amc.feature_code = p_feature_code AND amc.is_active
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Comments
-- ============================================================================
REVOKE EXECUTE ON FUNCTION get_active_prompt(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_active_prompt(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION get_model_config(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_model_config(TEXT) FROM anon;
-- acl-no-grant: get_model_config

COMMENT ON TABLE ai_prompts IS 'Prompt template registry. Versioned; admin controls updates.';
COMMENT ON TABLE ai_prompt_versions IS 'Append-only version history for prompts. Enables rollback and reproducibility.';
COMMENT ON TABLE ai_model_configs IS 'Model selection and fallback strategy per feature.';
COMMENT ON TABLE ai_prompt_experiments IS 'A/B test results for prompt and model iterations.';

COMMIT;
