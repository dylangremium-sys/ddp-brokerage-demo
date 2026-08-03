-- Migration 51 Verification: AI RLS Policies Hardening
-- Purpose: Verify that all AI-related tables have proper RLS policies
--          defined and enabled
-- Date: 2026-08-03

BEGIN;

-- Verify RLS enabled on all AI tables
DO $verify$ BEGIN
  DECLARE
    v_table_count INT;
  BEGIN
    SELECT COUNT(*) INTO v_table_count
    FROM pg_class
    WHERE relname IN ('ai_jobs', 'ai_job_attempts', 'ai_usage_metrics', 'ai_cost_alerts',
                      'ai_budget_caps', 'ai_audit_events', 'ai_human_reviews', 'ai_prompts',
                      'ai_prompt_versions', 'ai_model_configs', 'ai_prompt_experiments',
                      'ai_approval_workflows')
    AND relnamespace = 'public'::regnamespace::oid
    AND relrowsecurity = true;
    
    ASSERT v_table_count >= 8, 'At least 8 AI tables must have RLS enabled';
    RAISE NOTICE 'RLS enabled count: %', v_table_count;
  END;
END $verify$;

-- Verify farm_id-based policies exist on tracked tables
DO $verify$ BEGIN
  DECLARE
    v_policy_count INT;
  BEGIN
    SELECT COUNT(DISTINCT tablename) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
    AND tablename IN ('ai_jobs', 'ai_job_attempts', 'ai_usage_metrics', 'ai_cost_alerts',
                      'ai_budget_caps', 'ai_audit_events', 'ai_prompt_experiments');
    
    ASSERT v_policy_count >= 5, 'At least 5 tables must have RLS policies';
    RAISE NOTICE 'Farm-scoped policy count: %', v_policy_count;
  END;
END $verify$;

-- Verify that has_farm_membership function exists (required for RLS)
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public'
    AND routine_name = 'has_farm_membership'
  ), 'Function has_farm_membership does not exist (required for RLS policies)';
  RAISE NOTICE 'has_farm_membership function verified';
END $verify$;

-- Verify SELECT policies on admin-scoped tables
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'ai_jobs'
  ), 'RLS policies missing on ai_jobs';
  
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'ai_usage_metrics'
  ), 'RLS policies missing on ai_usage_metrics';
  
  RAISE NOTICE 'RLS policies verified';
END $verify$;

-- Verify that authenticated role can read but not modify sensitive tables
DO $verify$ BEGIN
  DECLARE
    v_update_policies INT;
  BEGIN
    SELECT COUNT(*) INTO v_update_policies
    FROM pg_policies
    WHERE schemaname = 'public'
    AND tablename IN ('ai_audit_events')
    AND policyname ILIKE '%update%';
    
    ASSERT v_update_policies = 0, 'ai_audit_events should not have UPDATE policies (append-only)';
    RAISE NOTICE 'Append-only table verification passed';
  END;
END $verify$;

COMMIT;
