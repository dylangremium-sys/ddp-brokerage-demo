-- ===========================================================================
-- 18_SYNTHETIC_RUNTIME_VERIFY.sql
-- ---------------------------------------------------------------------------
-- Post-migration SYNTHETIC runtime verification for migrations 10 and 17.
--
-- Proves, against a live database, that the guarantees the schema *claims* are
-- actually *enforced*: append-only, mandatory reason, server-captured actor, the
-- seven-value decision set, the snapshot RPC's gates, and snapshot immutability.
-- The paired VERIFY scripts (10_/17_) inspect the catalog; this one exercises the
-- behaviour. Both are needed — a trigger can exist and still not fire.
--
-- ===========================================================================
-- ⚠  READ THIS BEFORE RUNNING. THIS FILE WRITES.
-- ===========================================================================
--   • MANUAL USE ONLY. Never run this in an automated pipeline, CI job, cron,
--     or migration runner.
--   • VERIFY THE PROJECT REFERENCE FIRST. Confirm in the dashboard that you are
--     connected to the database you intend to test. Pasting this into the wrong
--     project is the one way it can do harm.
--   • NEVER REMOVE EITHER `ROLLBACK`. They are the only reason this file is safe.
--     There is no COMMIT anywhere in this file, and there must never be one.
--   • NEVER SUBSTITUTE REAL BATCH IDs, pack ids, or approver names. Every
--     identifier below is deliberately synthetic and prefixed 'SYNTHETIC-'.
--   • It touches NO existing row. It INSERTs only rows it creates itself, and
--     both transactions are rolled back, so residue is zero BY CONSTRUCTION.
--
-- REQUIREMENTS
--   • Run as the table owner / postgres (the SQL Editor's default). The script
--     impersonates a ddp_admin only where the RPC's own gate requires it, and it
--     scopes that impersonation with SET LOCAL, so it dies with the transaction.
--   • At least one profiles row with role = 'ddp_admin' must exist. If none does,
--     the script says so and skips rather than inventing an actor.
--
-- EVIDENCE
--   Every check emits `PASS` or `*** FAIL` via RAISE NOTICE with the test name and
--   the observed result. Each block counts failures and RAISEs at the end if any
--   occurred, so a failure is loud and cannot be scrolled past.
-- ===========================================================================


-- ===========================================================================
-- BLOCK 1 — PROCUREMENT DECISIONS (migration 17)
-- ===========================================================================
BEGIN;

DO $block1$
DECLARE
  admin_id   UUID;
  synth_batch TEXT := 'SYNTHETIC-DECISION-BATCH-DO-NOT-USE';
  failures   INT  := 0;
  n          INT;
  v          TEXT;
  decisions  TEXT[] := ARRAY[
    'progress','hold','reject',
    'request_documents','request_fresh_coa','request_inventory_proof','escalate_review'
  ];
BEGIN
  SELECT id INTO admin_id FROM public.profiles WHERE role = 'ddp_admin' LIMIT 1;
  IF admin_id IS NULL THEN
    RAISE NOTICE 'SKIP  no ddp_admin profile exists — cannot supply a valid actor. Block 1 not run.';
    RETURN;
  END IF;

  -- T1. All seven valid decision values must insert. The list above must match
  --     the live CHECK exactly; if the constraint and this array ever diverge,
  --     this test fails, which is the point.
  BEGIN
    INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by, decided_at)
    SELECT synth_batch || '-' || d, d, 'synthetic verification', admin_id, NOW()
    FROM unnest(decisions) AS d;
    SELECT count(*) INTO n FROM public.procurement_decisions WHERE batch_id LIKE synth_batch || '%';
    IF n = 7 THEN
      RAISE NOTICE 'PASS  T1 all seven decision values accepted (%)', n;
    ELSE
      RAISE NOTICE '*** FAIL T1 expected 7 rows, got %', n; failures := failures + 1;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '*** FAIL T1 a valid decision value was rejected: %', SQLERRM; failures := failures + 1;
  END;

  -- T2. An invalid decision value must be refused by the CHECK constraint.
  BEGIN
    INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by)
    VALUES (synth_batch, 'totally_approved', 'synthetic', admin_id);
    RAISE NOTICE '*** FAIL T2 an INVALID decision value was ACCEPTED'; failures := failures + 1;
  EXCEPTION
    WHEN check_violation THEN RAISE NOTICE 'PASS  T2 invalid decision value refused (check_violation)';
    WHEN others THEN RAISE NOTICE '*** FAIL T2 refused, but with the wrong error: %', SQLERRM; failures := failures + 1;
  END;

  -- T3. An empty / whitespace-only reason must be refused. A decision with no
  --     stated reason is not an audit record.
  BEGIN
    INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by)
    VALUES (synth_batch, 'progress', '   ', admin_id);
    RAISE NOTICE '*** FAIL T3 an EMPTY reason was ACCEPTED'; failures := failures + 1;
  EXCEPTION
    WHEN check_violation THEN RAISE NOTICE 'PASS  T3 empty reason refused (check_violation)';
    WHEN others THEN RAISE NOTICE '*** FAIL T3 refused, but with the wrong error: %', SQLERRM; failures := failures + 1;
  END;

  -- T4. A NULL actor must be refused. Attribution is not optional.
  BEGIN
    INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by)
    VALUES (synth_batch, 'progress', 'synthetic', NULL);
    RAISE NOTICE '*** FAIL T4 a NULL actor was ACCEPTED'; failures := failures + 1;
  EXCEPTION
    WHEN not_null_violation THEN RAISE NOTICE 'PASS  T4 NULL actor refused (not_null_violation)';
    WHEN others THEN RAISE NOTICE '*** FAIL T4 refused, but with the wrong error: %', SQLERRM; failures := failures + 1;
  END;

  -- T5. UPDATE must be rejected by the append-only trigger. Run as owner so RLS
  --     is not what denies it — this proves the TRIGGER fires, not just the policy.
  BEGIN
    UPDATE public.procurement_decisions
       SET decision = 'reject'
     WHERE batch_id = synth_batch || '-progress';
    RAISE NOTICE '*** FAIL T5 UPDATE was ALLOWED — append-only is NOT enforced'; failures := failures + 1;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  T5 UPDATE rejected: %', SQLERRM;
  END;

  -- T6. DELETE must be rejected by the same trigger.
  BEGIN
    DELETE FROM public.procurement_decisions WHERE batch_id = synth_batch || '-progress';
    RAISE NOTICE '*** FAIL T6 DELETE was ALLOWED — append-only is NOT enforced'; failures := failures + 1;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  T6 DELETE rejected: %', SQLERRM;
  END;

  -- T7. The current-decision view must resolve the NEWEST row per batch.
  --     decided_at is set explicitly (NOW() is the transaction timestamp, so two
  --     rows inserted in one transaction would otherwise tie and the DISTINCT ON
  --     ordering would be arbitrary).
  INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by, decided_at)
  VALUES (synth_batch || '-view', 'hold',     'older synthetic decision', admin_id, NOW() - INTERVAL '2 hours'),
         (synth_batch || '-view', 'progress', 'newer synthetic decision', admin_id, NOW() - INTERVAL '1 hour');

  SELECT decision INTO v
    FROM public.procurement_decisions_current
   WHERE batch_id = synth_batch || '-view';

  IF v = 'progress' THEN
    RAISE NOTICE 'PASS  T7 current-decision view resolves newest-per-batch (progress)';
  ELSE
    RAISE NOTICE '*** FAIL T7 view returned % — expected the NEWER row (progress)', COALESCE(v, 'NULL');
    failures := failures + 1;
  END IF;

  -- T8. Synthetic row count inside the transaction (7 + 2 view rows = 9).
  SELECT count(*) INTO n FROM public.procurement_decisions WHERE batch_id LIKE synth_batch || '%';
  RAISE NOTICE 'INFO  T8 synthetic decision rows inside the transaction: % (all discarded by ROLLBACK)', n;

  IF failures > 0 THEN
    RAISE EXCEPTION 'BLOCK 1 FAILED: % check(s) failed — see the *** FAIL notices above', failures;
  END IF;
  RAISE NOTICE 'BLOCK 1 COMPLETE — all procurement-decision checks passed';
END
$block1$;

-- The ONLY correct ending. Never COMMIT. Never remove this line.
ROLLBACK;

-- Residue proof for block 1: every synthetic decision row must be gone.
SELECT 'RESIDUE decisions' AS check,
       count(*) AS synthetic_rows_remaining,
       CASE WHEN count(*) = 0 THEN 'PASS — zero residue'
            ELSE '*** FAIL — synthetic rows survived the rollback ***' END AS verdict
FROM public.procurement_decisions
WHERE batch_id LIKE 'SYNTHETIC-%';


-- ===========================================================================
-- BLOCK 2 — BUYER PACK SNAPSHOTS (migration 10)
-- ===========================================================================
BEGIN;

DO $block2$
DECLARE
  admin_id   UUID;
  synth_pack TEXT := 'SYNTHETIC-PACK-DO-NOT-USE';
  batch      UUID;
  snap1      UUID;
  hash1      TEXT;
  v1         INT;
  v2         INT;
  hash1_after TEXT;
  failures   INT := 0;
  n          INT;
BEGIN
  SELECT id INTO admin_id FROM public.profiles WHERE role = 'ddp_admin' LIMIT 1;
  IF admin_id IS NULL THEN
    RAISE NOTICE 'SKIP  no ddp_admin profile exists — the RPC gate cannot be satisfied. Block 2 not run.';
    RETURN;
  END IF;

  -- S0. One synthetic inventory batch, created here and rolled back with the rest.
  --     Every NOT NULL column on inventory_batches has a DEFAULT (id, created_at,
  --     updated_at), so no business values need inventing. `notes` is set purely
  --     so the row is unmistakably synthetic if it is ever seen.
  INSERT INTO public.inventory_batches (notes)
  VALUES ('SYNTHETIC — created by 18_SYNTHETIC_RUNTIME_VERIFY.sql — rolled back')
  RETURNING id INTO batch;
  RAISE NOTICE 'INFO  S0 synthetic inventory batch created (discarded by ROLLBACK)';

  -- Impersonate the admin: issue_buyer_pack_snapshot() gates on is_ddp_admin(),
  -- which reads auth.uid(). SET LOCAL scopes both settings to THIS transaction.
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', admin_id::text, 'role', 'authenticated')::text,
                     true);
  PERFORM set_config('role', 'authenticated', true);

  -- S1/S2. Issue v1 through the RPC. The function RETURNS public.buyer_pack_snapshots,
  --        so it must be SELECTed FROM, not assigned to a scalar. The SERVER assigns
  --        the version — the client never picks it.
  SELECT snapshot_id, version, content_hash
    INTO snap1, v1, hash1
    FROM public.issue_buyer_pack_snapshot(
      synth_pack,                                   -- p_pack_id
      repeat('a', 64),                              -- p_content_hash (64 lowercase hex)
      synth_pack || ':2026-01-01T00:00:00.000Z',    -- p_approval_id
      '2026-01-01T00:00:00.000Z'::timestamptz,      -- p_approval_timestamp
      'progress',                                   -- p_procurement_decision
      'SYNTHETIC Approver',                         -- p_approved_by
      'SYNTHETIC Approver',                         -- p_generated_by
      '{"synthetic":true}'::jsonb,                  -- p_frozen_evidence
      batch                                         -- p_batch_id
    );

  IF v1 = 1 THEN
    RAISE NOTICE 'PASS  S1/S2 snapshot issued via RPC; SERVER assigned version = 1';
  ELSE
    RAISE NOTICE '*** FAIL S1/S2 expected server-assigned version 1, got %', v1; failures := failures + 1;
  END IF;

  -- S3. Re-issue must APPEND version 2, not overwrite version 1.
  SELECT version INTO v2
    FROM public.issue_buyer_pack_snapshot(
      synth_pack, repeat('b', 64),
      synth_pack || ':2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:01.000Z'::timestamptz,
      'progress', 'SYNTHETIC Approver', 'SYNTHETIC Approver',
      '{"synthetic":true,"v":2}'::jsonb, batch
    );

  IF v2 = 2 THEN
    RAISE NOTICE 'PASS  S3 re-issue APPENDED version 2';
  ELSE
    RAISE NOTICE '*** FAIL S3 expected version 2 on re-issue, got %', v2; failures := failures + 1;
  END IF;

  -- S4. Version 1 must be UNCHANGED — history is append-only, not overwritten.
  SELECT content_hash INTO hash1_after
    FROM public.buyer_pack_snapshots WHERE snapshot_id = snap1;

  IF hash1_after = hash1 THEN
    RAISE NOTICE 'PASS  S4 version 1 preserved unchanged after re-issue';
  ELSE
    RAISE NOTICE '*** FAIL S4 version 1 was MUTATED by the re-issue'; failures := failures + 1;
  END IF;

  -- S5. The RPC must refuse a non-'progress' decision (server-side release gate).
  BEGIN
    PERFORM public.issue_buyer_pack_snapshot(
      synth_pack, repeat('c', 64), synth_pack || ':hold',
      '2026-01-01T00:00:02.000Z'::timestamptz,
      'hold', 'SYNTHETIC Approver', 'SYNTHETIC Approver', '{}'::jsonb, batch);
    RAISE NOTICE '*** FAIL S5 a NON-PROGRESS decision was ACCEPTED by the RPC'; failures := failures + 1;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  S5 RPC refused non-progress decision: %', SQLERRM;
  END;

  -- S6. The RPC must refuse a blank approver (no anonymous releases).
  BEGIN
    PERFORM public.issue_buyer_pack_snapshot(
      synth_pack, repeat('d', 64), synth_pack || ':noapprover',
      '2026-01-01T00:00:03.000Z'::timestamptz,
      'progress', '   ', 'SYNTHETIC Approver', '{}'::jsonb, batch);
    RAISE NOTICE '*** FAIL S6 a BLANK approver was ACCEPTED by the RPC'; failures := failures + 1;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  S6 RPC refused unnamed approver: %', SQLERRM;
  END;

  -- S7. Snapshot count during the transaction (expect exactly the 2 synthetic rows).
  SELECT count(*) INTO n FROM public.buyer_pack_snapshots WHERE pack_id = synth_pack;
  IF n = 2 THEN
    RAISE NOTICE 'PASS  S7 exactly 2 synthetic snapshots exist in-transaction';
  ELSE
    RAISE NOTICE '*** FAIL S7 expected 2 synthetic snapshots, found %', n; failures := failures + 1;
  END IF;

  -- Drop back to the table owner so RLS is not what denies the next two checks:
  -- this proves the IMMUTABILITY TRIGGER fires, not merely that a policy is absent.
  PERFORM set_config('role', 'postgres', true);

  -- S8. Snapshot UPDATE must be rejected.
  BEGIN
    UPDATE public.buyer_pack_snapshots
       SET approved_by = 'TAMPERED'
     WHERE snapshot_id = snap1;
    RAISE NOTICE '*** FAIL S8 snapshot UPDATE was ALLOWED — snapshots are NOT immutable'; failures := failures + 1;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  S8 snapshot UPDATE rejected: %', SQLERRM;
  END;

  -- S9. Snapshot DELETE must be rejected.
  BEGIN
    DELETE FROM public.buyer_pack_snapshots WHERE snapshot_id = snap1;
    RAISE NOTICE '*** FAIL S9 snapshot DELETE was ALLOWED — snapshots are NOT immutable'; failures := failures + 1;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  S9 snapshot DELETE rejected: %', SQLERRM;
  END;

  IF failures > 0 THEN
    RAISE EXCEPTION 'BLOCK 2 FAILED: % check(s) failed — see the *** FAIL notices above', failures;
  END IF;
  RAISE NOTICE 'BLOCK 2 COMPLETE — all buyer-pack snapshot checks passed';
END
$block2$;

-- The ONLY correct ending. Never COMMIT. Never remove this line.
ROLLBACK;

-- Residue proof for block 2: the synthetic snapshots, the audit-log rows they
-- generated, and the synthetic inventory batch must all be gone.
SELECT 'RESIDUE snapshots' AS check,
       (SELECT count(*) FROM public.buyer_pack_snapshots WHERE pack_id LIKE 'SYNTHETIC-%')                     AS synthetic_snapshots,
       (SELECT count(*) FROM public.buyer_pack_audit_log  WHERE pack_id LIKE 'SYNTHETIC-%')                     AS synthetic_audit_rows,
       (SELECT count(*) FROM public.inventory_batches     WHERE notes LIKE 'SYNTHETIC —%')                      AS synthetic_batches,
       CASE WHEN (SELECT count(*) FROM public.buyer_pack_snapshots WHERE pack_id LIKE 'SYNTHETIC-%') = 0
             AND (SELECT count(*) FROM public.buyer_pack_audit_log  WHERE pack_id LIKE 'SYNTHETIC-%') = 0
             AND (SELECT count(*) FROM public.inventory_batches     WHERE notes LIKE 'SYNTHETIC —%') = 0
            THEN 'PASS — zero residue'
            ELSE '*** FAIL — synthetic rows survived the rollback ***' END AS verdict;

-- End of 18_SYNTHETIC_RUNTIME_VERIFY.sql
