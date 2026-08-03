#!/bin/bash
# Clean up AI tables from staging for re-testing

STAGING_HOST="${STAGING_HOST:-aws-0-eu-west-1.pooler.supabase.com}"
STAGING_PORT="${STAGING_PORT:-5432}"
STAGING_DB="${STAGING_DB:-postgres}"
STAGING_USER="${STAGING_USER:-postgres.szqocdabwkjrggrddocx}"
STAGING_PASSWORD="${STAGING_PASSWORD}"

if [ -z "$STAGING_PASSWORD" ] && [ -f "$HOME/.pgpass" ]; then
  STAGING_PASSWORD=$(grep "^${STAGING_HOST}:${STAGING_PORT}:${STAGING_DB}:${STAGING_USER}:" ~/.pgpass 2>/dev/null | cut -d: -f5)
fi

PGPASSWORD="$STAGING_PASSWORD" psql \
  -h "$STAGING_HOST" \
  -p "$STAGING_PORT" \
  -U "$STAGING_USER" \
  -d "$STAGING_DB" \
  --set ON_ERROR_STOP=on \
  <<EOF2
-- Clean up AI objects
DROP EVENT TRIGGER IF EXISTS prevent_ai_job_attempts_truncate CASCADE;
DROP TABLE IF EXISTS ai_approval_workflows CASCADE;
DROP TABLE IF EXISTS ai_human_reviews CASCADE;
DROP TABLE IF EXISTS ai_audit_events CASCADE;
DROP TABLE IF EXISTS ai_job_attempts CASCADE;
DROP TABLE IF EXISTS ai_jobs CASCADE;
DROP TABLE IF EXISTS ai_budget_caps CASCADE;
DROP TABLE IF EXISTS ai_cost_alerts CASCADE;
DROP TABLE IF EXISTS ai_usage_metrics CASCADE;
DROP TABLE IF EXISTS ai_prompt_experiments CASCADE;
DROP TABLE IF EXISTS ai_prompt_versions CASCADE;
DROP TABLE IF EXISTS ai_model_configs CASCADE;
DROP TABLE IF EXISTS ai_prompts CASCADE;
DROP FUNCTION IF EXISTS get_active_prompt CASCADE;
DROP FUNCTION IF EXISTS get_model_config CASCADE;
DROP FUNCTION IF EXISTS ai_create_audit_event CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_audit_events_delete CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_audit_events_update CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_job_attempts_delete CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_job_attempts_update CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_prompt_versions_delete CASCADE;
DROP FUNCTION IF EXISTS prevent_ai_prompt_versions_update CASCADE;

SELECT 'Cleanup complete';
EOF2
