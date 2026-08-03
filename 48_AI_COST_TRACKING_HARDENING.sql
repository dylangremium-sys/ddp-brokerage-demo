-- Migration 48: AI Cost Tracking & Budget Enforcement
-- Purpose: Track token usage, estimated costs, and enforce budget caps
-- Tables: ai_usage_metrics, ai_cost_alerts, ai_budget_caps
-- Status: Hardening
-- Date: 2026-08-02

BEGIN;

-- ============================================================================
-- ai_usage_metrics: Aggregate usage tracking per farm/feature (append-only log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_usage_metrics (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Aggregate scope
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,  -- 'coa_extraction', 'risk_detection', etc.
  
  -- Daily bucket (for cost tracking)
  date_bucket DATE NOT NULL DEFAULT CURRENT_DATE,
  
  -- Usage aggregates
  jobs_submitted INT DEFAULT 0,
  jobs_completed INT DEFAULT 0,
  jobs_failed INT DEFAULT 0,
  
  total_input_tokens INT DEFAULT 0,
  total_output_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  
  -- Cost (USD)
  total_cost_usd NUMERIC(10, 4) DEFAULT 0.00,
  
  -- Audit
  last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(farm_id, feature_code, date_bucket)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_metrics_farm ON ai_usage_metrics(farm_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_metrics_feature ON ai_usage_metrics(feature_code);
CREATE INDEX IF NOT EXISTS idx_ai_usage_metrics_date ON ai_usage_metrics(date_bucket);

ALTER TABLE ai_usage_metrics ENABLE ROW LEVEL SECURITY;

-- Admin and service role can query usage; farmers see own farm only
CREATE POLICY "ai_usage_metrics: admin all" ON ai_usage_metrics
  FOR ALL USING (is_ddp_admin());

CREATE POLICY "ai_usage_metrics: farmer own farm" ON ai_usage_metrics
  FOR SELECT USING (has_farm_membership(farm_id));

-- ============================================================================
-- ai_budget_caps: Enforce spending limits per farm/feature
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_budget_caps (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Budget scope
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,  -- 'all' for global cap, or specific feature
  
  -- Budget limits (USD per month)
  monthly_budget_usd NUMERIC(10, 2) NOT NULL DEFAULT 5000.00,
  
  -- Alert thresholds (percentage of budget)
  alert_threshold_percent INT DEFAULT 80,  -- Alert when >80% spent
  hard_stop_percent INT DEFAULT 100,       -- Pause jobs when >=100%
  
  -- Soft stop: pause new submissions without hard blocking
  soft_stop_enabled BOOLEAN DEFAULT true,
  soft_stop_at_percent INT DEFAULT 90,     -- Pause new submissions at 90%
  
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  UNIQUE(farm_id, feature_code)
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_caps_farm ON ai_budget_caps(farm_id);

ALTER TABLE ai_budget_caps ENABLE ROW LEVEL SECURITY;

-- Admin only
CREATE POLICY "ai_budget_caps: admin all" ON ai_budget_caps
  FOR ALL USING (is_ddp_admin());

-- ============================================================================
-- ai_cost_alerts: Immutable audit trail of budget alerts
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_cost_alerts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Alert scope
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  
  -- Alert details
  alert_type TEXT NOT NULL CHECK (alert_type IN ('threshold_breach', 'soft_stop', 'hard_stop', 'budget_reset')),
  alert_severity TEXT NOT NULL CHECK (alert_severity IN ('info', 'warning', 'critical')),
  
  -- Cost state at alert time
  current_spend_usd NUMERIC(10, 4) NOT NULL,
  budget_limit_usd NUMERIC(10, 2) NOT NULL,
  percent_of_budget NUMERIC(5, 2) NOT NULL,
  
  -- Action taken
  action_taken TEXT,  -- 'pause_submissions', 'pause_processing', 'alert_sent', etc.
  
  -- Acknowledgement
  acknowledged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  acknowledgement_note TEXT,
  
  -- Immutable audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_cost_alerts_farm ON ai_cost_alerts(farm_id);
CREATE INDEX IF NOT EXISTS idx_ai_cost_alerts_type ON ai_cost_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_ai_cost_alerts_created_at ON ai_cost_alerts(created_at);

ALTER TABLE ai_cost_alerts ENABLE ROW LEVEL SECURITY;

-- Prevent updates/deletes on ai_cost_alerts
CREATE OR REPLACE FUNCTION prevent_ai_cost_alerts_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_cost_alerts is append-only; UPDATE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_cost_alerts_update
  BEFORE UPDATE ON ai_cost_alerts
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_cost_alerts_update();

CREATE OR REPLACE FUNCTION prevent_ai_cost_alerts_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_cost_alerts is append-only; DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_cost_alerts_delete
  BEFORE DELETE ON ai_cost_alerts
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_cost_alerts_delete();

-- ============================================================================
-- RLS for ai_cost_alerts
-- ============================================================================

-- Admin: full access
CREATE POLICY "ai_cost_alerts: admin all" ON ai_cost_alerts
  FOR ALL USING (is_ddp_admin());

-- Farmers: read only, own farm alerts
CREATE POLICY "ai_cost_alerts: farmer own farm read" ON ai_cost_alerts
  FOR SELECT USING (has_farm_membership(farm_id));

-- ============================================================================
-- ACL for functions
-- ============================================================================

REVOKE EXECUTE ON FUNCTION prevent_ai_cost_alerts_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_cost_alerts_update() FROM anon;
-- acl-no-grant: prevent_ai_cost_alerts_update

REVOKE EXECUTE ON FUNCTION prevent_ai_cost_alerts_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_cost_alerts_delete() FROM anon;
-- acl-no-grant: prevent_ai_cost_alerts_delete

-- ============================================================================
-- Grant restrictions
-- ============================================================================

-- Only service role can write to ai_usage_metrics
REVOKE INSERT, UPDATE, DELETE ON ai_usage_metrics FROM authenticated, anon;

-- Only admin can write to ai_budget_caps
REVOKE INSERT, UPDATE, DELETE ON ai_budget_caps FROM authenticated, anon;

-- Only service role can write to ai_cost_alerts
REVOKE INSERT ON ai_cost_alerts FROM authenticated, anon;
REVOKE UPDATE, DELETE ON ai_cost_alerts FROM authenticated, anon;

-- ============================================================================
-- Pricing reference (for cost calculation)
-- Create as a table for version tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_provider_pricing (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Provider and model
  provider TEXT NOT NULL,  -- 'anthropic', 'azure', 'ollama'
  model_name TEXT NOT NULL,
  
  -- Input/output pricing (per 1M tokens)
  input_price_per_1m_tokens NUMERIC(10, 6) NOT NULL,
  output_price_per_1m_tokens NUMERIC(10, 6) NOT NULL,
  
  -- Batch/thinking mode multipliers (if applicable)
  batch_mode_input_discount NUMERIC(5, 4) DEFAULT 1.0,  -- 0.5 for 50% discount
  batch_mode_output_discount NUMERIC(5, 4) DEFAULT 1.0,
  
  thinking_token_price_per_1m NUMERIC(10, 6),           -- Optional for models with thinking
  
  -- Versioning
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_current BOOLEAN DEFAULT true,
  
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_pricing_model ON ai_provider_pricing(provider, model_name);
CREATE INDEX IF NOT EXISTS idx_ai_provider_pricing_current ON ai_provider_pricing(is_current);

-- Populate with initial pricing (Q3 2026)
INSERT INTO ai_provider_pricing (provider, model_name, input_price_per_1m_tokens, output_price_per_1m_tokens, notes)
VALUES
  ('anthropic', 'claude-opus-5', 15.00, 75.00, 'Q3 2026 pricing'),
  ('anthropic', 'claude-sonnet-5', 3.00, 15.00, 'Q3 2026 pricing'),
  ('azure', 'gpt-4-turbo', 10.00, 30.00, 'Q3 2026 pricing estimate')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE ai_usage_metrics IS 'Daily aggregate usage per farm/feature. Used for cost tracking and budget enforcement.';
COMMENT ON TABLE ai_budget_caps IS 'Spending limits per farm/feature. Soft stop pauses submissions; hard stop pauses processing.';
COMMENT ON TABLE ai_cost_alerts IS 'Immutable audit trail of budget alerts and actions taken.';
COMMENT ON TABLE ai_provider_pricing IS 'Pricing reference table for cost calculation. Versioned by effective_date.';

COMMIT;
