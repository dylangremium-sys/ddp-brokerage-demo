-- =============================================================================
-- 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_VERIFY.sql
-- =============================================================================
-- Verification for 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql.
--
-- SECTION A (object state) is read-only and safe to run anywhere, including
-- Production. It RAISEs if the contaminant gate is absent or wrong. It also
-- re-asserts migration 23's properties, so a rollback to 23 (which removes the
-- contaminant gate) is DETECTED here rather than passing silently.
--
-- SECTION B (behaviour) builds an ephemeral fixture and calls the RPC across
-- every required scenario. It is one BEGIN ... ROLLBACK with NO COMMIT, so it
-- leaves no residue. Run it as postgres/superuser against a NON-PRODUCTION
-- project that has migrations 10, 17, 23 and 29 applied. Fixed test ids are
-- asserted absent up front.
-- =============================================================================


-- =============================================================================
-- SECTION A — OBJECT STATE (read-only; RAISEs on drift)
-- =============================================================================
do $$
declare
  v_oid      oid;
  v_secdef   boolean;
  v_config   text[];
  v_src      text;
  v_code     text;
  v_sp       text;
begin
  select p.oid, p.prosecdef, p.proconfig, p.prosrc
    into v_oid, v_secdef, v_config, v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'issue_buyer_pack_snapshot';

  if v_oid is null then
    raise exception 'VERIFY A FAILED: public.issue_buyer_pack_snapshot() does not exist';
  end if;
  if not v_secdef then
    raise exception 'VERIFY A FAILED: function is not SECURITY DEFINER';
  end if;

  -- Comment-stripped executable source, matching 23_..._VERIFY.sql's approach.
  -- pg_proc.prosrc is the function BODY and INCLUDES its comments; this file's
  -- body legitimately NAMES the columns it gates on inside comments, so a raw
  -- scan would pass on a function whose EXECUTABLE code does no such check.
  -- Only the executable code is authoritative here.
  v_code := regexp_replace(v_src, '--[^\n]*', '', 'g');

  v_sp := (select c from unnest(coalesce(v_config,'{}')) c where c like 'search_path=%');
  if v_sp is null then raise exception 'VERIFY A FAILED: no fixed search_path'; end if;

  -- ── (a) THE MIGRATION 29 GATE: the RPC body must reference the batch
  --        fail-status check on inventory_batches. ────────────────────────────
  if position('inventory_batches' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function does not read public.inventory_batches — the contaminant blocker gate is ABSENT (migration 29 not applied, or rolled back to 23)';
  end if;

  -- All FOUR contaminant columns must be gated. A partial gate is a silent hole:
  -- a batch failing only mycotoxins would issue.
  if v_code !~* 'heavy_metals_status\s*=\s*''fail''' then
    raise exception 'VERIFY A FAILED: function does not gate on heavy_metals_status = ''fail''';
  end if;
  if v_code !~* 'pesticides_status\s*=\s*''fail''' then
    raise exception 'VERIFY A FAILED: function does not gate on pesticides_status = ''fail''';
  end if;
  if v_code !~* 'mycotoxins_status\s*=\s*''fail''' then
    raise exception 'VERIFY A FAILED: function does not gate on mycotoxins_status = ''fail''';
  end if;
  if v_code !~* 'microbial_status\s*=\s*''fail''' then
    raise exception 'VERIFY A FAILED: function does not gate on microbial_status = ''fail''';
  end if;

  -- The gate must FAIL CLOSED with an exception, not merely compute a flag.
  if v_code !~* 'raise\s+exception[^;]*failed\s+contaminant\s+test' then
    raise exception 'VERIFY A FAILED: function does not RAISE EXCEPTION naming the failed contaminant test';
  end if;

  -- The batch must be resolvable from p_pack_id, not from p_batch_id alone —
  -- the live client never sends p_batch_id, so a p_batch_id-only gate would be
  -- VACUOUS in production (always NULL, always skipped).
  if v_code !~* 'coalesce\s*\(\s*p_batch_id\s*,' then
    raise exception 'VERIFY A FAILED: function does not fall back to p_pack_id when p_batch_id is absent — the gate would be vacuous for the live client';
  end if;

  -- A UUID pack id naming no batch must be refused, not passed through.
  if v_code !~* 'does\s+not\s+exist' then
    raise exception 'VERIFY A FAILED: function does not refuse a pack id naming a non-existent batch';
  end if;

  -- ── (b) MIGRATION 23's properties must SURVIVE (no regression) ────────────
  if position('procurement_decisions_current' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function does not read procurement_decisions_current (server trail)';
  end if;
  if v_code !~* 'batch_id\s*=\s*p_pack_id' then
    raise exception 'VERIFY A FAILED: function does not join the decision to the SAME pack (batch_id = p_pack_id)';
  end if;
  if v_code !~* 'v_decision\s*<>\s*''progress''' then
    raise exception 'VERIFY A FAILED: function does not require the SERVER decision to be progress';
  end if;
  if position('p_procurement_decision' in v_code) <> 0 then
    raise exception 'VERIFY A FAILED: function body references p_procurement_decision — client value is not ignored';
  end if;
  if v_code !~* 'v_decided_by\s+is\s+null' then
    raise exception 'VERIFY A FAILED: function does not re-assert a non-null decision actor';
  end if;
  if position('v_reason' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function does not re-assert a non-blank decision reason';
  end if;
  if position('is_ddp_admin' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function is no longer admin-gated (is_ddp_admin absent)';
  end if;

  raise notice 'VERIFY A PASSED: issuance refuses a batch with any recorded FAILED contaminant test (all four columns gated, resolved from p_pack_id, fails closed on a missing batch), and migration 23''s server-authoritative decision gate is intact.';
end $$;

-- Human-readable object-state summary (informational).
select
  exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='issue_buyer_pack_snapshot')             as rpc_present,
  exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='issue_buyer_pack_snapshot'
           and position('inventory_batches' in regexp_replace(p.prosrc,'--[^\n]*','','g')) > 0)
                                                                                          as gates_on_batch_lab_results,
  exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='issue_buyer_pack_snapshot'
           and position('procurement_decisions_current' in p.prosrc) > 0)               as reads_server_trail;


-- =============================================================================
-- SECTION B — BEHAVIOUR (ephemeral fixture; BEGIN ... ROLLBACK; no COMMIT)
-- =============================================================================
-- Requires migrations 10, 17, 23 and 29 applied. Run on a NON-PRODUCTION project.
begin;

-- Fixed test identities (rolled back; asserted absent below).
--   admin  000e0000-0000-0000-0000-000000000001
--   batches 000e0000-0000-0000-0000-0000000000{10..15}
do $$
begin
  if exists (select 1 from auth.users where id = '000e0000-0000-0000-0000-000000000001')
     or exists (select 1 from public.profiles where id = '000e0000-0000-0000-0000-000000000001') then
    raise exception 'VERIFY B PRECONDITION FAILED: test admin id already exists — aborting to protect real data';
  end if;
  if exists (select 1 from public.inventory_batches where id::text like '000e0000-%') then
    raise exception 'VERIFY B PRECONDITION FAILED: a 000e0000-%% test batch already exists — aborting to protect real data';
  end if;
  if exists (select 1 from public.buyer_pack_snapshots where pack_id like '000e0000-%')
     or exists (select 1 from public.procurement_decisions where batch_id like '000e0000-%') then
    raise exception 'VERIFY B PRECONDITION FAILED: a 000e0000-%% test pack already exists — aborting to protect real data';
  end if;
end $$;

set local session_replication_role = replica;
insert into auth.users (id, email) values
  ('000e0000-0000-0000-0000-000000000001', 'verify-29-admin@example.invalid');
insert into public.profiles (id, email, role) values
  ('000e0000-0000-0000-0000-000000000001', 'verify-29-admin@example.invalid', 'ddp_admin');

-- Batch fixture. The pack id IS the batch id (as text), matching the live client.
--   ...10 CLEAN            all four pass
--   ...11 HEAVY METALS     heavy_metals_status = 'fail'
--   ...12 PESTICIDES       pesticides_status   = 'fail'
--   ...13 MYCOTOXINS       mycotoxins_status   = 'fail'
--   ...14 MICROBIAL        microbial_status    = 'fail'
--   ...15 UNTESTED         not_tested / NULL — a documentation gap, NOT a failure
insert into public.inventory_batches (id, product_name, heavy_metals_status, pesticides_status, mycotoxins_status, microbial_status) values
  ('000e0000-0000-0000-0000-000000000010', 'Clean Batch',      'pass',      'pass',      'pass',      'pass'),
  ('000e0000-0000-0000-0000-000000000011', 'Heavy Metals Fail','fail',      'pass',      'pass',      'pass'),
  ('000e0000-0000-0000-0000-000000000012', 'Pesticides Fail',  'pass',      'fail',      'pass',      'pass'),
  ('000e0000-0000-0000-0000-000000000013', 'Mycotoxins Fail',  'pass',      'pass',      'fail',      'pass'),
  ('000e0000-0000-0000-0000-000000000014', 'Microbial Fail',   'pass',      'pass',      'pass',      'fail'),
  ('000e0000-0000-0000-0000-000000000015', 'Untested Batch',   'not_tested', null,       'not_tested', null);

-- EVERY batch gets a valid current 'progress' decision. That is the whole point:
-- the decision gate is satisfied, so anything that refuses below is refused by
-- the CONTAMINANT gate and nothing else.
insert into public.procurement_decisions (batch_id, decision, reason, decided_by, decided_at) values
  ('000e0000-0000-0000-0000-000000000010', 'progress', 'clean',      '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('000e0000-0000-0000-0000-000000000011', 'progress', 'approved',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('000e0000-0000-0000-0000-000000000012', 'progress', 'approved',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('000e0000-0000-0000-0000-000000000013', 'progress', 'approved',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('000e0000-0000-0000-0000-000000000014', 'progress', 'approved',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('000e0000-0000-0000-0000-000000000015', 'progress', 'awaiting',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  -- A UUID pack id naming NO batch row.
  ('000e0000-0000-0000-0000-0000000000ff', 'progress', 'dangling',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  -- A NON-UUID pack id: the documented pass-through case.
  ('PK29-TEXT-KEY',                        'progress', 'text key',   '000e0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00');

do $$
declare v_b int; v_d int;
begin
  select count(*) into v_b from public.inventory_batches where id::text like '000e0000-%';
  select count(*) into v_d from public.procurement_decisions
    where batch_id like '000e0000-%' or batch_id = 'PK29-TEXT-KEY';
  if v_b <> 6 then raise exception 'VERIFY B SETUP FAILED: expected 6 batches, got %', v_b; end if;
  if v_d <> 8 then raise exception 'VERIFY B SETUP FAILED: expected 8 decisions, got %', v_d; end if;
end $$;

set local session_replication_role = origin;
-- Act as the seeded ddp_admin. BOTH GUC forms are set deliberately:
--   • request.jwt.claims      — the hosted Supabase form, as used by 23_..._VERIFY.
--   • request.jwt.claim.sub   — the form the repo's disposable-Postgres substrate
--                               shim reads (scripts/disposable-pg/bootstrap/
--                               00_supabase_substrate.sql: auth.uid()).
-- Setting both makes this file runnable, unmodified, against the hosted platform
-- AND the local harness. Neither environment is harmed by the other's GUC, and a
-- VERIFY that only runs in one place is a VERIFY that mostly does not get run.
set local request.jwt.claims = '{"sub":"000e0000-0000-0000-0000-000000000001","role":"authenticated"}';
set local request.jwt.claim.sub = '000e0000-0000-0000-0000-000000000001';

-- ── B1: a CLEAN batch with a progress decision still issues. The gate must not
--        block legitimate releases — a gate that refuses everything is not a
--        gate, and this is what proves the refusals below are specific. ───────
do $$
declare r public.buyer_pack_snapshots;
begin
  r := public.issue_buyer_pack_snapshot('000e0000-0000-0000-0000-000000000010', repeat('a',64),
        'appr-clean', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":1}'::jsonb, null);
  if r.snapshot_id is null then raise exception 'VERIFY B1 FAILED: clean batch was refused'; end if;
  if r.version <> 1 then raise exception 'VERIFY B1 FAILED: expected version 1, got %', r.version; end if;
  raise notice 'VERIFY B1 PASSED: a clean batch with a progress decision issues normally.';
end $$;

-- ── B2-B5: EACH of the four contaminant failures is refused, INDIVIDUALLY.
--           Looping proves no column was left ungated. ─────────────────────────
do $$
declare
  v_ids  text[] := array[
    '000e0000-0000-0000-0000-000000000011',
    '000e0000-0000-0000-0000-000000000012',
    '000e0000-0000-0000-0000-000000000013',
    '000e0000-0000-0000-0000-000000000014'];
  v_names text[] := array['heavy metals','pesticides','mycotoxins','microbial'];
  v_id text; v_n text; i int;
  v_raised boolean; v_msg text; v_count int;
begin
  for i in 1..4 loop
    v_id := v_ids[i]; v_n := v_names[i];
    v_raised := false;
    begin
      perform public.issue_buyer_pack_snapshot(v_id, repeat('b',64), 'appr-'||v_n, now(),
        'progress', 'Test Admin', 'Test Admin', '{"e":2}'::jsonb, null);
    exception when others then
      v_raised := true; v_msg := SQLERRM;
    end;

    if not v_raised then
      raise exception 'VERIFY B FAILED (%): a batch with a FAILED % test was ISSUED — the contaminant gate did not fire', v_n, v_n;
    end if;
    -- The message must name the failing test, not merely refuse.
    if position(v_n in v_msg) = 0 then
      raise exception 'VERIFY B FAILED (%): refusal did not name the failed test. Got: %', v_n, v_msg;
    end if;
    -- And NOTHING may have been written.
    select count(*) into v_count from public.buyer_pack_snapshots where pack_id = v_id;
    if v_count <> 0 then
      raise exception 'VERIFY B FAILED (%): % snapshot row(s) written despite refusal', v_n, v_count;
    end if;
    select count(*) into v_count from public.buyer_pack_audit_log where pack_id = v_id;
    if v_count <> 0 then
      raise exception 'VERIFY B FAILED (%): % audit row(s) written despite refusal', v_n, v_count;
    end if;
  end loop;
  raise notice 'VERIFY B2-B5 PASSED: each of the four contaminant failures is refused individually, names the failed test, and writes no snapshot or audit row.';
end $$;

-- ── B6: 'not_tested'/NULL is a documentation gap, NOT a failure. Treating it as
--        one would block the ordinary awaiting-COA path. ─────────────────────
do $$
declare r public.buyer_pack_snapshots;
begin
  r := public.issue_buyer_pack_snapshot('000e0000-0000-0000-0000-000000000015', repeat('c',64),
        'appr-untested', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":3}'::jsonb, null);
  if r.snapshot_id is null then raise exception 'VERIFY B6 FAILED: an untested batch was refused'; end if;
  raise notice 'VERIFY B6 PASSED: not_tested/NULL is not treated as a failure.';
end $$;

-- ── B7: a UUID pack id naming NO batch is refused (fail closed). ─────────────
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    perform public.issue_buyer_pack_snapshot('000e0000-0000-0000-0000-0000000000ff', repeat('d',64),
      'appr-dangling', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":4}'::jsonb, null);
  exception when others then
    v_raised := true; v_msg := SQLERRM;
  end;
  if not v_raised then
    raise exception 'VERIFY B7 FAILED: a pack id naming a non-existent batch was ISSUED';
  end if;
  if position('does not exist' in v_msg) = 0 then
    raise exception 'VERIFY B7 FAILED: refusal did not say the batch does not exist. Got: %', v_msg;
  end if;
  raise notice 'VERIFY B7 PASSED: a UUID pack id naming no batch is refused.';
end $$;

-- ── B8: the DOCUMENTED LIMITATION, asserted rather than hidden. A non-UUID pack
--        id with no p_batch_id cannot be resolved to a batch, so the contaminant
--        condition cannot be evaluated and issuance proceeds. If this ever
--        starts failing, the limitation has been closed and this file's header
--        and migration 29's header must both be updated. ──────────────────────
do $$
declare r public.buyer_pack_snapshots;
begin
  r := public.issue_buyer_pack_snapshot('PK29-TEXT-KEY', repeat('e',64),
        'appr-text', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":5}'::jsonb, null);
  if r.snapshot_id is null then raise exception 'VERIFY B8 FAILED: a non-UUID pack id was refused unexpectedly'; end if;
  raise notice 'VERIFY B8 PASSED (KNOWN LIMITATION): a non-UUID pack id is not batch-resolvable, so the contaminant gate cannot evaluate it and issuance proceeds. This is recorded, not hidden — see migration 29 header, FAIL-CLOSED POSTURE.';
end $$;

-- ── B9: p_batch_id, when supplied, is honoured — a contaminated batch is refused
--        even if the pack id itself is a harmless text key. ───────────────────
do $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    perform public.issue_buyer_pack_snapshot('PK29-TEXT-KEY', repeat('f',64),
      'appr-explicit', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":6}'::jsonb,
      '000e0000-0000-0000-0000-000000000011'::uuid);
  exception when others then
    v_raised := true; v_msg := SQLERRM;
  end;
  if not v_raised then
    raise exception 'VERIFY B9 FAILED: an explicitly supplied contaminated p_batch_id was ISSUED';
  end if;
  if position('heavy metals' in v_msg) = 0 then
    raise exception 'VERIFY B9 FAILED: refusal did not name the failed test. Got: %', v_msg;
  end if;
  raise notice 'VERIFY B9 PASSED: an explicit p_batch_id is honoured and takes precedence.';
end $$;

-- ── B10: a batch failing MORE THAN ONE test names them all. ──────────────────
do $$
declare v_raised boolean := false; v_msg text;
begin
  update public.inventory_batches
     set pesticides_status = 'fail'
   where id = '000e0000-0000-0000-0000-000000000011';
  begin
    perform public.issue_buyer_pack_snapshot('000e0000-0000-0000-0000-000000000011', repeat('0',64),
      'appr-multi', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":7}'::jsonb, null);
  exception when others then
    v_raised := true; v_msg := SQLERRM;
  end;
  if not v_raised then raise exception 'VERIFY B10 FAILED: a multi-failure batch was ISSUED'; end if;
  if position('heavy metals' in v_msg) = 0 or position('pesticides' in v_msg) = 0 then
    raise exception 'VERIFY B10 FAILED: refusal did not name BOTH failed tests. Got: %', v_msg;
  end if;
  raise notice 'VERIFY B10 PASSED: a multi-failure batch names every failing test.';
end $$;

-- ── B11: migration 23's decision gate still fires (no regression). A CLEAN batch
--         whose current decision is 'hold' must still be refused. ─────────────
do $$
declare v_raised boolean := false; v_msg text;
begin
  insert into public.procurement_decisions (batch_id, decision, reason, decided_by, decided_at)
    values ('000e0000-0000-0000-0000-000000000010', 'hold', 'later held',
            '000e0000-0000-0000-0000-000000000001', '2026-02-01 00:00:00+00');
  begin
    perform public.issue_buyer_pack_snapshot('000e0000-0000-0000-0000-000000000010', repeat('1',64),
      'appr-held', now(), 'progress', 'Test Admin', 'Test Admin', '{"e":8}'::jsonb, null);
  exception when others then
    v_raised := true; v_msg := SQLERRM;
  end;
  if not v_raised then
    raise exception 'VERIFY B11 FAILED: a clean batch whose current decision is hold was ISSUED — migration 23 gate regressed';
  end if;
  if position('not "progress"' in v_msg) = 0 then
    raise exception 'VERIFY B11 FAILED: refusal was not the decision gate. Got: %', v_msg;
  end if;
  raise notice 'VERIFY B11 PASSED: migration 23''s server-authoritative decision gate still fires.';
end $$;

-- ── Final tally: exactly the three legitimate issuances happened. ────────────
do $$
declare n int;
begin
  select count(*) into n from public.buyer_pack_snapshots
   where pack_id like '000e0000-%' or pack_id = 'PK29-TEXT-KEY';
  if n <> 3 then
    raise exception 'VERIFY B FAILED: expected exactly 3 snapshots (clean, untested, text-key), got %', n;
  end if;
  raise notice 'VERIFY B PASSED: exactly 3 legitimate issuances; every contaminated batch refused.';
end $$;

rollback;

-- Residue check — run AFTER the rollback above. Every count must be zero.
select
  (select count(*) from public.inventory_batches   where id::text like '000e0000-%') as batches_left,
  (select count(*) from public.procurement_decisions where batch_id like '000e0000-%'
                                                        or batch_id = 'PK29-TEXT-KEY') as decisions_left,
  (select count(*) from public.buyer_pack_snapshots where pack_id like '000e0000-%'
                                                      or pack_id = 'PK29-TEXT-KEY')  as snapshots_left,
  (select count(*) from auth.users where id = '000e0000-0000-0000-0000-000000000001') as users_left;
