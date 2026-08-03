-- Migration 50 Verification: AI Prompt Registry Hardening
-- Purpose: Verify ai_prompts, ai_prompt_versions, ai_model_configs, and
--          ai_prompt_experiments tables with correct schema
-- Date: 2026-08-03

\set ON_ERROR_STOP on

BEGIN;

-- Verify ai_prompts table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_prompts'
  ), 'Table ai_prompts does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompts' 
    AND column_name = 'id'
  ), 'Column ai_prompts.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompts' 
    AND column_name = 'prompt_key'
  ), 'Column ai_prompts.prompt_key does not exist';
  
  RAISE NOTICE 'ai_prompts table verified';
END $verify$;

-- Verify ai_prompt_versions table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_versions'
  ), 'Table ai_prompt_versions does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_versions' 
    AND column_name = 'id'
  ), 'Column ai_prompt_versions.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_versions' 
    AND column_name = 'prompt_id'
  ), 'Column ai_prompt_versions.prompt_id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_versions' 
    AND column_name = 'version_number'
  ), 'Column ai_prompt_versions.version_number does not exist';
  
  RAISE NOTICE 'ai_prompt_versions table verified';
END $verify$;

-- Verify ai_model_configs table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_model_configs'
  ), 'Table ai_model_configs does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_model_configs' 
    AND column_name = 'id'
  ), 'Column ai_model_configs.id does not exist';
  
  RAISE NOTICE 'ai_model_configs table verified';
END $verify$;

-- Verify ai_prompt_experiments table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_experiments'
  ), 'Table ai_prompt_experiments does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_experiments' 
    AND column_name = 'id'
  ), 'Column ai_prompt_experiments.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_prompt_experiments' 
    AND column_name = 'prompt_id'
  ), 'Column ai_prompt_experiments.prompt_id does not exist';
  
  RAISE NOTICE 'ai_prompt_experiments table verified';
END $verify$;

-- Verify RLS is enabled
DO $verify$ BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_prompts' AND relnamespace = 'public'::regnamespace::oid), 
    'RLS is not enabled on ai_prompts';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_prompt_versions' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_prompt_versions';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_prompt_experiments' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_prompt_experiments';
  RAISE NOTICE 'RLS verified on registry tables';
END $verify$;

COMMIT;
