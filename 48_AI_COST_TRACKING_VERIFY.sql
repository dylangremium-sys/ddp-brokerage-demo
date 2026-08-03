-- Migration 48 Verification: AI Cost Tracking Hardening
-- Purpose: Verify ai_usage_metrics, ai_budget_caps, ai_cost_alerts, and
--          ai_provider_pricing tables with correct schema and RLS
-- Date: 2026-08-03

BEGIN;

-- Verify ai_usage_metrics table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_usage_metrics'
  ), 'Table ai_usage_metrics does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_usage_metrics' 
    AND column_name = 'id'
  ), 'Column ai_usage_metrics.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_usage_metrics' 
    AND column_name = 'farm_id'
  ), 'Column ai_usage_metrics.farm_id does not exist';
  
  RAISE NOTICE 'ai_usage_metrics table verified';
END $verify$;

-- Verify ai_budget_caps table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_budget_caps'
  ), 'Table ai_budget_caps does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_budget_caps' 
    AND column_name = 'id'
  ), 'Column ai_budget_caps.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_budget_caps' 
    AND column_name = 'farm_id'
  ), 'Column ai_budget_caps.farm_id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_budget_caps' 
    AND column_name = 'monthly_limit_usd'
  ), 'Column ai_budget_caps.monthly_limit_usd does not exist';
  
  RAISE NOTICE 'ai_budget_caps table verified';
END $verify$;

-- Verify ai_cost_alerts table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_cost_alerts'
  ), 'Table ai_cost_alerts does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_cost_alerts' 
    AND column_name = 'id'
  ), 'Column ai_cost_alerts.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_cost_alerts' 
    AND column_name = 'farm_id'
  ), 'Column ai_cost_alerts.farm_id does not exist';
  
  RAISE NOTICE 'ai_cost_alerts table verified';
END $verify$;

-- Verify ai_provider_pricing table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_provider_pricing'
  ), 'Table ai_provider_pricing does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_provider_pricing' 
    AND column_name = 'id'
  ), 'Column ai_provider_pricing.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_provider_pricing' 
    AND column_name = 'provider'
  ), 'Column ai_provider_pricing.provider does not exist';
  
  RAISE NOTICE 'ai_provider_pricing table verified';
END $verify$;

-- Verify RLS is enabled on tracked tables
DO $verify$ BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_usage_metrics' AND relnamespace = 'public'::regnamespace::oid), 
    'RLS is not enabled on ai_usage_metrics';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_budget_caps' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_budget_caps';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_cost_alerts' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_cost_alerts';
  RAISE NOTICE 'RLS verified on all tracking tables';
END $verify$;

COMMIT;
