-- =============================================================================
-- Migration 38 — VERIFY: farmer-photos object policies
--
-- READ-ONLY. Catalog SELECTs only — no auth.users fixture, no DML in any section
-- — so like migration 37's VERIFY, and unlike every other VERIFY in this corpus,
-- it is SAFE TO RUN AGAINST PRODUCTION whole, without extracting a prefix.
--
--   Suggested session guard against Production:
--     PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000"
--
-- NOTE: the Supabase SQL Editor does NOT display RAISE NOTICE output, so a passing
-- run there shows "Success. No rows returned" and confirms nothing. Failures DO
-- surface as errors. For a readable check in that environment use the table-
-- returning queries in docs/runbooks/P6_APPLY_MIGRATION_37_BUCKET_PRIVACY.md Step 3.
--
-- Sections:
--   A — farmer-photos policies: COVERAGE and SHAPE, matched on predicate not name
--   B — RLS is enabled on storage.objects, or the policies are decoration
--   C — informational: migration 22's overlay, reported but NOT asserted
--
-- Expected on success: two PASSED notices (A, B), one informational NOTICE (C).
--
-- Section A deliberately does NOT match policy names: the Supabase dashboard emits
-- one policy per operation with a generated suffix, so an exact-name check fails on
-- a correctly-secured database. See its comment block.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Coverage AND shape — matched on PREDICATE, never on policy name.
--
--    WHY NOT MATCH ON NAME. Migration 38 creates one `FOR ALL` admin policy named
--    exactly `farmer-photos: admin all`. The Supabase DASHBOARD — the only route
--    that can create these when the SQL Editor lacks ownership of storage.objects
--    — instead emits ONE POLICY PER OPERATION and appends a generated suffix:
--
--      farmer-photos: admin all 67yeqz_0   SELECT
--      farmer-photos: admin all 67yeqz_1   INSERT
--      farmer-photos: admin all 67yeqz_2   UPDATE
--      farmer-photos: admin all 67yeqz_3   DELETE
--
--    Both shapes are functionally identical. An exact-name check passes for one
--    and FAILS for the other — and it failed for the shape actually applied to
--    Production on 2026-07-30. A verification that reports a false failure on a
--    correctly-secured database is worse than none: the first person to hit it
--    concludes the check is broken and stops trusting it.
--
--    So this asserts the SUBSTANCE instead:
--      * every farmer-facing policy carries the operational-farmer role check,
--      * every farmer-facing write is bound to the uid path prefix,
--      * SELECT and INSERT are each actually reachable by a farmer,
--      * an admin policy covers SELECT and INSERT.
--    Presence alone is insufficient; a policy that exists but omits the role check
--    would satisfy a naive count while leaving the bucket open to a `pending`
--    identity, and an upload policy without the prefix predicate would let one
--    farmer write under another's folder.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  r                 record;
  v_total           integer := 0;
  v_farmer_select   integer := 0;
  v_farmer_insert   integer := 0;
  v_admin_select    integer := 0;
  v_admin_insert    integer := 0;
  v_problems        text[]  := ARRAY[]::text[];
  v_expr            text;
  v_is_admin_policy boolean;
BEGIN
  FOR r IN
    SELECT policyname, permissive, cmd,
           coalesce(qual, '')       AS qual,
           coalesce(with_check, '') AS with_check
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      -- Scope by the BUCKET the policy actually governs, not by its name.
      AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%farmer-photos%'
    ORDER BY policyname
  LOOP
    v_total := v_total + 1;
    v_expr  := r.qual || r.with_check;

    -- A RESTRICTIVE policy here would be migration 22's overlay, which is a
    -- different control and is reported informationally in section C.
    IF r.permissive <> 'PERMISSIVE' THEN
      CONTINUE;
    END IF;

    -- An admin policy gates on is_ddp_admin() and legitimately carries neither
    -- the operational-farmer check nor a path predicate.
    v_is_admin_policy := v_expr LIKE '%is_ddp_admin%'
                     AND v_expr NOT LIKE '%has_operational_farmer_access%';

    IF v_is_admin_policy THEN
      IF r.cmd IN ('ALL', 'SELECT') THEN v_admin_select := v_admin_select + 1; END IF;
      IF r.cmd IN ('ALL', 'INSERT') THEN v_admin_insert := v_admin_insert + 1; END IF;
      CONTINUE;
    END IF;

    -- Everything else is farmer-facing and MUST carry the role check.
    IF v_expr NOT LIKE '%has_operational_farmer_access%' THEN
      v_problems := array_append(v_problems,
        format('%s (%s) omits has_operational_farmer_access() and is not admin-gated — '
               || 'a pending identity would pass', r.policyname, r.cmd));
      CONTINUE;
    END IF;

    -- A farmer-facing policy must be bound to the uid path prefix, or one farmer
    -- could reach another farmer's folder.
    IF v_expr NOT LIKE '%string_to_array%' THEN
      v_problems := array_append(v_problems,
        format('%s (%s) lacks the uid path-prefix predicate', r.policyname, r.cmd));
      CONTINUE;
    END IF;

    IF r.cmd IN ('ALL', 'SELECT') THEN v_farmer_select := v_farmer_select + 1; END IF;
    IF r.cmd IN ('ALL', 'INSERT') THEN v_farmer_insert := v_farmer_insert + 1; END IF;
  END LOOP;

  IF v_total = 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: no policy on storage.objects governs the farmer-photos bucket. '
      'Migration 38 has not been applied by any route. Note RLS is on, so the bucket is '
      'INACCESSIBLE rather than over-exposed — fail-closed, but photo upload will not work.';
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  IF v_farmer_select = 0 OR v_farmer_insert = 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: farmer coverage incomplete — SELECT policies: %, INSERT policies: %. '
      'A farmer must be able to both upload a photo and read it back.',
      v_farmer_select, v_farmer_insert;
  END IF;

  IF v_admin_select = 0 OR v_admin_insert = 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: admin coverage incomplete — SELECT: %, INSERT: %. DDP staff could not '
      'review the evidence farmers upload.', v_admin_select, v_admin_insert;
  END IF;

  RAISE NOTICE
    'VERIFY A PASSED: % policies govern farmer-photos. Farmer SELECT/INSERT are role-checked and '
    'prefix-bound; admin covers SELECT and INSERT. Matched on predicate, so both the migration '
    'shape (one FOR ALL) and the dashboard shape (one per operation, name-suffixed) pass.',
    v_total;
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. RLS must be on, or everything above is decoration.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT c.relrowsecurity INTO v_enabled
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: storage.objects does not exist.';
  END IF;

  IF NOT v_enabled THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: RLS is DISABLED on storage.objects. Every policy verified above is '
      'inert while that is true.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: RLS is enabled on storage.objects.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Informational — migration 22's RESTRICTIVE overlay.
--
--    Reported, NOT asserted. Migration 38 does not install it and must not fail
--    because it is absent; conflating the two would let a green run here be
--    misread as "the storage gap is closed".
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_present boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'farmer buckets: operational farmer or admin'
  ) INTO v_present;

  IF v_present THEN
    RAISE NOTICE 'VERIFY C (informational): migration 22 storage overlay IS present on this database.';
  ELSE
    RAISE NOTICE
      'VERIFY C (informational): migration 22 storage overlay is ABSENT. Migration 38 does not '
      'install it and this is NOT a migration-38 failure — see runbook P4 and '
      'docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md. farmer-documents therefore still lacks a '
      'role check on its own policies, while farmer-photos does not.';
  END IF;
END
$verify_c$;
