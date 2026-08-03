-- Migration 49: AI Audit Logging & Governance
-- Purpose: Immutable audit trail for all AI operations and human approvals
-- Tables: ai_audit_events, ai_human_reviews
-- Status: Hardening
-- Date: 2026-08-02

BEGIN;

-- ============================================================================
-- ai_audit_events: Immutable audit log for all AI operations
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_audit_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Event classification
  event_type TEXT NOT NULL,  -- 'job_submitted', 'job_completed', 'job_failed', 
                             -- 'human_review_started', 'human_review_completed',
                             -- 'cost_alert', 'budget_exceeded', 'model_changed', etc.
  
  -- Resource being audited
  job_id TEXT REFERENCES ai_jobs(id) ON DELETE SET NULL,
  farm_id UUID REFERENCES farms(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- Context
  feature_code TEXT NOT NULL,  -- 'coa_extraction', 'risk_detection', etc.
  
  -- Event payload (structured)
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  
  -- Who triggered this event
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role TEXT,  -- 'admin', 'farmer', 'system', 'service'
  
  -- Before/after state (for compliance)
  before_state JSONB,
  after_state JSONB,
  
  -- Data sensitivity flags
  contains_pii BOOLEAN DEFAULT false,
  requires_log_redaction BOOLEAN DEFAULT false,
  
  -- Immutable audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  -- Tamper detection
  event_hash TEXT,  -- SHA256 of event row for audit verification
  
  CONSTRAINT fk_job FOREIGN KEY(job_id) REFERENCES ai_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_events_job_id ON ai_audit_events(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_events_farm_id ON ai_audit_events(farm_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_events_user_id ON ai_audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_events_type ON ai_audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ai_audit_events_feature ON ai_audit_events(feature_code);
CREATE INDEX IF NOT EXISTS idx_ai_audit_events_created_at ON ai_audit_events(created_at);

ALTER TABLE ai_audit_events ENABLE ROW LEVEL SECURITY;

-- Prevent UPDATE/DELETE on ai_audit_events
CREATE OR REPLACE FUNCTION prevent_ai_audit_events_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_audit_events is append-only; UPDATE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_audit_events_update
  BEFORE UPDATE ON ai_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_audit_events_update();

CREATE OR REPLACE FUNCTION prevent_ai_audit_events_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_audit_events is append-only; DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_audit_events_delete
  BEFORE DELETE ON ai_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_audit_events_delete();

-- ============================================================================
-- ai_human_reviews: Track all human approvals/rejections of AI outputs
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_human_reviews (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  job_id TEXT NOT NULL UNIQUE REFERENCES ai_jobs(id) ON DELETE CASCADE,
  
  -- Human reviewer details
  reviewed_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  -- Review decision
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'corrected', 'escalated')),
  
  -- Review details
  summary TEXT,  -- Human's notes
  
  -- Corrections applied (if decision='corrected')
  corrections_applied JSONB,  -- Field-by-field corrections
  
  -- Escalation details (if decision='escalated')
  escalation_reason TEXT,
  escalated_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- Approval chain (for multi-level review)
  requires_additional_review BOOLEAN DEFAULT false,
  secondary_reviewer_required TEXT,  -- 'compliance_team', 'legal', etc.
  
  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_human_reviews_job_id ON ai_human_reviews(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_human_reviews_reviewed_by ON ai_human_reviews(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_ai_human_reviews_decision ON ai_human_reviews(decision);
CREATE INDEX IF NOT EXISTS idx_ai_human_reviews_created_at ON ai_human_reviews(created_at);

ALTER TABLE ai_human_reviews ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "ai_human_reviews: admin all" ON ai_human_reviews
  FOR ALL USING (is_ddp_admin());

-- Reviewer: read own reviews
CREATE POLICY "ai_human_reviews: reviewer own" ON ai_human_reviews
  FOR SELECT USING (reviewed_by = auth.uid());

-- ============================================================================
-- ai_approval_workflows: Define approval gates per feature/action type
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_approval_workflows (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Workflow scope
  feature_code TEXT NOT NULL,
  action_type TEXT NOT NULL,  -- 'extraction_approval', 'risk_escalation', 'buyer_pack_release', etc.
  
  -- Approval requirement
  requires_approval BOOLEAN DEFAULT true,
  approval_role TEXT NOT NULL,  -- 'admin', 'compliance_team', 'legal', 'finance'
  
  -- SLA
  approval_sla_hours INT DEFAULT 24,
  auto_escalate_if_not_approved BOOLEAN DEFAULT true,
  
  -- Multi-level approval
  requires_secondary_approval BOOLEAN DEFAULT false,
  secondary_approval_role TEXT,
  
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  UNIQUE(feature_code, action_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_approval_workflows_feature ON ai_approval_workflows(feature_code);

ALTER TABLE ai_approval_workflows ENABLE ROW LEVEL SECURITY;

-- Admin only
CREATE POLICY "ai_approval_workflows: admin all" ON ai_approval_workflows
  FOR ALL USING (is_ddp_admin());

-- ============================================================================
-- ACL for functions
-- ============================================================================

REVOKE EXECUTE ON FUNCTION prevent_ai_audit_events_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_audit_events_update() FROM anon;
-- acl-no-grant: prevent_ai_audit_events_update

REVOKE EXECUTE ON FUNCTION prevent_ai_audit_events_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_audit_events_delete() FROM anon;
-- acl-no-grant: prevent_ai_audit_events_delete


-- ============================================================================
-- Grant restrictions
-- ============================================================================

-- Only service role can write to ai_audit_events
REVOKE INSERT ON ai_audit_events FROM authenticated, anon;
REVOKE UPDATE, DELETE ON ai_audit_events FROM authenticated, anon;

-- Only admin can write to ai_human_reviews
REVOKE INSERT, UPDATE, DELETE ON ai_human_reviews FROM authenticated, anon;

-- Only admin can write to ai_approval_workflows
REVOKE INSERT, UPDATE, DELETE ON ai_approval_workflows FROM authenticated, anon;

-- ============================================================================
-- Helper function: Create audit event
-- ============================================================================
CREATE OR REPLACE FUNCTION ai_create_audit_event(
  p_event_type TEXT,
  p_job_id TEXT DEFAULT NULL,
  p_farm_id UUID DEFAULT NULL,
  p_feature_code TEXT DEFAULT NULL,
  p_event_data JSONB DEFAULT '{}'::jsonb,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_role TEXT DEFAULT 'system'
)
RETURNS TEXT AS $$
DECLARE
  v_event_id TEXT;
BEGIN
  INSERT INTO ai_audit_events (
    event_type,
    job_id,
    farm_id,
    feature_code,
    event_data,
    actor_user_id,
    actor_role
  ) VALUES (
    p_event_type,
    p_job_id,
    p_farm_id,
    p_feature_code,
    p_event_data,
    p_actor_user_id,
    COALESCE(p_actor_role, 'system')
  )
  RETURNING id INTO v_event_id;
  
  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================

-- Restrict access to ai_create_audit_event
REVOKE EXECUTE ON FUNCTION ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ai_create_audit_event(TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT) FROM anon;
-- acl-no-grant: ai_create_audit_event
-- Comments
-- ============================================================================

COMMENT ON TABLE ai_audit_events IS 'Immutable audit log for all AI operations. Service role writes; append-only.';
COMMENT ON TABLE ai_human_reviews IS 'Track all human approvals, rejections, and corrections of AI outputs.';
COMMENT ON TABLE ai_approval_workflows IS 'Define approval gates and SLAs for AI feature actions.';
COMMENT ON FUNCTION ai_create_audit_event IS 'Helper to create audit events. Service role uses this during job processing.';

COMMIT;
