-- ===========================================================================
-- 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_VERIFY.sql
-- ---------------------------------------------------------------------------
-- Verification for 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql.
--
-- SECTION A (object state) is read-only and safe to run anywhere, including
-- Production. It RAISEs if any required property is missing.
--
-- SECTION B (behaviour) builds an ephemeral fixture and exercises append-only
-- enforcement, the mandatory-reason and mandatory-actor constraints, the CHECK
-- domains and the newest-wins views. It is one BEGIN ... ROLLBACK with NO COMMIT,
-- so it leaves no residue. Run as postgres/superuser against a NON-PRODUCTION
-- project with migration 30 applied. Fixed test ids are asserted absent up front.
-- ===========================================================================


-- ===========================================================================
-- SECTION A — OBJECT STATE (read-only; RAISEs on drift)
-- ===========================================================================
do $$
declare
  t text;
  v_tables text[] := array['risk_overrides','requirement_overrides'];
  v_count int;
begin
  -- V1: both tables exist.
  foreach t in array v_tables loop
    if to_regclass('public.'||t) is null then
      raise exception 'VERIFY A FAILED: public.% does not exist', t;
    end if;
  end loop;

  -- V2: RLS enabled on both.
  foreach t in array v_tables loop
    if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relname=t) then
      raise exception 'VERIFY A FAILED: RLS is not enabled on public.%', t;
    end if;
  end loop;

  -- V3: SELECT and INSERT policies exist; NO update/delete policy does.
  foreach t in array v_tables loop
    select count(*) into v_count from pg_policies
     where schemaname='public' and tablename=t and cmd='SELECT';
    if v_count < 1 then raise exception 'VERIFY A FAILED: no SELECT policy on public.%', t; end if;

    select count(*) into v_count from pg_policies
     where schemaname='public' and tablename=t and cmd='INSERT';
    if v_count < 1 then raise exception 'VERIFY A FAILED: no INSERT policy on public.%', t; end if;

    select count(*) into v_count from pg_policies
     where schemaname='public' and tablename=t and cmd in ('UPDATE','DELETE','ALL');
    if v_count <> 0 then
      raise exception 'VERIFY A FAILED: public.% has % UPDATE/DELETE/ALL policy(ies) — append-only is not enforced by RLS', t, v_count;
    end if;
  end loop;

  -- V4: the INSERT policy pins decided_by to auth.uid() — an admin must not be
  -- able to attribute an override to another admin.
  foreach t in array v_tables loop
    if not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename=t and cmd='INSERT'
         and with_check like '%auth.uid()%' and with_check like '%decided_by%'
    ) then
      raise exception 'VERIFY A FAILED: public.% INSERT policy does not pin decided_by = auth.uid()', t;
    end if;
    -- ...and is admin-gated.
    if not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename=t and cmd='INSERT'
         and with_check like '%is_ddp_admin%'
    ) then
      raise exception 'VERIFY A FAILED: public.% INSERT policy is not admin-gated', t;
    end if;
  end loop;

  -- V5: append-only trigger present on both, firing BEFORE UPDATE OR DELETE.
  if not exists (select 1 from pg_trigger where tgrelid='public.risk_overrides'::regclass
                  and tgname='trg_prevent_risk_override_mutation' and not tgisinternal) then
    raise exception 'VERIFY A FAILED: append-only trigger missing on public.risk_overrides';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.requirement_overrides'::regclass
                  and tgname='trg_prevent_requirement_override_mutation' and not tgisinternal) then
    raise exception 'VERIFY A FAILED: append-only trigger missing on public.requirement_overrides';
  end if;

  -- V6: `authenticated` holds NEITHER UPDATE NOR DELETE (the check migration 17's
  -- own V6 exists for — Supabase grants CRUD by default, so this must be revoked
  -- explicitly or the append-only claim is contradicted at the privilege layer).
  foreach t in array v_tables loop
    if has_table_privilege('authenticated', 'public.'||t, 'UPDATE') then
      raise exception 'VERIFY A FAILED: authenticated holds UPDATE on public.%', t;
    end if;
    if has_table_privilege('authenticated', 'public.'||t, 'DELETE') then
      raise exception 'VERIFY A FAILED: authenticated holds DELETE on public.%', t;
    end if;
    if not has_table_privilege('authenticated', 'public.'||t, 'SELECT') then
      raise exception 'VERIFY A FAILED: authenticated lacks SELECT on public.% (the app cannot read the authoritative state)', t;
    end if;
    if not has_table_privilege('authenticated', 'public.'||t, 'INSERT') then
      raise exception 'VERIFY A FAILED: authenticated lacks INSERT on public.%', t;
    end if;
  end loop;

  -- V7: anon has nothing at all.
  foreach t in array v_tables loop
    if has_table_privilege('anon', 'public.'||t, 'SELECT')
       or has_table_privilege('anon', 'public.'||t, 'INSERT') then
      raise exception 'VERIFY A FAILED: anon holds privileges on public.%', t;
    end if;
  end loop;

  -- V8: decided_by is NOT NULL and defaults to auth.uid() — the actor is captured
  -- server-side and cannot be omitted.
  foreach t in array v_tables loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name=t and column_name='decided_by'
         and is_nullable='NO' and column_default like '%auth.uid()%'
    ) then
      raise exception 'VERIFY A FAILED: public.%.decided_by is not NOT NULL DEFAULT auth.uid()', t;
    end if;
  end loop;

  -- V9: reason is mandatory and non-blank. An override without a stated reason is
  -- not an audit record.
  foreach t in array v_tables loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name=t and column_name='reason' and is_nullable='NO'
    ) then
      raise exception 'VERIFY A FAILED: public.%.reason is nullable', t;
    end if;
  end loop;

  -- V10: the newest-wins views exist and are security_invoker (so a caller cannot
  -- read past their own RLS through the view).
  foreach t in array array['risk_overrides_current','requirement_overrides_current'] loop
    if to_regclass('public.'||t) is null then
      raise exception 'VERIFY A FAILED: view public.% does not exist', t;
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=t
         and array_to_string(c.reloptions,',') like '%security_invoker=%'
    ) then
      raise exception 'VERIFY A FAILED: view public.% is not security_invoker', t;
    end if;
  end loop;

  -- V11: the trigger functions are callable by NOBODY directly.
  foreach t in array array['prevent_risk_override_mutation','prevent_requirement_override_mutation'] loop
    if has_function_privilege('authenticated', 'public.'||t||'()', 'EXECUTE')
       or has_function_privilege('anon', 'public.'||t||'()', 'EXECUTE') then
      raise exception 'VERIFY A FAILED: public.%() is directly EXECUTEable by a client role', t;
    end if;
    -- ...and have a pinned search_path.
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=t
         and array_to_string(coalesce(p.proconfig,'{}'),',') like '%search_path=%'
    ) then
      raise exception 'VERIFY A FAILED: public.%() has no pinned search_path', t;
    end if;
  end loop;

  -- V12: risk_overrides is keyed on the CONTENT-BOUND risk id, not a bare batch
  -- id. A `batch_id` column here would reintroduce audit finding F1a server-side.
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='risk_overrides'
                and column_name in ('batch_id','item_id')) then
    raise exception 'VERIFY A FAILED: risk_overrides is keyed on a bare entity id — this reintroduces F1a (an override surviving a change in the risk it cleared)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='risk_overrides' and column_name='risk_id') then
    raise exception 'VERIFY A FAILED: risk_overrides has no risk_id column';
  end if;

  raise notice 'VERIFY A PASSED: both override tables are append-only (trigger + no UPDATE/DELETE policy + no authenticated UPDATE/DELETE privilege), admin-gated, actor-attributed via auth.uid(), reason-mandatory, exposed through security_invoker newest-wins views, and risk overrides are keyed on the content-bound risk id.';
end $$;

-- Human-readable object-state summary (informational).
select
  to_regclass('public.risk_overrides')                is not null as risk_table_present,
  to_regclass('public.requirement_overrides')         is not null as requirement_table_present,
  to_regclass('public.risk_overrides_current')        is not null as risk_view_present,
  to_regclass('public.requirement_overrides_current') is not null as requirement_view_present,
  not has_table_privilege('authenticated','public.risk_overrides','UPDATE')        as risk_no_authenticated_update,
  not has_table_privilege('authenticated','public.requirement_overrides','DELETE') as req_no_authenticated_delete;


-- ===========================================================================
-- SECTION B — BEHAVIOUR (ephemeral fixture; BEGIN ... ROLLBACK; no COMMIT)
-- ===========================================================================
begin;

-- Fixed test identity (rolled back; asserted absent below).
--   admin 00100000-0000-0000-0000-000000000001
do $$
begin
  if exists (select 1 from auth.users where id = '00100000-0000-0000-0000-000000000001')
     or exists (select 1 from public.profiles where id = '00100000-0000-0000-0000-000000000001') then
    raise exception 'VERIFY B PRECONDITION FAILED: test admin id already exists — aborting to protect real data';
  end if;
  if exists (select 1 from public.risk_overrides where risk_id like 'RO30-%')
     or exists (select 1 from public.requirement_overrides where farm_id like 'RO30-%') then
    raise exception 'VERIFY B PRECONDITION FAILED: RO30-%% test rows already exist — aborting to protect real data';
  end if;
end $$;

set local session_replication_role = replica;
insert into auth.users (id, email) values
  ('00100000-0000-0000-0000-000000000001', 'verify-30-admin@example.invalid');
insert into public.profiles (id, email, role) values
  ('00100000-0000-0000-0000-000000000001', 'verify-30-admin@example.invalid', 'ddp_admin');
set local session_replication_role = origin;

-- Act as the seeded ddp_admin. Both GUC forms are set so this file runs unmodified
-- against the hosted platform AND the repo's disposable-Postgres substrate shim
-- (scripts/disposable-pg/bootstrap/00_supabase_substrate.sql reads the singular form).
set local request.jwt.claims = '{"sub":"00100000-0000-0000-0000-000000000001","role":"authenticated"}';
set local request.jwt.claim.sub = '00100000-0000-0000-0000-000000000001';

-- ── B1: a valid override inserts, and the actor is captured server-side ──────
do $$
declare v_actor uuid;
begin
  insert into public.risk_overrides (risk_id, status, reason)
    values ('RO30-risk-batch-1#deadbeef', 'resolved', 'COA received and reviewed');
  select decided_by into v_actor from public.risk_overrides where risk_id='RO30-risk-batch-1#deadbeef';
  if v_actor is distinct from '00100000-0000-0000-0000-000000000001'::uuid then
    raise exception 'VERIFY B1 FAILED: decided_by was not captured from auth.uid() (got %)', v_actor;
  end if;
  raise notice 'VERIFY B1 PASSED: override inserts and the actor is captured server-side from auth.uid().';
end $$;

-- ── B2: a blank or missing reason is refused ────────────────────────────────
do $$
declare v_raised boolean;
begin
  v_raised := false;
  begin
    insert into public.risk_overrides (risk_id, status, reason)
      values ('RO30-risk-blank', 'resolved', '   ');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'VERIFY B2 FAILED: a blank reason was accepted'; end if;

  v_raised := false;
  begin
    insert into public.requirement_overrides (farm_id, requirement_type, status, reason)
      values ('RO30-farm-1', 'farm_license', 'verified', '');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'VERIFY B2 FAILED: an empty reason was accepted on requirement_overrides'; end if;
  raise notice 'VERIFY B2 PASSED: a blank/empty reason is refused on both tables.';
end $$;

-- ── B3: an out-of-domain status is refused ──────────────────────────────────
do $$
declare v_raised boolean;
begin
  v_raised := false;
  begin
    insert into public.risk_overrides (risk_id, status, reason)
      values ('RO30-risk-bad', 'cleared', 'not a RiskStatus value');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'VERIFY B3 FAILED: an out-of-domain risk status was accepted'; end if;
  raise notice 'VERIFY B3 PASSED: the status CHECK domain is enforced.';
end $$;

-- ── B4: every status the operator UI offers IS persistable. A CHECK that
--        rejected one would silently lose that override. ────────────────────
do $$
declare s text;
begin
  foreach s in array array['open','in_review','resolved','accepted'] loop
    insert into public.risk_overrides (risk_id, status, reason)
      values ('RO30-risk-domain-'||s, s, 'domain check');
  end loop;
  foreach s in array array['missing','claimed','documented','reviewed','verified','rejected','expired'] loop
    insert into public.requirement_overrides (farm_id, requirement_type, status, reason)
      values ('RO30-farm-domain', s, s, 'domain check');
  end loop;
  raise notice 'VERIFY B4 PASSED: every RiskStatus and EvidenceStatus the UI offers is persistable.';
end $$;

-- ── B5: APPEND-ONLY. UPDATE and DELETE are both refused. ────────────────────
do $$
declare v_raised boolean; v_msg text;
begin
  v_raised := false;
  begin
    update public.risk_overrides set status='open' where risk_id='RO30-risk-batch-1#deadbeef';
  exception when others then v_raised := true; v_msg := SQLERRM;
  end;
  if not v_raised then raise exception 'VERIFY B5 FAILED: UPDATE on risk_overrides was permitted'; end if;
  if position('append-only' in v_msg) = 0 then
    raise exception 'VERIFY B5 FAILED: UPDATE refusal was not the append-only trigger. Got: %', v_msg;
  end if;

  v_raised := false;
  begin
    delete from public.risk_overrides where risk_id='RO30-risk-batch-1#deadbeef';
  exception when others then v_raised := true; v_msg := SQLERRM;
  end;
  if not v_raised then raise exception 'VERIFY B5 FAILED: DELETE on risk_overrides was permitted'; end if;

  v_raised := false;
  begin
    update public.requirement_overrides set status='missing' where farm_id='RO30-farm-domain';
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'VERIFY B5 FAILED: UPDATE on requirement_overrides was permitted'; end if;

  v_raised := false;
  begin
    delete from public.requirement_overrides where farm_id='RO30-farm-domain';
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'VERIFY B5 FAILED: DELETE on requirement_overrides was permitted'; end if;

  raise notice 'VERIFY B5 PASSED: UPDATE and DELETE are refused on both tables — history cannot be rewritten.';
end $$;

-- ── B6: NEWEST WINS. Re-overriding appends, and the _current view reflects the
--        latest row while the earlier one survives as history. ──────────────
do $$
declare v_status text; v_reason text; v_rows int;
begin
  insert into public.risk_overrides (risk_id, status, reason, decided_at)
    values ('RO30-risk-seq', 'resolved', 'first call', '2026-01-01 00:00:00+00');
  insert into public.risk_overrides (risk_id, status, reason, decided_at)
    values ('RO30-risk-seq', 'open', 'reopened after new lab result', '2026-02-01 00:00:00+00');

  select status, reason into v_status, v_reason
    from public.risk_overrides_current where risk_id='RO30-risk-seq';
  if v_status <> 'open' then
    raise exception 'VERIFY B6 FAILED: risk_overrides_current returned % — newest row does not win', v_status;
  end if;
  if v_reason <> 'reopened after new lab result' then
    raise exception 'VERIFY B6 FAILED: the view returned a stale reason (%)', v_reason;
  end if;

  select count(*) into v_rows from public.risk_overrides where risk_id='RO30-risk-seq';
  if v_rows <> 2 then
    raise exception 'VERIFY B6 FAILED: expected 2 history rows, got % — history is not preserved', v_rows;
  end if;

  raise notice 'VERIFY B6 PASSED: re-overriding appends; the _current view returns the newest row and the earlier one survives as history.';
end $$;

-- ── B7: the requirement view is keyed on the PAIR, so two requirement types on
--        the same farm do not collide. ────────────────────────────────────────
do $$
declare v_a text; v_b text;
begin
  insert into public.requirement_overrides (farm_id, requirement_type, status, reason)
    values ('RO30-farm-pair', 'farm_license', 'verified', 'licence on file'),
           ('RO30-farm-pair', 'gacp_evidence', 'rejected', 'certificate expired');
  select status into v_a from public.requirement_overrides_current
    where farm_id='RO30-farm-pair' and requirement_type='farm_license';
  select status into v_b from public.requirement_overrides_current
    where farm_id='RO30-farm-pair' and requirement_type='gacp_evidence';
  if v_a <> 'verified' or v_b <> 'rejected' then
    raise exception 'VERIFY B7 FAILED: (farm_id, requirement_type) rows collided (got %, %)', v_a, v_b;
  end if;
  raise notice 'VERIFY B7 PASSED: requirement overrides are keyed on the (farm_id, requirement_type) pair.';
end $$;

-- ── B8: a content-bound risk id is stored verbatim, so two fingerprints of the
--        same batch are DISTINCT overrides. This is the server-side counterpart
--        of the F1a fix: a clearance must not travel to changed risk content. ─
do $$
declare v_resolved text; v_other text; v_n int;
begin
  insert into public.risk_overrides (risk_id, status, reason)
    values ('RO30-risk-batch-9#aaaaaaaa', 'resolved', 'cosmetic gap cleared');
  select status into v_resolved from public.risk_overrides_current
    where risk_id='RO30-risk-batch-9#aaaaaaaa';
  if v_resolved <> 'resolved' then
    raise exception 'VERIFY B8 FAILED: the override did not apply to its own fingerprint';
  end if;
  -- The SAME batch with different risk content is a different key entirely.
  select count(*) into v_n from public.risk_overrides_current
    where risk_id='RO30-risk-batch-9#bbbbbbbb';
  if v_n <> 0 then
    raise exception 'VERIFY B8 FAILED: an override matched a DIFFERENT risk fingerprint on the same batch — F1a is reintroduced server-side';
  end if;
  select into v_other status from public.risk_overrides_current where risk_id like 'RO30-risk-batch-9#%' and risk_id <> 'RO30-risk-batch-9#aaaaaaaa';
  if v_other is not null then
    raise exception 'VERIFY B8 FAILED: unexpected sibling override row';
  end if;
  raise notice 'VERIFY B8 PASSED: overrides are keyed on the content-bound risk id — a changed fingerprint carries no clearance.';
end $$;

rollback;

-- Residue check — run AFTER the rollback above. Every count must be zero.
select
  (select count(*) from public.risk_overrides        where risk_id like 'RO30-%') as risk_rows_left,
  (select count(*) from public.requirement_overrides where farm_id like 'RO30-%') as requirement_rows_left,
  (select count(*) from auth.users where id = '00100000-0000-0000-0000-000000000001') as users_left,
  (select count(*) from public.profiles where id = '00100000-0000-0000-0000-000000000001') as profiles_left;
