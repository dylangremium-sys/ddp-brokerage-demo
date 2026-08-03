#!/bin/bash
# Phase 4: Integration test migrations 47-51 on staging
# Applies migrations in a transaction, verifies schema, then rolls back

set -e

# Source staging database credentials from .pgpass or environment
# ~/.pgpass format: host:port:database:user:password
STAGING_HOST="${STAGING_HOST:-aws-0-eu-west-1.pooler.supabase.com}"
STAGING_PORT="${STAGING_PORT:-5432}"  # Use pooler port (not 6543) for transaction support
STAGING_DB="${STAGING_DB:-postgres}"
STAGING_USER="${STAGING_USER:-postgres.szqocdabwkjrggrddocx}"
STAGING_PASSWORD="${STAGING_PASSWORD}"  # Read from .pgpass if not set

if [ -z "$STAGING_PASSWORD" ] && [ -f "$HOME/.pgpass" ]; then
  # Extract password from .pgpass
  STAGING_PASSWORD=$(grep "^${STAGING_HOST}:${STAGING_PORT}:${STAGING_DB}:${STAGING_USER}:" ~/.pgpass 2>/dev/null | cut -d: -f5)
fi

if [ -z "$STAGING_PASSWORD" ]; then
  echo "ERROR: STAGING_PASSWORD not set and not found in ~/.pgpass"
  exit 1
fi

PGPASSWORD="$STAGING_PASSWORD" psql \
  -h "$STAGING_HOST" \
  -p "$STAGING_PORT" \
  -U "$STAGING_USER" \
  -d "$STAGING_DB" \
  --set ON_ERROR_STOP=on \
  <<EOF
BEGIN TRANSACTION;

-- Apply migrations 47-51 (HARDENING files)
\echo '=== Applying Migration 47: AI Job Queue Foundation ==='
\i 47_AI_JOB_QUEUE_FOUNDATION_HARDENING.sql

\echo '=== Applying Migration 48: AI Cost Tracking ==='
\i 48_AI_COST_TRACKING_HARDENING.sql

\echo '=== Applying Migration 49: AI Audit Logging ==='
\i 49_AI_AUDIT_LOGGING_HARDENING.sql

\echo '=== Applying Migration 50: AI Prompt Registry ==='
\i 50_AI_PROMPT_REGISTRY_HARDENING.sql

\echo '=== Applying Migration 51: AI RLS Policies ==='
\i 51_AI_RLS_POLICIES_HARDENING.sql

-- Run verification queries
\echo '=== Verifying Schema Correctness ==='
\i 47_AI_JOB_QUEUE_FOUNDATION_VERIFY.sql
\i 48_AI_COST_TRACKING_VERIFY.sql
\i 49_AI_AUDIT_LOGGING_VERIFY.sql
\i 50_AI_PROMPT_REGISTRY_VERIFY.sql
\i 51_AI_RLS_POLICIES_VERIFY.sql

-- List created tables
\echo '=== Tables Created ==='
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' AND tablename LIKE 'ai_%'
ORDER BY tablename;

-- Check RLS is enabled on all tables
\echo '=== RLS Status ==='
SELECT tablename, rowsecurity FROM pg_tables 
WHERE schemaname = 'public' AND tablename LIKE 'ai_%'
ORDER BY tablename;

-- Check policies exist
\echo '=== Row Security Policies ==='
SELECT schemaname, tablename, policyname 
FROM pg_policies 
WHERE schemaname = 'public' AND tablename LIKE 'ai_%'
ORDER BY tablename, policyname;

\echo '=== Smoke Test: Insert Job ==='
INSERT INTO public.ai_jobs (
  farm_id, 
  feature_code, 
  status, 
  input_payload, 
  requires_human_review, 
  created_at, 
  updated_at
) VALUES (
  'farm-test-1',
  'compliance_check',
  'pending',
  '{"documentUrl":"https://example.com/doc.pdf"}'::jsonb,
  true,
  NOW(),
  NOW()
) RETURNING id, farm_id, status;

\echo '=== Smoke Test: Insert Usage Metric ==='
INSERT INTO public.ai_usage_metrics (
  farm_id,
  feature_code,
  tokens_used,
  cost_usd,
  recorded_at
) VALUES (
  'farm-test-1',
  'compliance_check',
  250,
  0.015,
  NOW()
) RETURNING farm_id, tokens_used, cost_usd;

\echo '=== Smoke Test: Insert Audit Event ==='
INSERT INTO public.ai_audit_events (
  farm_id,
  event_type,
  event_details,
  recorded_at
) VALUES (
  'farm-test-1',
  'job_submitted',
  '{"jobId":"job-test-1"}'::jsonb,
  NOW()
) RETURNING farm_id, event_type;

-- All checks passed; will rollback at end of transaction
\echo '=== All verifications passed! ==='

ROLLBACK;

\echo '=== Transaction rolled back. Schema is clean. ==='
EOF

echo "Phase 4 complete: Migrations verified on staging and rolled back."
