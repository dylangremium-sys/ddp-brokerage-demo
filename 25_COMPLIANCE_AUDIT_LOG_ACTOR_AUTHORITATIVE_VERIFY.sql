-- =============================================================================
-- 25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_VERIFY.sql
-- =============================================================================
-- Verification for 25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql.
--
-- SECTION A (object state) is read-only and safe to run anywhere, including
-- production: it only inspects catalogs and RAISEs if the guard is wrong.
--
-- SECTION B (behaviour) proves that a CLIENT-SUPPLIED actor_id is OVERRIDDEN with
-- auth.uid(): it impersonates an admin via the request JWT, inserts an audit row
-- claiming a DIFFERENT actor, and asserts the STORED actor is the authenticated
-- caller, not the forged value. It is wrapped in a single BEGIN ... ROLLBACK, does
-- NO COMMIT, uses fixed test UUIDs asserted absent up front, and ends with a
-- residue check, so it leaves nothing behind. Run in the Supabase SQL Editor
-- (postgres/superuser) against a NON-PRODUCTION project.
-- =============================================================================

-- =============================================================================
-- SECTION A — OBJECT STATE (read-only; RAISEs on any drift)
-- =============================================================================
do $$
declare
  v_oid          oid;
  v_config       text[];
  v_src          text;
  v_search_path  text;
  v_trig_count   int;
  v_trig_insert  boolean;
  v_auth_can_exec boolean;
begin
  select p.oid, p.proconfig, p.prosrc
    into v_oid, v_config, v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'fn_compliance_audit_log_set_actor';

  if v_oid is null then
    raise exception 'VERIFY A FAILED: public.fn_compliance_audit_log_set_actor() does not exist';
  end if;

  -- Fixed, safe search_path (not a mutable-search_path escalation vector).
  v_search_path := (select c from unnest(coalesce(v_config, '{}')) c where c like 'search_path=%');
  if v_search_path is null then
    raise exception 'VERIFY A FAILED: function has no fixed search_path (mutable search_path)';
  end if;
  if position('public' in v_search_path) = 0 or position('pg_temp' in v_search_path) = 0 then
    raise exception 'VERIFY A FAILED: search_path is not "public, auth, pg_temp": %', v_search_path;
  end if;

  -- Body forces actor_id from auth.uid() and does not trust a client value.
  if v_src !~* 'new\.actor_id\s*:=\s*auth\.uid\s*\(\s*\)' then
    raise exception 'VERIFY A FAILED: function does not force NEW.actor_id := auth.uid()';
  end if;

  -- Trigger is BEFORE INSERT on compliance_audit_log, enabled.
  select count(*),
         bool_or((t.tgtype & 2) <> 0 and (t.tgtype & 4) <> 0) -- BEFORE (2) + INSERT (4)
    into v_trig_count, v_trig_insert
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'compliance_audit_log'
    and t.tgname = 'compliance_audit_log_set_actor' and not t.tgisinternal;
  if v_trig_count <> 1 then
    raise exception 'VERIFY A FAILED: expected exactly 1 compliance_audit_log_set_actor trigger, found %', v_trig_count;
  end if;
  if not v_trig_insert then
    raise exception 'VERIFY A FAILED: trigger is not BEFORE INSERT';
  end if;

  -- Least privilege: not directly executable by a client role.
  v_auth_can_exec := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  if v_auth_can_exec then
    raise exception 'VERIFY A FAILED: authenticated retains EXECUTE on the trigger function (must be revoked)';
  end if;

  raise notice 'VERIFY A PASSED: actor-stamp trigger present, BEFORE INSERT, pinned search_path, forces auth.uid(), not client-executable.';
end $$;

-- =============================================================================
-- SECTION B — BEHAVIOUR (ephemeral fixture; BEGIN/ROLLBACK; no residue)
-- =============================================================================
begin;

do $$
declare
  admin_id  uuid := '000ca000-0000-0000-0000-000000000001';
  victim_id uuid := '000ca000-0000-0000-0000-000000000002';
  v_stored  uuid;
  v_n       int;
begin
  -- Precondition: test identities must not already exist (no collision with real data).
  if exists (select 1 from auth.users where id in (admin_id, victim_id)) then
    raise exception 'VERIFY B ABORTED: a test UUID already exists in auth.users';
  end if;

  -- Seed identities (replica: bypass FK/side-effect triggers during setup only).
  set local session_replication_role = replica;
  insert into auth.users (id) values (admin_id), (victim_id);
  insert into public.profiles (id, role) values (admin_id, 'ddp_admin')
    on conflict (id) do update set role = 'ddp_admin';
  set local session_replication_role = origin;

  -- Impersonate the admin via the request JWT (auth.uid() → admin_id).
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- B1: a FORGED actor_id (victim) must be overridden with the caller (admin).
  insert into public.compliance_audit_log (actor_type, actor_id, action, entity_type, entity_id, reason)
    values ('admin', victim_id, 'rule_approved', 'rule', 'rule-1', 'attempt to forge actor');
  select actor_id into v_stored from public.compliance_audit_log
    where entity_id = 'rule-1' order by created_at desc limit 1;
  if v_stored is distinct from admin_id then
    raise exception 'VERIFY B1 FAILED: forged actor_id was stored as % (expected the authenticated caller %)', v_stored, admin_id;
  end if;

  -- B2: a NULL actor_id must also be stamped with the caller, never left null.
  insert into public.compliance_audit_log (actor_type, actor_id, action, entity_type, entity_id, reason)
    values ('admin', null, 'rule_approved', 'rule', 'rule-2', 'null actor');
  select actor_id into v_stored from public.compliance_audit_log
    where entity_id = 'rule-2' order by created_at desc limit 1;
  if v_stored is distinct from admin_id then
    raise exception 'VERIFY B2 FAILED: null actor_id was stored as % (expected the authenticated caller %)', v_stored, admin_id;
  end if;

  -- B3: a matching actor_id (the honest path) is preserved.
  insert into public.compliance_audit_log (actor_type, actor_id, action, entity_type, entity_id, reason)
    values ('admin', admin_id, 'rule_approved', 'rule', 'rule-3', 'honest actor');
  select actor_id into v_stored from public.compliance_audit_log
    where entity_id = 'rule-3' order by created_at desc limit 1;
  if v_stored is distinct from admin_id then
    raise exception 'VERIFY B3 FAILED: honest actor_id was not preserved (stored %)', v_stored;
  end if;

  perform set_config('request.jwt.claims', '', true);

  -- Non-vacuity: the three rows really were created under this fixture.
  select count(*) into v_n from public.compliance_audit_log where entity_id in ('rule-1','rule-2','rule-3');
  if v_n <> 3 then
    raise exception 'VERIFY B FAILED: expected 3 fixture rows, found % (test would be vacuous)', v_n;
  end if;

  raise notice 'VERIFY B PASSED: forged and null actor_id are both overridden with auth.uid(); honest actor preserved.';
end $$;

rollback;

-- Post-rollback residue check (runs OUTSIDE the rolled-back transaction).
do $$
declare v_users int; v_rows int;
begin
  select count(*) into v_users from auth.users where id in ('000ca000-0000-0000-0000-000000000001','000ca000-0000-0000-0000-000000000002');
  select count(*) into v_rows  from public.compliance_audit_log where entity_id in ('rule-1','rule-2','rule-3');
  if v_users <> 0 then raise exception 'VERIFY RESIDUE FAILED: % seeded auth.users row(s) survived rollback', v_users; end if;
  if v_rows  <> 0 then raise exception 'VERIFY RESIDUE FAILED: % audit row(s) survived rollback', v_rows; end if;
  raise notice 'VERIFY RESIDUE PASSED: no fixture rows or seeded identities survived the rollback.';
end $$;
