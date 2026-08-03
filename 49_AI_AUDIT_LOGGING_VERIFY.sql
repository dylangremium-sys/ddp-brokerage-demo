-- Migration 49 Verification: AI Audit Logging Hardening
-- Purpose: Verify ai_audit_events, ai_human_reviews, and ai_approval_workflows
--          tables with correct schema and append-only enforcement
-- Date: 2026-08-03

BEGIN;

-- Verify ai_audit_events table exists (append-only)
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_audit_events'
  ), 'Table ai_audit_events does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_audit_events' 
    AND column_name = 'id'
  ), 'Column ai_audit_events.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_audit_events' 
    AND column_name = 'farm_id'
  ), 'Column ai_audit_events.farm_id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_audit_events' 
    AND column_name = 'event_type'
  ), 'Column ai_audit_events.event_type does not exist';
  
  RAISE NOTICE 'ai_audit_events table verified';
END $verify$;

-- Verify ai_human_reviews table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_human_reviews'
  ), 'Table ai_human_reviews does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_human_reviews' 
    AND column_name = 'id'
  ), 'Column ai_human_reviews.id does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_human_reviews' 
    AND column_name = 'audit_event_id'
  ), 'Column ai_human_reviews.audit_event_id does not exist';
  
  RAISE NOTICE 'ai_human_reviews table verified';
END $verify$;

-- Verify ai_approval_workflows table exists
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'ai_approval_workflows'
  ), 'Table ai_approval_workflows does not exist';
  
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'ai_approval_workflows' 
    AND column_name = 'id'
  ), 'Column ai_approval_workflows.id does not exist';
  
  RAISE NOTICE 'ai_approval_workflows table verified';
END $verify$;

-- Verify RLS is enabled
DO $verify$ BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_audit_events' AND relnamespace = 'public'::regnamespace::oid), 
    'RLS is not enabled on ai_audit_events';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_human_reviews' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_human_reviews';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_approval_workflows' AND relnamespace = 'public'::regnamespace::oid),
    'RLS is not enabled on ai_approval_workflows';
  RAISE NOTICE 'RLS verified on all audit logging tables';
END $verify$;

-- Verify append-only triggers on ai_audit_events
DO $verify$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.triggers 
    WHERE trigger_schema = 'public' AND event_object_table = 'ai_audit_events' 
    AND trigger_name LIKE '%update%'
  ), 'Append-only update trigger missing on ai_audit_events';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.triggers 
    WHERE trigger_schema = 'public' AND event_object_table = 'ai_audit_events' 
    AND trigger_name LIKE '%delete%'
  ), 'Append-only delete trigger missing on ai_audit_events';
  RAISE NOTICE 'Append-only triggers verified on ai_audit_events';
END $verify$;

COMMIT;
