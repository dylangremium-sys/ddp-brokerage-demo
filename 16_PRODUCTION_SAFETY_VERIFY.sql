-- ===========================================================================
-- 16_PRODUCTION_SAFETY_VERIFY.sql
-- ---------------------------------------------------------------------------
-- READ-ONLY production safety verification. Run in the Supabase SQL Editor
-- against PRODUCTION.
--
-- This file is STRICTLY read-only:
--   • No DDL. No DML. No CREATE, ALTER, DROP, GRANT, INSERT, UPDATE, DELETE.
--   • Every statement is a SELECT against a catalog view.
--   • Safe to run at any time, including during traffic.
--
-- WHY THIS FILE EXISTS
-- The audit could not determine the live security posture from source alone,
-- because there is no migration ledger: ~20 .sql files sit in the repo root and
-- are applied by hand, so "what is in the repo" and "what is in production" are
-- different questions. FARM_ADMIN_ROLE_CHECK_FIX.sql:10-25 already documents one
-- confirmed divergence (a validation doc records a trigger as applied; the live
-- database says it does not exist).
--
-- Q1 is the single most important query in this file. Run it first.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Q1. *** THE SELF-CERTIFICATION QUESTION *** — run this first.
-- ---------------------------------------------------------------------------
-- Policy "farms: farmer update own" (FARM_RESAVE_PERSISTENCE_MIGRATION.sql:104-126)
-- restricts WHICH ROWS a farmer may update, but NOT WHICH COLUMNS: its USING and
-- WITH CHECK assert only farm membership. The only thing preventing a farmer from
-- writing status / compliance_status / risk_level / partner_tier on their own farm
-- is the trigger trg_protect_farm_admin_fields.
--
-- INTERPRETING THE RESULT:
--   policy present  AND trigger present  -> SAFE (guard is enforcing)
--   policy present  AND trigger ABSENT   -> *** LIVE PRIVILEGE ESCALATION ***
--                                           a farmer can approve their own farm
--   policy ABSENT                        -> no farmer UPDATE path at all (safe,
--                                           but farm re-save is presumably broken)
SELECT
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farms'
       AND cmd = 'UPDATE')                                   AS farm_update_policies,
  (SELECT count(*) FROM pg_trigger
     WHERE tgrelid = 'public.farms'::regclass
       AND NOT tgisinternal
       AND tgname = 'trg_protect_farm_admin_fields')         AS protect_trigger_present,
  (SELECT count(*) FROM pg_proc
     WHERE proname = 'fn_protect_farm_admin_fields')         AS protect_function_present,
  CASE
    WHEN (SELECT count(*) FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'farms' AND cmd = 'UPDATE') = 0
      THEN 'SAFE — no farmer UPDATE policy on farms'
    WHEN (SELECT count(*) FROM pg_trigger
            WHERE tgrelid = 'public.farms'::regclass AND NOT tgisinternal
              AND tgname = 'trg_protect_farm_admin_fields') > 0
      THEN 'SAFE — UPDATE policy is guarded by trg_protect_farm_admin_fields'
    ELSE '*** ESCALATION RISK — farmer UPDATE policy is LIVE and the column guard is ABSENT ***'
  END                                                        AS verdict;


-- ---------------------------------------------------------------------------
-- Q2. Full policy text for public.farms (read the WITH CHECK by eye).
-- ---------------------------------------------------------------------------
-- Confirm whether any UPDATE policy restricts columns. RLS cannot restrict
-- columns directly — column-level GRANTs or a trigger are the only mechanisms.
SELECT policyname, cmd, roles, qual AS using_expr, with_check AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'farms'
ORDER BY cmd, policyname;


-- ---------------------------------------------------------------------------
-- Q3. Is RLS actually ENABLED (and FORCED) on every public table?
-- ---------------------------------------------------------------------------
-- RLS is the ONLY authorisation layer in this architecture: the browser talks
-- to Postgres directly with the anon key. A single table with relrowsecurity =
-- false is a full read/write hole for any authenticated user.
-- Expect: rls_enabled = true for every application table. policy_count = 0 with
-- rls_enabled = true means the table is locked to everyone (deny-all).
SELECT
  c.relname                                   AS table_name,
  c.relrowsecurity                            AS rls_enabled,
  c.relforcerowsecurity                       AS rls_forced,
  (SELECT count(*) FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
  CASE WHEN NOT c.relrowsecurity THEN '*** RLS DISABLED — OPEN TABLE ***' ELSE 'ok' END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relrowsecurity ASC, c.relname;


-- ---------------------------------------------------------------------------
-- Q4. Who can self-elevate? Policy text for public.profiles.
-- ---------------------------------------------------------------------------
-- The UPDATE policy MUST pin the role column, e.g.
--   WITH CHECK (id = auth.uid() AND role = (SELECT role FROM profiles WHERE id = auth.uid()))
-- If any UPDATE policy on profiles lacks a role predicate in with_check, a
-- farmer can set role='ddp_admin' on their own row and become an admin.
-- NOTE: profiles_role_check (role IN ('ddp_admin','farmer')) does NOT protect
-- you here — 'ddp_admin' is a permitted value.
SELECT policyname, cmd, qual AS using_expr, with_check AS with_check_expr,
  CASE
    WHEN cmd = 'UPDATE' AND (with_check IS NULL OR with_check NOT LIKE '%role%')
      THEN '*** UPDATE policy does not pin the role column ***'
    ELSE 'ok'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY cmd, policyname;


-- ---------------------------------------------------------------------------
-- Q5. RPC / function EXECUTE permissions.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER functions run as their OWNER and bypass RLS. Any such
-- function executable by 'anon' or 'authenticated' is an authorisation
-- boundary. Trigger-only functions (prevent_*, fn_protect_*) must NOT be
-- directly executable by anyone.
SELECT
  p.proname                                            AS function_name,
  p.prosecdef                                          AS security_definer,
  pg_get_function_identity_arguments(p.oid)            AS args,
  has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  CASE
    WHEN p.proname LIKE 'prevent_%' OR p.proname LIKE 'fn_protect_%'
      THEN CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE')
                THEN '*** trigger-only function is directly EXECUTABLE ***' ELSE 'ok' END
    WHEN p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
      THEN '*** SECURITY DEFINER executable by anon ***'
    ELSE 'ok'
  END                                                  AS verdict
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, p.proname;


-- ---------------------------------------------------------------------------
-- Q6. Is the Buyer Pack snapshot infrastructure actually deployed?
-- ---------------------------------------------------------------------------
-- The application does not currently call issue_buyer_pack_snapshot() at all
-- (verified: zero `.rpc(` invocations in src/). Before wiring it up, confirm
-- migration 10 is really live in production. If any row below reports MISSING,
-- 10_BUYER_PACK_SNAPSHOTS_MVP.sql has not been applied here.
SELECT 'table  buyer_pack_snapshots'  AS object,
       to_regclass('public.buyer_pack_snapshots')  IS NOT NULL AS present
UNION ALL SELECT 'table  buyer_pack_audit_log',
       to_regclass('public.buyer_pack_audit_log')  IS NOT NULL
UNION ALL SELECT 'table  buyer_pack_download_log',
       to_regclass('public.buyer_pack_download_log') IS NOT NULL
UNION ALL SELECT 'table  procurement_decisions (migration 17)',
       to_regclass('public.procurement_decisions') IS NOT NULL
UNION ALL SELECT 'rpc    issue_buyer_pack_snapshot',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'issue_buyer_pack_snapshot')
UNION ALL SELECT 'trig   prevent_buyer_pack_mutation',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'prevent_buyer_pack_mutation');


-- ---------------------------------------------------------------------------
-- Q7. Missing indexes on core tables (performance, not security).
-- ---------------------------------------------------------------------------
-- Verified in the audit: the six core tables carry no index beyond their PK,
-- while the data layer issues SELECT * with no LIMIT. These are the foreign
-- keys that will table-scan as row counts grow.
SELECT c.relname AS table_name,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)     AS index_count,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS pk_count,
       CASE WHEN (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) <= 1
            THEN 'only a primary key — FK lookups will sequential-scan'
            ELSE 'ok' END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('farms','inventory_batches','farm_profiles',
                    'farm_memberships','profiles','documents')
ORDER BY c.relname;


-- ---------------------------------------------------------------------------
-- Q8. Which tables are actually holding data? (Dead-schema check.)
-- ---------------------------------------------------------------------------
-- The audit found 8 tables with zero writers in src/. A live row count of 0
-- confirms the control they represent is not operating. Note in particular
-- buyer_pack_snapshots: migrations 11/15 harden the audit trail, but if this is
-- empty then no buyer pack has ever been immutably recorded.
SELECT relname AS table_name, n_live_tup AS approx_rows
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup ASC, relname;
