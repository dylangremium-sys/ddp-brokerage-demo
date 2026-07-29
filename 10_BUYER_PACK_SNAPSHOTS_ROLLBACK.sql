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

-- Wrapped in a transaction so the guard below can abort the WHOLE rollback rather
-- than leaving a half-torn-down state.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Refuse to destroy issued buyer packs unless explicitly authorised.
--
--    buyer_pack_snapshots holds IMMUTABLE issued packs — the frozen record of
--    exactly what each buyer was shown and under whose approval (append-only,
--    protected by prevent_buyer_pack_mutation). buyer_pack_audit_log and
--    buyer_pack_download_log are the matching append-only trails of issuance and
--    of who downloaded what. Dropping these destroys the release history a
--    compliance-sensitive workflow exists to preserve.
--
--    Mirrors the guard migration 24 already uses for evidence data: refuse while
--    rows exist unless the operator opts in deliberately, in the same transaction:
--
--        SET LOCAL buyer_pack.rollback_destructive = 'true';
-- ---------------------------------------------------------------------------
DO $destructive_guard$
DECLARE
  snapshot_count integer := 0;
  audit_count    integer := 0;
  download_count integer := 0;
  opt_in         text;
BEGIN
  IF to_regclass('public.buyer_pack_snapshots') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.buyer_pack_snapshots' INTO snapshot_count;
  END IF;
  IF to_regclass('public.buyer_pack_audit_log') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.buyer_pack_audit_log' INTO audit_count;
  END IF;
  IF to_regclass('public.buyer_pack_download_log') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.buyer_pack_download_log' INTO download_count;
  END IF;

  IF snapshot_count > 0 OR audit_count > 0 OR download_count > 0 THEN
    BEGIN
      opt_in := current_setting('buyer_pack.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN
      opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 10 refused: % issued snapshot(s), % audit event(s) and % download record(s) exist. '
        'Dropping these destroys the immutable record of what was released to buyers, under whose '
        'approval, and who downloaded it. To proceed deliberately, run '
        'SET LOCAL buyer_pack.rollback_destructive = ''true''; in the same transaction.',
        snapshot_count, audit_count, download_count;
    END IF;

    RAISE NOTICE
      'rollback 10: destructive opt-in acknowledged — removing % snapshot(s), % audit event(s), % download record(s).',
      snapshot_count, audit_count, download_count;
  END IF;
END
$destructive_guard$;

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

COMMIT;

-- End of 10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql
