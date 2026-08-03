-- Migration 48 Rollback: AI Cost Tracking Hardening
-- Purpose: Safely remove ai_usage_metrics, ai_budget_caps, ai_cost_alerts,
--          and ai_provider_pricing tables
-- Date: 2026-08-03

BEGIN;

-- Drop dependent functions if they exist
DROP FUNCTION IF EXISTS prevent_ai_cost_alerts_update() CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_cost_alerts_delete() CASCADE;

-- Drop tables (CASCADE drops dependent policies and indexes)
DROP TABLE IF EXISTS ai_cost_alerts CASCADE;
DROP TABLE IF EXISTS ai_budget_caps CASCADE;
DROP TABLE IF EXISTS ai_usage_metrics CASCADE;
DROP TABLE IF EXISTS ai_provider_pricing CASCADE;

COMMIT;
