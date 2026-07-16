-- =============================================================================
-- 23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql
-- =============================================================================
-- Verification for 23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql.
--
-- SECTION A (object state) is read-only and safe to run anywhere, including
-- Production. It RAISEs if the server-authoritative gate is wrong.
--
-- SECTION B (behaviour) builds an ephemeral fixture and calls the RPC across every
-- required scenario. It is one BEGIN ... ROLLBACK with NO COMMIT, so it leaves no
-- residue. Run it as postgres/superuser against a NON-PRODUCTION project that has
-- migrations 10, 17 and 23 applied. Fixed test ids are asserted absent up front.
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

  -- Comment-stripped executable source. pg_proc.prosrc is the function BODY, and it
  -- INCLUDES the body's comments. Migration 23's body legitimately NAMES the client
  -- argument in comments ("IGNORED for authorization", "never the client-supplied
  -- p_procurement_decision"), so a raw-source scan for that identifier false-fails on
  -- the correct function. Strip line comments (-- to end of line) and scan the
  -- executable code only. This matches the static gate's stripComments semantics.
  v_code := regexp_replace(v_src, '--[^\n]*', '', 'g');

  -- fixed search_path
  v_sp := (select c from unnest(coalesce(v_config,'{}')) c where c like 'search_path=%');
  if v_sp is null then raise exception 'VERIFY A FAILED: no fixed search_path'; end if;

  -- (a) reads the server-authoritative trail, keyed to the SAME pack
  if position('procurement_decisions_current' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function does not read procurement_decisions_current (server trail)';
  end if;
  if v_code !~ 'batch_id\s*=\s*p_pack_id' then
    raise exception 'VERIFY A FAILED: function does not join the decision to the SAME pack (batch_id = p_pack_id)';
  end if;

  -- (b) server value must be the gate, not the client argument
  if v_code !~ 'v_decision\s*<>\s*''progress''' then
    raise exception 'VERIFY A FAILED: function does not require the SERVER decision to be progress (v_decision <> ''progress'')';
  end if;
  -- The executable body must NOT reference the client argument at all — proves it is
  -- ignored for both authorization and storage. Scanned against v_code (comments
  -- stripped): the body's COMMENTS legitimately name p_procurement_decision to
  -- document that it is ignored, so only the CODE is authoritative here. (prosrc is
  -- the body only; the parameter declaration lives in pg_proc.proargnames, not here.)
  if position('p_procurement_decision' in v_code) <> 0 then
    raise exception 'VERIFY A FAILED: function body references p_procurement_decision — client value is not ignored';
  end if;

  -- (c) actor + reason re-asserted
  if v_code !~ 'v_decided_by\s+is\s+null' then
    raise exception 'VERIFY A FAILED: function does not re-assert a non-null decision actor';
  end if;
  if position('v_reason' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function does not re-assert a non-blank decision reason';
  end if;

  -- (d) still admin-gated
  if position('is_ddp_admin' in v_code) = 0 then
    raise exception 'VERIFY A FAILED: function is no longer admin-gated (is_ddp_admin absent)';
  end if;

  raise notice 'VERIFY A PASSED: issuance is server-authoritative (reads procurement_decisions_current for the same pack, gates on the server decision, ignores the client value, re-asserts actor+reason, still admin-gated, SECURITY DEFINER, fixed search_path).';
end $$;

-- Human-readable object-state summary (informational).
select
  exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='issue_buyer_pack_snapshot')             as rpc_present,
  exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='issue_buyer_pack_snapshot'
           and position('procurement_decisions_current' in p.prosrc) > 0)               as reads_server_trail,
  not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='issue_buyer_pack_snapshot'
           and position('p_procurement_decision' in regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) > 0)
                                                                                          as ignores_client_decision,
  exists(select 1 from pg_trigger t where t.tgrelid='public.buyer_pack_snapshots'::regclass
         and t.tgname='buyer_pack_snapshots_no_update_delete' and not t.tgisinternal)    as immutability_trigger_present;


-- =============================================================================
-- SECTION B — BEHAVIOUR (ephemeral fixture; BEGIN ... ROLLBACK; no COMMIT)
-- =============================================================================
-- Requires migrations 10, 17, 23 applied. Run on a NON-PRODUCTION project only.
begin;

-- Fixed test identities (rolled back; asserted absent below).
--   admin  000c0000-0000-0000-0000-000000000001
--   pack ids: PK-PROGRESS, PK-HOLD, PK-REJECT, PK-NONE, PK-STALE-HOLD, PK-STALE-REJECT
do $$
begin
  if exists (select 1 from auth.users where id = '000c0000-0000-0000-0000-000000000001')
     or exists (select 1 from public.profiles where id = '000c0000-0000-0000-0000-000000000001') then
    raise exception 'VERIFY B PRECONDITION FAILED: test admin id already exists — aborting to protect real data';
  end if;
  if exists (select 1 from public.procurement_decisions where batch_id like 'PK-%')
     or exists (select 1 from public.buyer_pack_snapshots where pack_id like 'PK-%') then
    raise exception 'VERIFY B PRECONDITION FAILED: a PK-%% test pack already exists — aborting to protect real data';
  end if;
end $$;

-- Seed identity with FK enforcement relaxed (superuser only): admin auth.users +
-- ddp_admin profile. Decisions reference the admin as decided_by.
set local session_replication_role = replica;
insert into auth.users (id, email) values
  ('000c0000-0000-0000-0000-000000000001', 'verify-bp-admin@example.invalid');
insert into public.profiles (id, email, role) values
  ('000c0000-0000-0000-0000-000000000001', 'verify-bp-admin@example.invalid', 'ddp_admin');

-- Decision trail fixture. decided_at is explicit so "newest wins" is deterministic.
insert into public.procurement_decisions (batch_id, decision, reason, decided_by, decided_at) values
  ('PK-PROGRESS',     'progress', 'ok to progress',     '000c0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('PK-HOLD',         'hold',     'on hold',            '000c0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('PK-REJECT',       'reject',   'rejected',           '000c0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('PK-STALE-HOLD',   'progress', 'progressed earlier', '000c0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('PK-STALE-HOLD',   'hold',     'later held',         '000c0000-0000-0000-0000-000000000001', '2026-01-02 00:00:00+00'),
  ('PK-STALE-REJECT', 'progress', 'progressed earlier', '000c0000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('PK-STALE-REJECT', 'reject',   'later rejected',     '000c0000-0000-0000-0000-000000000001', '2026-01-02 00:00:00+00');
-- (PK-NONE intentionally has NO decision.)

-- Precondition: fixture created exactly as expected.
do $$
declare v_u int; v_p int; v_d int;
begin
  select count(*) into v_u from auth.users where id='000c0000-0000-0000-0000-000000000001';
  select count(*) into v_p from public.profiles where id='000c0000-0000-0000-0000-000000000001';
  select count(*) into v_d from public.procurement_decisions where batch_id like 'PK-%';
  if v_u <> 1 then raise exception 'VERIFY B SETUP FAILED: expected 1 auth.users, got %', v_u; end if;
  if v_p <> 1 then raise exception 'VERIFY B SETUP FAILED: expected 1 profile, got %', v_p; end if;
  if v_d <> 7 then raise exception 'VERIFY B SETUP FAILED: expected 7 decisions, got %', v_d; end if;
end $$;

set local session_replication_role = origin;
-- Act as the seeded ddp_admin: auth.uid()/is_ddp_admin() read request.jwt.claims.
set local request.jwt.claims = '{"sub":"000c0000-0000-0000-0000-000000000001","role":"authenticated"}';

-- ── Helper expectations run inline. Each expected-failure call is wrapped so the
--    RPC's RAISE is caught and the absence of a snapshot is asserted. ──────────

-- B1: valid current 'progress' permits issuance; the SERVER decision is stored;
--     and passing a conflicting client value ('hold') is IGNORED (case 11:
--     client hold + server progress -> succeeds using authoritative state).
do $$
declare r public.buyer_pack_snapshots;
begin
  r := public.issue_buyer_pack_snapshot('PK-PROGRESS', repeat('a',64), 'appr-1', now(),
        'hold' /* client says hold; must be ignored */, 'Test Admin', 'Test Admin', '{"e":1}'::jsonb, null);
  if r.snapshot_id is null then raise exception 'VERIFY B1 FAILED: no snapshot returned for a valid progress pack'; end if;
  if r.version <> 1 then raise exception 'VERIFY B1 FAILED: first version should be 1, got %', r.version; end if;
  if r.procurement_decision <> 'progress' then raise exception 'VERIFY B1 FAILED: stored decision is not the SERVER value progress (got %)', r.procurement_decision; end if;
  raise notice 'VERIFY B1/B11 PASSED: server progress permits issuance; stored decision=progress; client "hold" ignored.';
end $$;

-- B16: an audit row was written on that valid issuance.
do $$
declare n int;
begin
  select count(*) into n from public.buyer_pack_audit_log where pack_id='PK-PROGRESS' and action='pack_generated';
  if n < 1 then raise exception 'VERIFY B16 FAILED: no pack_generated audit row after valid issuance'; end if;
  raise notice 'VERIFY B16 PASSED: audit row written on valid issuance.';
end $$;

-- B13: re-issuing a still-'progress' pack increments the version (append-only).
do $$
declare r public.buyer_pack_snapshots;
begin
  r := public.issue_buyer_pack_snapshot('PK-PROGRESS', repeat('b',64), 'appr-2', now(),
        'progress', 'Test Admin', 'Test Admin', '{"e":2}'::jsonb, null);
  if r.version <> 2 then raise exception 'VERIFY B13 FAILED: second issue should be version 2, got %', r.version; end if;
  raise notice 'VERIFY B13 PASSED: snapshot versioning increments (v2).';
end $$;

-- B14/B15: UPDATE and DELETE on a snapshot remain blocked (immutability).
do $$
declare blocked boolean := false;
begin
  begin update public.buyer_pack_snapshots set approved_by='x' where pack_id='PK-PROGRESS';
  exception when others then blocked := true; end;
  if not blocked then raise exception 'VERIFY B14 FAILED: UPDATE on buyer_pack_snapshots was NOT blocked'; end if;
  blocked := false;
  begin delete from public.buyer_pack_snapshots where pack_id='PK-PROGRESS';
  exception when others then blocked := true; end;
  if not blocked then raise exception 'VERIFY B15 FAILED: DELETE on buyer_pack_snapshots was NOT blocked'; end if;
  raise notice 'VERIFY B14/B15 PASSED: snapshot UPDATE and DELETE remain blocked.';
end $$;

-- Parameterised block for every expected-BLOCK case (2,3,4,5,6,7,10,12).
do $$
declare
  cases text[][] := array[
    array['B2  no decision blocks',                 'PK-NONE',         'progress'],
    array['B3  current hold blocks',                'PK-HOLD',         'progress'],
    array['B4  current reject blocks',              'PK-REJECT',       'progress'],
    array['B5  stale progress + newer hold blocks', 'PK-STALE-HOLD',   'progress'],
    array['B6  stale progress + newer reject blocks','PK-STALE-REJECT','progress'],
    array['B10 client progress + server hold blocks','PK-HOLD',        'progress']
  ];
  c text[];
  issued boolean;
begin
  foreach c slice 1 in array cases loop
    issued := false;
    begin
      perform public.issue_buyer_pack_snapshot(c[2], repeat('c',64), 'appr', now(), c[3], 'Test Admin', 'Test Admin', '{}'::jsonb, null);
      issued := true;
    exception when others then
      null; -- expected: server gate blocked it
    end;
    if issued then raise exception 'VERIFY % FAILED: issuance was NOT blocked for %', c[1], c[2]; end if;
    raise notice 'VERIFY % PASSED.', c[1];
  end loop;
end $$;

-- B7: another batch's progress does not authorise a pack with no decision.
-- (PK-NONE blocks even though PK-PROGRESS, a different batch, is progress — proven
--  by B2 above; asserted explicitly here for the record.)
do $$
declare issued boolean := false;
begin
  begin
    perform public.issue_buyer_pack_snapshot('PK-NONE', repeat('d',64), 'appr', now(), 'progress', 'Test Admin', 'Test Admin', '{}'::jsonb, null);
    issued := true;
  exception when others then null; end;
  if issued then raise exception 'VERIFY B7 FAILED: another batch''s progress authorised PK-NONE'; end if;
  raise notice 'VERIFY B7 PASSED: a decision for another batch does not authorise this pack.';
end $$;

-- B12: null and blank pack id block.
do $$
declare issued boolean;
begin
  issued := false;
  begin perform public.issue_buyer_pack_snapshot(null, repeat('e',64), 'appr', now(), 'progress', 'Test Admin', 'Test Admin', '{}'::jsonb, null); issued := true;
  exception when others then null; end;
  if issued then raise exception 'VERIFY B12 FAILED: null pack id was accepted'; end if;
  issued := false;
  begin perform public.issue_buyer_pack_snapshot('   ', repeat('e',64), 'appr', now(), 'progress', 'Test Admin', 'Test Admin', '{}'::jsonb, null); issued := true;
  exception when others then null; end;
  if issued then raise exception 'VERIFY B12 FAILED: blank pack id was accepted'; end if;
  raise notice 'VERIFY B12 PASSED: null/blank pack id blocks.';
end $$;

-- B8/B9: the trail itself forbids a blank reason and a null actor, so a decision
-- that could authorise a pack ALWAYS has both (the gate re-asserts them as defence
-- in depth — see Section A). Prove the upstream invariant here.
do $$
declare rejected boolean;
begin
  rejected := false;
  begin insert into public.procurement_decisions (batch_id, decision, reason, decided_by)
        values ('PK-BLANK-REASON', 'progress', '   ', '000c0000-0000-0000-0000-000000000001');
  exception when others then rejected := true; end;
  if not rejected then raise exception 'VERIFY B8 FAILED: the trail accepted a blank-reason decision'; end if;

  rejected := false;
  begin insert into public.procurement_decisions (batch_id, decision, reason, decided_by)
        values ('PK-NULL-ACTOR', 'progress', 'ok', null);
  exception when others then rejected := true; end;
  if not rejected then raise exception 'VERIFY B9 FAILED: the trail accepted a null-actor decision'; end if;
  raise notice 'VERIFY B8/B9 PASSED: trail rejects blank reason and null actor, so no such decision can authorise a pack.';
end $$;

rollback;

-- B17: residue check — after ROLLBACK nothing must survive.
select
  (select count(*) from auth.users where id='000c0000-0000-0000-0000-000000000001') as leftover_auth_users,
  (select count(*) from public.profiles where id='000c0000-0000-0000-0000-000000000001') as leftover_profiles,
  (select count(*) from public.procurement_decisions where batch_id like 'PK-%') as leftover_decisions,
  (select count(*) from public.buyer_pack_snapshots where pack_id like 'PK-%') as leftover_snapshots,
  (select count(*) from public.buyer_pack_audit_log where pack_id like 'PK-%') as leftover_audit;

do $$
declare v int;
begin
  select
    (select count(*) from auth.users where id='000c0000-0000-0000-0000-000000000001')
  + (select count(*) from public.profiles where id='000c0000-0000-0000-0000-000000000001')
  + (select count(*) from public.procurement_decisions where batch_id like 'PK-%')
  + (select count(*) from public.buyer_pack_snapshots where pack_id like 'PK-%')
  + (select count(*) from public.buyer_pack_audit_log where pack_id like 'PK-%')
    into v;
  if v <> 0 then raise exception 'VERIFY B17 FAILED: % test row(s) survived rollback — residue present', v; end if;
  raise notice 'VERIFY B17 PASSED: no test residue after rollback (auth.users, profiles, decisions, snapshots, audit all clean).';
end $$;
