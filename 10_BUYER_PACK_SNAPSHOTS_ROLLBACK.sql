-- 10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql
-- Rollback for 10_BUYER_PACK_SNAPSHOTS_MVP.sql.
--
-- STATUS: DRAFT — FOR REVIEW ONLY. NOT APPLIED. NOT RUN.
--
-- WARNING: dropping public.buyer_pack_snapshots (and the two log tables)
-- permanently deletes every issued Buyer Pack snapshot, audit event, and
-- download record. Those tables are append-only by design; this rollback is the
-- ONLY sanctioned way to remove them, and it destroys their contents. Run it
-- only as a deliberate, approved teardown of Buyer Pack Phase B — never as an
-- automatic or routine step.
--
-- This migration is purely additive (new tables + trigger fn + RPC), so this
-- rollback simply removes exactly what 10_BUYER_PACK_SNAPSHOTS_MVP.sql created,
-- in reverse dependency order. It does not touch any pre-existing object
-- (profiles, inventory_batches, is_ddp_admin, or any other table/policy).

-- 1. RPC
DROP FUNCTION IF EXISTS public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID);

-- 2. Append-only triggers (must drop before the shared trigger function).
--    Both the row-level UPDATE/DELETE guards and the statement-level TRUNCATE
--    guards are removed here.
DROP TRIGGER IF EXISTS buyer_pack_snapshots_no_update_delete   ON public.buyer_pack_snapshots;
DROP TRIGGER IF EXISTS buyer_pack_audit_log_no_update_delete   ON public.buyer_pack_audit_log;
DROP TRIGGER IF EXISTS buyer_pack_download_log_no_update_delete ON public.buyer_pack_download_log;
DROP TRIGGER IF EXISTS buyer_pack_snapshots_no_truncate        ON public.buyer_pack_snapshots;
DROP TRIGGER IF EXISTS buyer_pack_audit_log_no_truncate        ON public.buyer_pack_audit_log;
DROP TRIGGER IF EXISTS buyer_pack_download_log_no_truncate     ON public.buyer_pack_download_log;

-- 3. Shared trigger function
DROP FUNCTION IF EXISTS public.prevent_buyer_pack_mutation();

-- 4. RLS policies (dropped automatically with the tables, but listed explicitly
--    for reviewability and in case a table is retained during a partial rollback)
DROP POLICY IF EXISTS "buyer_pack_snapshots: admin select"    ON public.buyer_pack_snapshots;
DROP POLICY IF EXISTS "buyer_pack_snapshots: admin insert"    ON public.buyer_pack_snapshots;
DROP POLICY IF EXISTS "buyer_pack_audit_log: admin select"    ON public.buyer_pack_audit_log;
DROP POLICY IF EXISTS "buyer_pack_audit_log: admin insert"    ON public.buyer_pack_audit_log;
DROP POLICY IF EXISTS "buyer_pack_download_log: admin select" ON public.buyer_pack_download_log;
DROP POLICY IF EXISTS "buyer_pack_download_log: admin insert" ON public.buyer_pack_download_log;

-- 5. Tables (snapshots last: buyer_pack_snapshots has a self-referencing FK, so
--    dropping the table drops that FK; the two log tables have no FK to it).
DROP TABLE IF EXISTS public.buyer_pack_download_log;
DROP TABLE IF EXISTS public.buyer_pack_audit_log;
DROP TABLE IF EXISTS public.buyer_pack_snapshots;

-- End of 10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql
