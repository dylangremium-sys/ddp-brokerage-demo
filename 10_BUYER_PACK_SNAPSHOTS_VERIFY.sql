-- 10_BUYER_PACK_SNAPSHOTS_VERIFY.sql
-- Verification queries for 10_BUYER_PACK_SNAPSHOTS_MVP.sql.
--
-- STATUS — BY ENVIRONMENT:
--   • STAGING    : V1–V6 executed 2026-07-14. All checks matched expectations.
--   • PRODUCTION : NOT run. Migration 10 is NOT applied to production.
--
-- HOW TO RUN
--   V1–V6 below are ACTIVE and READ-ONLY: catalog SELECTs only. No DDL, no DML,
--   no transaction control, no RPC invocation. They are safe to run directly,
--   against staging or production, at any time:
--
--       psql "$DATABASE_URL" -f 10_BUYER_PACK_SNAPSHOTS_VERIFY.sql
--
--   (Previously every statement in this file was commented out, so running the
--   file was a silent no-op that could be mistaken for a pass. It is now
--   genuinely executable.)
--
--   V7 is a BEHAVIOURAL smoke test that WRITES. It is deliberately left commented
--   out and is NOT part of the default execution path. See the warning above it.
--
-- Expected results are noted inline. If any read-only check disagrees, do not
-- assume the migration succeeded.

-- ---------------------------------------------------------------------------
-- V1. Tables exist with RLS enabled (expect rowsecurity = true for all three)
-- ---------------------------------------------------------------------------
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('buyer_pack_snapshots','buyer_pack_audit_log','buyer_pack_download_log')
order by tablename;

-- ---------------------------------------------------------------------------
-- V2. Policies: snapshots = SELECT only (NO insert); logs = SELECT + INSERT
-- ---------------------------------------------------------------------------
-- Expect 5 rows total:
--   buyer_pack_snapshots    : SELECT                 (and NO INSERT/UPDATE/DELETE)
--   buyer_pack_audit_log    : SELECT + INSERT
--   buyer_pack_download_log : SELECT + INSERT
-- Expect ZERO rows with cmd IN ('UPDATE','DELETE','ALL').
-- Expect ZERO INSERT policy on buyer_pack_snapshots (the RPC is its only writer).
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('buyer_pack_snapshots','buyer_pack_audit_log','buyer_pack_download_log')
order by tablename, cmd;

-- ---------------------------------------------------------------------------
-- V3. Append-only triggers present and enabled (expect 6 rows, tgenabled = 'O')
--     3 row-level UPDATE/DELETE guards + 3 statement-level TRUNCATE guards.
-- ---------------------------------------------------------------------------
select c.relname as table_name, t.tgname, t.tgenabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal
  and t.tgname in (
    'buyer_pack_snapshots_no_update_delete',
    'buyer_pack_audit_log_no_update_delete',
    'buyer_pack_download_log_no_update_delete',
    'buyer_pack_snapshots_no_truncate',
    'buyer_pack_audit_log_no_truncate',
    'buyer_pack_download_log_no_truncate')
order by c.relname, t.tgname;

-- ---------------------------------------------------------------------------
-- V4. Functions exist, are SECURITY DEFINER, and have a pinned search_path
-- ---------------------------------------------------------------------------
-- Expect prosecdef = true for both; proconfig should include a search_path entry.
select p.proname, p.prosecdef, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('prevent_buyer_pack_mutation','issue_buyer_pack_snapshot')
order by p.proname;

-- V4b. The RPC body serializes per pack via an advisory lock (expect true).
select pg_get_functiondef('public.issue_buyer_pack_snapshot(
  text, text, text, timestamptz, text, text, text, jsonb, uuid)'::regprocedure)
  ilike '%pg_advisory_xact_lock%' as has_advisory_lock;

-- ---------------------------------------------------------------------------
-- V5. EXECUTE privileges on the RPC
-- ---------------------------------------------------------------------------
-- Expected PRESENT: authenticated (EXECUTE) — the app calls the RPC as a
--   signed-in admin; the RPC re-asserts the admin gate itself.
-- Expected PRESENT: postgres / service_role — Supabase grants these by default to
--   the owner and service role. This is the platform default, not a finding.
--   (An earlier revision of this file expected service_role to be ABSENT. That
--   expectation was wrong: staging shows it present by default.)
-- Expected ABSENT: anon and PUBLIC. Their presence WOULD be a finding.
select grantee, privilege_type
from information_schema.role_routine_grants
where specific_schema = 'public'
  and routine_name = 'issue_buyer_pack_snapshot'
order by grantee;

-- ---------------------------------------------------------------------------
-- V6. Key constraints present
-- ---------------------------------------------------------------------------
-- Expect: unique (pack_id, version); content_hash shape CHECK;
--         procurement_decision = 'progress' CHECK; approved_by non-empty CHECK.
select conname, contype, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.buyer_pack_snapshots'::regclass
order by contype, conname;

-- ===========================================================================
-- V7. BEHAVIOURAL SMOKE TEST — WRITES. NOT PART OF THE DEFAULT PATH.
-- ===========================================================================
-- ⚠ DO NOT UNCOMMENT INTO THE DEFAULT EXECUTION PATH. Everything below WRITES to
--   the database. It is safe ONLY when run manually, deliberately, and INSIDE A
--   TRANSACTION THAT ENDS IN `rollback;` — never `commit;`, never in an automated
--   pipeline, and never against production without explicit sign-off.
--
--   Staging note (2026-07-14): the equivalent of this section was executed against
--   STAGING inside a rolled-back transaction. It confirmed: the RPC issues a
--   snapshot and the SERVER assigns the version; re-issue appends a new version
--   rather than overwriting; the RPC refuses a non-'progress' decision and an
--   unnamed approver; UPDATE and DELETE on a snapshot are rejected. Residue after
--   rollback: zero rows.
--
-- Run as an authenticated ddp_admin session. Replace the placeholder values.
--
-- begin;
--   -- 7a. Issue v1 via the RPC (content_hash must be 64 lowercase hex chars).
--   select public.issue_buyer_pack_snapshot(
--     'SMOKE-PACK-001',
--     repeat('a', 64),                         -- placeholder hash (shape-valid)
--     'SMOKE-PACK-001:2026-01-01T00:00:00.000Z',
--     '2026-01-01T00:00:00.000Z',
--     'progress',
--     'Smoke Approver',
--     'Smoke Approver',
--     '{"inventory":{"id":"SMOKE-PACK-001"}}'::jsonb,
--     null
--   );
--
--   -- 7b. Issue again → expect version 2, and a pack_superseded row for v1.
--   select public.issue_buyer_pack_snapshot(
--     'SMOKE-PACK-001', repeat('b', 64),
--     'SMOKE-PACK-001:2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
--     'progress','Smoke Approver','Smoke Approver',
--     '{"inventory":{"id":"SMOKE-PACK-001"}}'::jsonb, null
--   );
--
--   -- 7c. Expect versions {1,2} and both preserved.
--   select version, content_hash from public.buyer_pack_snapshots
--   where pack_id = 'SMOKE-PACK-001' order by version;
--
--   -- 7d. Expect pack_generated x2 and pack_superseded x1.
--   select action, snapshot_version from public.buyer_pack_audit_log
--   where pack_id = 'SMOKE-PACK-001' order by created_at;
--
--   -- 7e. Append-only proof: each of these MUST raise an exception.
--   -- update public.buyer_pack_snapshots set approved_by = 'x' where pack_id = 'SMOKE-PACK-001';
--   -- delete from public.buyer_pack_snapshots where pack_id = 'SMOKE-PACK-001';
--   -- truncate public.buyer_pack_snapshots;   -- BEFORE TRUNCATE guard MUST raise
--
--   -- 7f. Gate proof: a non-'progress' decision MUST raise an exception.
--   -- select public.issue_buyer_pack_snapshot(
--   --   'SMOKE-PACK-002', repeat('c',64),
--   --   'id','2026-01-01T00:00:00.000Z','hold','A','A','{}'::jsonb, null);
--
--   -- 7g. Shape proof: a non-64-hex content_hash MUST raise a CHECK violation
--   -- (exercised indirectly; the RPC passes the value straight to the column).
--
--   -- 7h. RPC-bypass proof: a direct client INSERT into buyer_pack_snapshots MUST
--   --     be denied — there is no INSERT policy, so only the SECURITY DEFINER RPC
--   --     can write. Run as a normal authenticated ddp_admin (NOT service_role).
--   -- insert into public.buyer_pack_snapshots (pack_id, version, content_hash,
--   --   approval_id, approval_timestamp, procurement_decision, approved_by,
--   --   generated_by, frozen_evidence)
--   -- values ('SMOKE-PACK-001', 99, repeat('d',64), 'x', now(), 'progress',
--   --   'x', 'x', '{}'::jsonb);   -- expect: RLS denies (permission / 0 rows)
-- rollback;

-- End of 10_BUYER_PACK_SNAPSHOTS_VERIFY.sql
