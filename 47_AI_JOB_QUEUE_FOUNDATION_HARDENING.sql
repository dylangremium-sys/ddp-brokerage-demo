-- Migration 47: AI Job Queue Foundation
-- Purpose: Create async job queue infrastructure for AI feature processing
-- Tables: ai_jobs, ai_job_attempts
-- Status: Hardening (ready for staging/production)
-- Date: 2026-08-02

BEGIN;

-- Ensure RLS is enabled on all new tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;

-- ============================================================================
-- ai_jobs: Job registry (one row per job submitted to queue)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Job identification
  feature_code TEXT NOT NULL, -- 'coa_extraction', 'risk_detection', etc.
  job_type TEXT NOT NULL,     -- 'extraction', 'analysis', 'summary', etc.
  
  -- Resource ownership (RLS key)
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Job state machine
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'timeout')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  -- Job input/output
  input_payload JSONB NOT NULL,         -- Structured input (e.g., PDF URL, fields to extract)
  output_payload JSONB,                 -- Structured result (e.g., extracted fields, confidence scores)
  error_message TEXT,                   -- Error details if failed/timeout
  
  -- Processing metadata
  provider_used TEXT,                   -- 'anthropic' | 'azure' | 'ollama' | 'mock'
  model_used TEXT,                      -- 'claude-opus-5' | 'gpt-4-turbo' | etc.
  attempt_count INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  timeout_seconds INT DEFAULT 60,
  
  -- Cost tracking
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  estimated_cost_usd NUMERIC(10, 4),
  
  -- Audit
  requires_human_review BOOLEAN DEFAULT true,
  human_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  human_review_at TIMESTAMP WITH TIME ZONE,
  human_review_action TEXT,              -- 'approved' | 'rejected' | 'corrected'
  
  -- Versioning
  version INT DEFAULT 1,                 -- Increment on retry/reprocess
  parent_job_id TEXT REFERENCES ai_jobs(id) ON DELETE SET NULL  -- For retry chains
);

CREATE INDEX idx_ai_jobs_farm_id ON ai_jobs(farm_id);
CREATE INDEX idx_ai_jobs_user_id ON ai_jobs(user_id);
CREATE INDEX idx_ai_jobs_status ON ai_jobs(status);
CREATE INDEX idx_ai_jobs_feature ON ai_jobs(feature_code);
CREATE INDEX idx_ai_jobs_created_at ON ai_jobs(created_at);

ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- ai_job_attempts: Append-only retry history (no updates/deletes)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_job_attempts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  
  -- Attempt state
  status TEXT NOT NULL,  -- 'pending', 'processing', 'completed', 'failed', 'timeout'
  started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  -- Provider call details
  provider_used TEXT NOT NULL,
  model_used TEXT NOT NULL,
  request_hash TEXT,  -- SHA256(prompt + input) for deduplication
  
  -- Token usage
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  cost_usd NUMERIC(10, 4),
  
  -- Error tracking (if failed)
  error_code TEXT,
  error_message TEXT,
  
  -- Response payload (truncated if >10KB)
  response_payload JSONB,
  
  -- Immutable audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_job_id FOREIGN KEY(job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
  UNIQUE(job_id, attempt_number)
);

CREATE INDEX idx_ai_job_attempts_job_id ON ai_job_attempts(job_id);
CREATE INDEX idx_ai_job_attempts_status ON ai_job_attempts(status);
CREATE INDEX idx_ai_job_attempts_created_at ON ai_job_attempts(created_at);
CREATE INDEX idx_ai_job_attempts_request_hash ON ai_job_attempts(request_hash);

ALTER TABLE ai_job_attempts ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS Policies for ai_jobs
-- ============================================================================

-- Admin: full access to all jobs
CREATE POLICY "ai_jobs: admin all" ON ai_jobs
  FOR ALL USING (is_ddp_admin());

-- Farmer: read own farm's jobs only
CREATE POLICY "ai_jobs: farmer own farm" ON ai_jobs
  FOR SELECT USING (has_farm_membership(farm_id));

-- Service role (for async processing): INSERT + UPDATE (for status changes)
-- This is enforced via triggers, not policies (runs as service role)

-- ============================================================================
-- RLS Policies for ai_job_attempts
-- ============================================================================

-- Admin: full read access
CREATE POLICY "ai_job_attempts: admin read" ON ai_job_attempts
  FOR SELECT USING (is_ddp_admin());

-- Farmer: read own farm's attempts (via job_id -> ai_jobs -> farm_id)
CREATE POLICY "ai_job_attempts: farmer own farm" ON ai_job_attempts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM ai_jobs WHERE id = job_id AND has_farm_membership(farm_id)
    )
  );

-- ============================================================================
-- Append-only enforcement for ai_job_attempts
-- ============================================================================

-- Prevent UPDATE on ai_job_attempts
CREATE OR REPLACE FUNCTION prevent_ai_job_attempts_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_job_attempts is append-only; UPDATE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_job_attempts_update
  BEFORE UPDATE ON ai_job_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_job_attempts_update();

-- Prevent DELETE on ai_job_attempts
CREATE OR REPLACE FUNCTION prevent_ai_job_attempts_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_job_attempts is append-only; DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ai_job_attempts_delete
  BEFORE DELETE ON ai_job_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_job_attempts_delete();

-- Prevent TRUNCATE on ai_job_attempts
CREATE OR REPLACE FUNCTION prevent_ai_job_attempts_truncate()
RETURNS EVENT TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_job_attempts is append-only; TRUNCATE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER prevent_ai_job_attempts_truncate
  ON ddl_command_start
  WHEN tag IN ('TRUNCATE')
  EXECUTE FUNCTION prevent_ai_job_attempts_truncate();

-- ============================================================================
-- ACL for functions
-- ============================================================================

REVOKE EXECUTE ON FUNCTION prevent_ai_job_attempts_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_job_attempts_update() FROM anon;
-- acl-no-grant: prevent_ai_job_attempts_update

REVOKE EXECUTE ON FUNCTION prevent_ai_job_attempts_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_job_attempts_delete() FROM anon;
-- acl-no-grant: prevent_ai_job_attempts_delete

REVOKE EXECUTE ON FUNCTION prevent_ai_job_attempts_truncate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prevent_ai_job_attempts_truncate() FROM anon;
-- acl-no-grant: prevent_ai_job_attempts_truncate

-- ============================================================================
-- Grant restrictions: prevent non-admin direct mutation
-- ============================================================================

-- Only service role (or explicit admin) can UPDATE ai_jobs status
REVOKE UPDATE ON ai_jobs FROM authenticated, anon;
REVOKE DELETE ON ai_jobs FROM authenticated, anon;

REVOKE INSERT ON ai_job_attempts FROM authenticated, anon;
REVOKE UPDATE ON ai_job_attempts FROM authenticated, anon;
REVOKE DELETE ON ai_job_attempts FROM authenticated, anon;

-- ============================================================================
-- Comments for clarity
-- ============================================================================

COMMENT ON TABLE ai_jobs IS 'Async job registry for AI feature processing. One row per submitted job. Service role updates status as job progresses.';
COMMENT ON TABLE ai_job_attempts IS 'Append-only retry history for ai_jobs. Immutable; no updates/deletes allowed. Triggers enforce constraints.';
COMMENT ON COLUMN ai_jobs.status IS 'Job state: pending → processing → completed/failed/timeout';
COMMENT ON COLUMN ai_jobs.requires_human_review IS 'AI output must be reviewed by human before any consequential action';
COMMENT ON COLUMN ai_job_attempts.request_hash IS 'SHA256(prompt + input) for deduplication and replay protection';

COMMIT;
