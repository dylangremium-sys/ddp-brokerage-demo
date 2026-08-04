-- Migration 51 Rollback: AI RLS Policies Hardening
-- Purpose: Disable RLS on AI tables and drop associated policies
-- Date: 2026-08-03
-- Note: This migration is primarily policy definitions. Reverting it
--       disables RLS enforcement on the tables. Use with caution.

BEGIN;

-- Disable RLS ONLY where migration 51 is what enabled it.
--
-- This block previously disabled RLS on all twelve of the tables created by
-- migrations 47-50. Those migrations enable RLS themselves, so 51 found it
-- already on and changed nothing -- and this rollback therefore did not undo
-- migration 51, it silently stripped row-level security from twelve tables that
-- 47-50 had secured, while leaving 47-50 applied. The only table whose RLS this
-- migration actually switched on is ai_provider_pricing.
--
-- Proven by scripts/disposable-pg fixture 51_ai_rls_policies: the catalog
-- snapshot recorded twelve tables going enabled -> disabled across the rollback
-- and ai_provider_pricing going disabled -> enabled, i.e. exactly inverted.
ALTER TABLE IF EXISTS ai_provider_pricing DISABLE ROW LEVEL SECURITY;

COMMIT;
