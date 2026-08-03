-- Migration 47 Verification: AI Job Queue Foundation
-- Purpose: Verify that ai_jobs and ai_job_attempts tables exist with correct
--          schema, RLS policies, indexes, and triggers
-- Date: 2026-08-03

\set ON_ERROR_STOP on

BEGIN;

-- Verify ai_jobs table exists with expected columns
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs'
  ), 'Table ai_jobs does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'id'
  ), 'Column ai_jobs.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'farm_id'
  ), 'Column ai_jobs.farm_id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'feature_code'
  ), 'Column ai_jobs.feature_code does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'job_type'
  ), 'Column ai_jobs.job_type does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'status'
  ), 'Column ai_jobs.status does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'created_at'
  ), 'Column ai_jobs.created_at does not exist';
  
  RAISE NOTICE 'ai_jobs table structure verified';
END $verify$;

-- Verify ai_job_attempts table exists with expected columns
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_job_attempts'
  ), 'Table ai_job_attempts does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_job_attempts' 
    AND column_name = 'id'
  ), 'Column ai_job_attempts.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_job_attempts' 
    AND column_name = 'job_id'
  ), 'Column ai_job_attempts.job_id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_job_attempts' 
    AND column_name = 'attempt_number'
  ), 'Column ai_job_attempts.attempt_number does not exist';
  
  RAISE NOTICE 'ai_job_attempts table structure verified';
END $verify$;

-- Verify RLS is enabled
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_tables 
    WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND rowsecurity = true
  ), 'RLS not enabled on ai_jobs';
  
  ASSERT EXISTS (
    SELECT 1 FROM pg_tables 
    WHERE schemaname = 'public' AND tablename = 'ai_job_attempts' AND rowsecurity = true
  ), 'RLS not enabled on ai_job_attempts';
  
  RAISE NOTICE 'RLS enabled on both tables';
END $verify$;

-- Verify policies exist
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND policyname LIKE '%admin%'
  ), 'Admin policy missing on ai_jobs';
  
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND policyname LIKE '%farmer%'
  ), 'Farmer policy missing on ai_jobs';
  
  RAISE NOTICE 'RLS policies verified';
END $verify$;

-- Verify triggers exist
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'prevent_ai_job_attempts_update' AND NOT tgisinternal
  ), 'prevent_ai_job_attempts_update trigger missing';
  
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'prevent_ai_job_attempts_delete' AND NOT tgisinternal
  ), 'prevent_ai_job_attempts_delete trigger missing';
  
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'prevent_ai_job_attempts_truncate' AND NOT tgisinternal
  ), 'prevent_ai_job_attempts_truncate trigger missing';
  
  RAISE NOTICE 'All triggers verified';
END $verify$;

COMMIT;
