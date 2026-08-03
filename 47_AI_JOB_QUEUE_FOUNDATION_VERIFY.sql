-- Migration 47 Verification: AI Job Queue Foundation
-- Purpose: Verify that ai_jobs and ai_job_attempts tables exist with correct
--          schema, RLS policies, indexes, and triggers
-- Date: 2026-08-03

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
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_jobs' 
    AND column_name = 'updated_at'
  ), 'Column ai_jobs.updated_at does not exist';
  
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

-- Verify RLS is enabled on both tables
DO $verify$ BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_jobs' AND relnamespace = 'public'::regnamespace::oid), 
    'RLS is not enabled on ai_jobs';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_job_attempts' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_job_attempts';
  RAISE NOTICE 'RLS verified on both tables';
END $verify$;

-- Verify RLS policies exist
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND policyname LIKE '%select%'
  ), 'SELECT policy missing on ai_jobs';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND policyname LIKE '%insert%'
  ), 'INSERT policy missing on ai_jobs';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_job_attempts' AND policyname LIKE '%select%'
  ), 'SELECT policy missing on ai_job_attempts';
  RAISE NOTICE 'RLS policies verified';
END $verify$;

-- Verify indexes exist
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND indexname LIKE '%farm_id%'
  ), 'Index on ai_jobs.farm_id does not exist';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_jobs' AND indexname LIKE '%created_at%'
  ), 'Index on ai_jobs.created_at does not exist';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_job_attempts' AND indexname LIKE '%job_id%'
  ), 'Index on ai_job_attempts.job_id does not exist';
  RAISE NOTICE 'Indexes verified';
END $verify$;

-- Verify triggers exist (append-only enforcement)
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.triggers 
    WHERE trigger_schema = 'public' AND event_object_table = 'ai_job_attempts' 
    AND trigger_name LIKE '%update%'
  ), 'Append-only update trigger missing on ai_job_attempts';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.triggers 
    WHERE trigger_schema = 'public' AND event_object_table = 'ai_job_attempts' 
    AND trigger_name LIKE '%delete%'
  ), 'Append-only delete trigger missing on ai_job_attempts';
  RAISE NOTICE 'Append-only triggers verified';
END $verify$;

COMMIT;
