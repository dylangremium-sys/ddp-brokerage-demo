-- =============================================================================
-- 19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql
-- =============================================================================
-- Verification for 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql.
--
-- SECTION A (object state) is read-only and safe to run anywhere, including
-- production: it only inspects catalogs and RAISEs if the guard is wrong.
--
-- SECTION B (behaviour) creates an ephemeral fixture and exercises the trigger as
-- a real farmer and a real admin. It is wrapped in a single BEGIN ... ROLLBACK and
-- performs NO COMMIT, so it leaves no residue. Run it in the Supabase SQL Editor
-- (postgres/superuser) against a NON-PRODUCTION project. It uses fixed test UUIDs
-- and asserts up front that they do not already exist, so it cannot collide with
-- or mutate real data even before the rollback.
--
-- Every assertion RAISEs EXCEPTION on failure. A silent/partial setup cannot make
-- a check pass: each fixture step is followed by a row-count precondition.
-- =============================================================================


-- =============================================================================
-- SECTION A — OBJECT STATE (read-only; RAISEs on any drift)
-- =============================================================================
do $$
declare
  v_oid              oid;
  v_secdef           boolean;
  v_config           text[];
  v_src              text;
  v_search_path      text;
  v_trig_count       int;
  v_trig_disabled    int;
  v_tgtype           smallint;
  v_auth_can_exec    boolean;
  v_anon_can_exec    boolean;
begin
  -- Precondition: function exists.
  select p.oid, p.prosecdef, p.proconfig, p.prosrc
    into v_oid, v_secdef, v_config, v_src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'fn_protect_farm_admin_fields';

  if v_oid is null then
    raise exception 'VERIFY A FAILED: public.fn_protect_farm_admin_fields() does not exist';
  end if;

  -- 1. SECURITY DEFINER.
  if not v_secdef then
    raise exception 'VERIFY A FAILED: function is not SECURITY DEFINER';
  end if;

  -- 2. Fixed, safe search_path.
  v_search_path := (select c from unnest(coalesce(v_config, '{}')) c where c like 'search_path=%');
  if v_search_path is null then
    raise exception 'VERIFY A FAILED: function has no fixed search_path (mutable search_path)';
  end if;
  if position('public' in v_search_path) = 0 or position('pg_temp' in v_search_path) = 0 then
    raise exception 'VERIFY A FAILED: search_path is not the expected "public, pg_temp": %', v_search_path;
  end if;

  -- 3. Canonical admin check present.
  if position('is_ddp_admin' in v_src) = 0 then
    raise exception 'VERIFY A FAILED: function body does not call the canonical is_ddp_admin() predicate';
  end if;

  -- 4. Unsafe legacy role literal absent (the original ''admin'' bug).
  if v_src ~* 'role\s*=\s*''admin''' then
    raise exception 'VERIFY A FAILED: function body contains the invalid literal role = ''admin''';
  end if;

  -- 5. Every admin-controlled column is preserved (coverage, no drift).
  --    Enumerated from schema: SUPABASE_SCHEMA.sql:20-25 + AUTH_RLS_SCHEMA.sql:38-39.
  if position('new.status'            in v_src) = 0 then raise exception 'VERIFY A FAILED: status not preserved'; end if;
  if position('new.compliance_status' in v_src) = 0 then raise exception 'VERIFY A FAILED: compliance_status not preserved'; end if;
  if position('new.export_readiness'  in v_src) = 0 then raise exception 'VERIFY A FAILED: export_readiness not preserved'; end if;
  if position('new.risk_level'        in v_src) = 0 then raise exception 'VERIFY A FAILED: risk_level not preserved'; end if;
  if position('new.partner_tier'      in v_src) = 0 then raise exception 'VERIFY A FAILED: partner_tier not preserved'; end if;
  if position('new.reviewed_by'       in v_src) = 0 then raise exception 'VERIFY A FAILED: reviewed_by not preserved'; end if;
  if position('new.created_by'        in v_src) = 0 then raise exception 'VERIFY A FAILED: created_by not preserved'; end if;

  -- 6. Trigger exists on public.farms, fires on BOTH INSERT and UPDATE, and is
  --    enabled. tgtype bits: INSERT = 4, UPDATE = 16 (row/before bits are 1/2).
  select count(*) filter (where true),
         count(*) filter (where t.tgenabled = 'D'),
         max(t.tgtype)
    into v_trig_count, v_trig_disabled, v_tgtype
  from pg_trigger t
  where t.tgrelid = 'public.farms'::regclass
    and t.tgname = 'trg_protect_farm_admin_fields'
    and not t.tgisinternal;

  if v_trig_count = 0 then
    raise exception 'VERIFY A FAILED: trigger trg_protect_farm_admin_fields is absent on public.farms (Q1 escalation state)';
  end if;
  if v_trig_disabled > 0 then
    raise exception 'VERIFY A FAILED: trigger trg_protect_farm_admin_fields exists but is DISABLED';
  end if;
  if (v_tgtype & 4) = 0 then
    raise exception 'VERIFY A FAILED: trigger does not fire on INSERT (INSERT vector unguarded)';
  end if;
  if (v_tgtype & 16) = 0 then
    raise exception 'VERIFY A FAILED: trigger does not fire on UPDATE (UPDATE vector unguarded)';
  end if;

  -- 7. Least privilege: the guard is not directly executable by client roles.
  v_auth_can_exec := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_anon_can_exec := has_function_privilege('anon', v_oid, 'EXECUTE');
  if v_auth_can_exec then
    raise exception 'VERIFY A FAILED: authenticated must NOT hold EXECUTE on the guard function';
  end if;
  if v_anon_can_exec then
    raise exception 'VERIFY A FAILED: anon must NOT hold EXECUTE on the guard function';
  end if;

  raise notice 'VERIFY A PASSED: object state correct (SECURITY DEFINER, fixed search_path, is_ddp_admin, all 7 columns preserved, trigger enabled and fires on INSERT+UPDATE, not directly executable).';
end $$;

-- Human-readable object-state summary (informational; mirrors 16_..._VERIFY Q1).
select
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'fn_protect_farm_admin_fields')      as function_present,
  exists (select 1 from pg_trigger t where t.tgrelid = 'public.farms'::regclass
          and t.tgname = 'trg_protect_farm_admin_fields' and not t.tgisinternal)          as trigger_present,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'farms'
          and policyname = 'farms: farmer update own')                                    as farmer_update_policy_present,
  case
    when not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'farms'
                     and policyname = 'farms: farmer update own')
      then 'SAFE — no farmer UPDATE policy on farms'
    when exists (select 1 from pg_trigger t where t.tgrelid = 'public.farms'::regclass
                 and t.tgname = 'trg_protect_farm_admin_fields' and not t.tgisinternal)
      then 'SAFE — farmer UPDATE policy is guarded by trg_protect_farm_admin_fields'
    else '*** ESCALATION RISK — farmer UPDATE policy is LIVE and the column guard is ABSENT ***'
  end as q1_self_certification_status;


-- =============================================================================
-- SECTION B — BEHAVIOUR (ephemeral fixture; BEGIN ... ROLLBACK; no COMMIT)
-- =============================================================================
-- Run against a NON-PRODUCTION project as postgres/superuser.
begin;

-- Fixed test identities (rolled back; asserted absent below so real data is safe).
--   farmer      000f0000-0000-0000-0000-000000000001
--   admin       000f0000-0000-0000-0000-000000000002
--   other       000f0000-0000-0000-0000-000000000003
--   farm        000fa000-0000-0000-0000-000000000001   (UPDATE-test target)
--   other farm  000fa000-0000-0000-0000-000000000002   (unrelated-row target)
--   farm3       000fa000-0000-0000-0000-000000000003   (farmer INSERT-test target)
--   farm4       000fa000-0000-0000-0000-000000000004   (admin  INSERT-test target)

-- Precondition 0: RLS policies the behaviour relies on must exist; and the test
-- identities must not already exist (never touch real rows).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='farms'
                 and policyname='farms: farmer update own') then
    raise exception 'VERIFY B PRECONDITION FAILED: policy "farms: farmer update own" is absent — farmer UPDATE path not reachable';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='farms'
                 and policyname='farms: farmer insert own') then
    raise exception 'VERIFY B PRECONDITION FAILED: policy "farms: farmer insert own" is absent — farmer INSERT path not reachable';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='farms'
                 and policyname='farms: admin all') then
    raise exception 'VERIFY B PRECONDITION FAILED: policy "farms: admin all" is absent — admin path not reachable';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.farms'::regclass) then
    raise exception 'VERIFY B PRECONDITION FAILED: RLS is not enabled on public.farms';
  end if;
  if exists (select 1 from public.farms where id in
        ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002',
         '000fa000-0000-0000-0000-000000000003','000fa000-0000-0000-0000-000000000004')) then
    raise exception 'VERIFY B PRECONDITION FAILED: test farm id already exists — aborting to protect real data';
  end if;
  if exists (select 1 from public.profiles where id in
        ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003')) then
    raise exception 'VERIFY B PRECONDITION FAILED: test profile id already exists — aborting to protect real data';
  end if;
  if exists (select 1 from auth.users where id in
        ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003')) then
    raise exception 'VERIFY B PRECONDITION FAILED: test auth.users id already exists — aborting to protect real data';
  end if;
end $$;

-- Seed fixture with FK/trigger enforcement relaxed (superuser only). Replica mode
-- makes the seed deterministic and lets us insert profiles/farms/memberships
-- without ordering games. auth.users rows ARE seeded (only id + email — other
-- columns are nullable/defaulted; add more if your auth schema requires them)
-- because the INSERT tests below force created_by = auth.uid(), whose FK to
-- auth.users(id) is checked under origin mode. Switched back to origin before any
-- INSERT/UPDATE so the guard fires.
set local session_replication_role = replica;

insert into auth.users (id, email) values
  ('000f0000-0000-0000-0000-000000000001', 'verify-farmer@example.invalid'),
  ('000f0000-0000-0000-0000-000000000002', 'verify-admin@example.invalid'),
  ('000f0000-0000-0000-0000-000000000003', 'verify-other@example.invalid');

insert into public.profiles (id, email, role) values
  ('000f0000-0000-0000-0000-000000000001', 'verify-farmer@example.invalid', 'farmer'),
  ('000f0000-0000-0000-0000-000000000002', 'verify-admin@example.invalid',  'ddp_admin'),
  ('000f0000-0000-0000-0000-000000000003', 'verify-other@example.invalid',  'farmer');

insert into public.farms (id, farm_name, status, compliance_status, export_readiness, risk_level, partner_tier, reviewed_by, created_by) values
  ('000fa000-0000-0000-0000-000000000001', 'Verify Farm', 'PendingReview', 'NonCompliant', 'NotReady', 'High', 'None',
      '000f0000-0000-0000-0000-000000000002', '000f0000-0000-0000-0000-000000000002'),
  ('000fa000-0000-0000-0000-000000000002', 'Other Farm',  'PendingReview', 'NonCompliant', 'NotReady', 'High', 'None',
      '000f0000-0000-0000-0000-000000000002', '000f0000-0000-0000-0000-000000000002');

insert into public.farm_memberships (user_id, farm_id, role) values
  ('000f0000-0000-0000-0000-000000000001', '000fa000-0000-0000-0000-000000000001', 'owner'),
  ('000f0000-0000-0000-0000-000000000003', '000fa000-0000-0000-0000-000000000002', 'owner');

-- Precondition 1: fixture created exactly as expected (guards against silent setup failure).
do $$
declare v_u int; v_p int; v_f int; v_m int;
begin
  select count(*) into v_u from auth.users where id in
    ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003');
  select count(*) into v_p from public.profiles where id in
    ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003');
  select count(*) into v_f from public.farms where id in
    ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002');
  select count(*) into v_m from public.farm_memberships where farm_id in
    ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002');
  if v_u <> 3 then raise exception 'VERIFY B SETUP FAILED: expected 3 auth.users, got %', v_u; end if;
  if v_p <> 3 then raise exception 'VERIFY B SETUP FAILED: expected 3 profiles, got %', v_p; end if;
  if v_f <> 2 then raise exception 'VERIFY B SETUP FAILED: expected 2 farms, got %', v_f; end if;
  if v_m <> 2 then raise exception 'VERIFY B SETUP FAILED: expected 2 memberships, got %', v_m; end if;
end $$;

-- Re-enable normal trigger/FK behaviour so the guard fires on INSERT and UPDATE.
set local session_replication_role = origin;

-- ── B1: FARMER cannot change any admin-controlled column, but CAN change an
--        allowed descriptive column. ────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"000f0000-0000-0000-0000-000000000001","role":"authenticated"}';

update public.farms set
  status            = 'Approved',
  compliance_status = 'Compliant',
  export_readiness  = 'Ready',
  risk_level        = 'Low',
  partner_tier      = 'Platinum',
  reviewed_by       = '000f0000-0000-0000-0000-000000000001',
  created_by        = '000f0000-0000-0000-0000-000000000001',
  farm_name         = 'Farmer Renamed'
where id = '000fa000-0000-0000-0000-000000000001';

reset role;

do $$
declare r public.farms%rowtype;
begin
  select * into r from public.farms where id = '000fa000-0000-0000-0000-000000000001';
  if r.status            <> 'PendingReview' then raise exception 'VERIFY B1 FAILED: farmer changed status to %', r.status; end if;
  if r.compliance_status <> 'NonCompliant'  then raise exception 'VERIFY B1 FAILED: farmer changed compliance_status to %', r.compliance_status; end if;
  if r.export_readiness  <> 'NotReady'      then raise exception 'VERIFY B1 FAILED: farmer changed export_readiness to %', r.export_readiness; end if;
  if r.risk_level        <> 'High'          then raise exception 'VERIFY B1 FAILED: farmer changed risk_level to %', r.risk_level; end if;
  if r.partner_tier      <> 'None'          then raise exception 'VERIFY B1 FAILED: farmer changed partner_tier to %', r.partner_tier; end if;
  if r.reviewed_by       <> '000f0000-0000-0000-0000-000000000002' then raise exception 'VERIFY B1 FAILED: farmer changed reviewed_by'; end if;
  if r.created_by        <> '000f0000-0000-0000-0000-000000000002' then raise exception 'VERIFY B1 FAILED: farmer changed created_by'; end if;
  if r.farm_name         <> 'Farmer Renamed' then raise exception 'VERIFY B1 FAILED: allowed column farm_name did NOT persist (got %)', r.farm_name; end if;
  raise notice 'VERIFY B1 PASSED: farmer blocked on all 7 admin columns; allowed column persisted.';
end $$;

-- ── B2: DDP ADMIN can change admin-controlled columns. ─────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"000f0000-0000-0000-0000-000000000002","role":"authenticated"}';

update public.farms set
  compliance_status = 'Compliant',
  risk_level        = 'Low',
  status            = 'Approved',
  partner_tier      = 'Gold'
where id = '000fa000-0000-0000-0000-000000000001';

reset role;

do $$
declare r public.farms%rowtype;
begin
  select * into r from public.farms where id = '000fa000-0000-0000-0000-000000000001';
  if r.compliance_status <> 'Compliant' then raise exception 'VERIFY B2 FAILED: admin change to compliance_status did not persist (got %)', r.compliance_status; end if;
  if r.risk_level        <> 'Low'       then raise exception 'VERIFY B2 FAILED: admin change to risk_level did not persist (got %)', r.risk_level; end if;
  if r.status            <> 'Approved'  then raise exception 'VERIFY B2 FAILED: admin change to status did not persist (got %)', r.status; end if;
  if r.partner_tier      <> 'Gold'      then raise exception 'VERIFY B2 FAILED: admin change to partner_tier did not persist (got %)', r.partner_tier; end if;
  raise notice 'VERIFY B2 PASSED: ddp_admin can set admin-controlled columns.';
end $$;

-- ── B3: FARMER cannot touch a farm they do not belong to (unrelated row). ──
set local role authenticated;
set local request.jwt.claims = '{"sub":"000f0000-0000-0000-0000-000000000001","role":"authenticated"}';

update public.farms set farm_name = 'Hijacked', compliance_status = 'Compliant'
where id = '000fa000-0000-0000-0000-000000000002';

reset role;

do $$
declare r public.farms%rowtype;
begin
  select * into r from public.farms where id = '000fa000-0000-0000-0000-000000000002';
  if r.farm_name <> 'Other Farm' then raise exception 'VERIFY B3 FAILED: farmer changed an unrelated farm''s name to %', r.farm_name; end if;
  if r.compliance_status <> 'NonCompliant' then raise exception 'VERIFY B3 FAILED: farmer changed an unrelated farm''s compliance_status'; end if;
  raise notice 'VERIFY B3 PASSED: farmer cannot modify a non-member farm (RLS row gate holds).';
end $$;

-- ── B4: the guard function is not directly callable by client roles. ───────
do $$
begin
  if has_function_privilege('authenticated', 'public.fn_protect_farm_admin_fields()', 'EXECUTE') then
    raise exception 'VERIFY B4 FAILED: authenticated can directly EXECUTE the guard function';
  end if;
  raise notice 'VERIFY B4 PASSED: guard function is not directly executable by authenticated.';
end $$;

-- ── B5: FARMER INSERT cannot self-assign admin fields or spoof ownership. ──
-- The farmer supplies malicious admin values AND a spoofed created_by (= admin).
-- The BEFORE INSERT guard forces created_by = auth.uid() and neutralises every
-- admin-controlled column; the RLS "farms: farmer insert own" WITH CHECK is
-- evaluated AFTER the trigger, so the forced created_by is what is checked/stored.
set local role authenticated;
set local request.jwt.claims = '{"sub":"000f0000-0000-0000-0000-000000000001","role":"authenticated"}';

insert into public.farms
  (id, farm_name, status, compliance_status, export_readiness, risk_level, partner_tier, reviewed_by, created_by)
values
  ('000fa000-0000-0000-0000-000000000003', 'Farmer Created Farm',
   'Approved', 'Compliant', 'Ready', 'Low', 'Platinum',
   '000f0000-0000-0000-0000-000000000002',   -- attempts to set reviewed_by = admin
   '000f0000-0000-0000-0000-000000000002');  -- attempts to spoof created_by = admin

reset role;

do $$
declare r public.farms%rowtype;
begin
  select * into r from public.farms where id = '000fa000-0000-0000-0000-000000000003';
  if r.id is null then raise exception 'VERIFY B5 FAILED: farmer INSERT did not persist a row (RLS/trigger blocked it entirely)'; end if;
  if r.created_by        <> '000f0000-0000-0000-0000-000000000001' then raise exception 'VERIFY B5 FAILED: created_by not forced to the farmer — ownership spoofed (got %)', r.created_by; end if;
  if r.status            <> 'Submitted to DDP' then raise exception 'VERIFY B5 FAILED: status not forced to canonical entry value (got %)', r.status; end if;
  if r.compliance_status is not null then raise exception 'VERIFY B5 FAILED: farmer self-set compliance_status survived (got %)', r.compliance_status; end if;
  if r.export_readiness  is not null then raise exception 'VERIFY B5 FAILED: farmer self-set export_readiness survived (got %)', r.export_readiness; end if;
  if r.risk_level        is not null then raise exception 'VERIFY B5 FAILED: farmer self-set risk_level survived (got %)', r.risk_level; end if;
  if r.partner_tier      is not null then raise exception 'VERIFY B5 FAILED: farmer self-set partner_tier survived (got %)', r.partner_tier; end if;
  if r.reviewed_by       is not null then raise exception 'VERIFY B5 FAILED: farmer self-set reviewed_by survived (got %)', r.reviewed_by; end if;
  if r.farm_name         <> 'Farmer Created Farm' then raise exception 'VERIFY B5 FAILED: allowed column farm_name not preserved (got %)', r.farm_name; end if;
  raise notice 'VERIFY B5 PASSED: farmer INSERT — created_by forced to self, all 7 admin fields neutralised, allowed field preserved.';
end $$;

-- ── B6: DDP ADMIN INSERT may set admin-controlled fields explicitly. ───────
set local role authenticated;
set local request.jwt.claims = '{"sub":"000f0000-0000-0000-0000-000000000002","role":"authenticated"}';

insert into public.farms
  (id, farm_name, status, compliance_status, export_readiness, risk_level, partner_tier, created_by)
values
  ('000fa000-0000-0000-0000-000000000004', 'Admin Created Farm',
   'Approved', 'Compliant', 'Ready', 'Low', 'Gold',
   '000f0000-0000-0000-0000-000000000002');

reset role;

do $$
declare r public.farms%rowtype;
begin
  select * into r from public.farms where id = '000fa000-0000-0000-0000-000000000004';
  if r.id is null then raise exception 'VERIFY B6 FAILED: admin INSERT did not persist a row'; end if;
  if r.status            <> 'Approved'  then raise exception 'VERIFY B6 FAILED: admin INSERT status not honoured (got %)', r.status; end if;
  if r.compliance_status <> 'Compliant' then raise exception 'VERIFY B6 FAILED: admin INSERT compliance_status not honoured (got %)', r.compliance_status; end if;
  if r.export_readiness  <> 'Ready'     then raise exception 'VERIFY B6 FAILED: admin INSERT export_readiness not honoured (got %)', r.export_readiness; end if;
  if r.risk_level        <> 'Low'       then raise exception 'VERIFY B6 FAILED: admin INSERT risk_level not honoured (got %)', r.risk_level; end if;
  if r.partner_tier      <> 'Gold'      then raise exception 'VERIFY B6 FAILED: admin INSERT partner_tier not honoured (got %)', r.partner_tier; end if;
  raise notice 'VERIFY B6 PASSED: ddp_admin INSERT can set admin-controlled fields explicitly.';
end $$;

rollback;

-- ── B7: residue check — after ROLLBACK nothing must survive. ───────────────
-- (Runs outside the rolled-back transaction. Includes the INSERT-test rows and
-- the seeded auth.users rows. Expected: all zero.)
select
  (select count(*) from auth.users where id in
     ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003')) as leftover_auth_users,
  (select count(*) from public.profiles where id in
     ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003')) as leftover_profiles,
  (select count(*) from public.farms where id in
     ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002',
      '000fa000-0000-0000-0000-000000000003','000fa000-0000-0000-0000-000000000004')) as leftover_farms,
  (select count(*) from public.farm_memberships where farm_id in
     ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002')) as leftover_memberships;

do $$
declare v int;
begin
  select
    (select count(*) from auth.users where id in
       ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003'))
    + (select count(*) from public.profiles where id in
       ('000f0000-0000-0000-0000-000000000001','000f0000-0000-0000-0000-000000000002','000f0000-0000-0000-0000-000000000003'))
    + (select count(*) from public.farms where id in
       ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002',
        '000fa000-0000-0000-0000-000000000003','000fa000-0000-0000-0000-000000000004'))
    + (select count(*) from public.farm_memberships where farm_id in
       ('000fa000-0000-0000-0000-000000000001','000fa000-0000-0000-0000-000000000002'))
    into v;
  if v <> 0 then
    raise exception 'VERIFY B7 FAILED: % test row(s) survived rollback — residue present', v;
  end if;
  raise notice 'VERIFY B7 PASSED: no test residue after rollback (farms, profiles, auth.users, memberships all clean).';
end $$;
