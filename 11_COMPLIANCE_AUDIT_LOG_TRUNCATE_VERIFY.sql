-- 11_COMPLIANCE_AUDIT_LOG_TRUNCATE_VERIFY.sql
-- Read-only verification for 11_COMPLIANCE_AUDIT_LOG_TRUNCATE_HARDENING.sql.
--
-- STATUS: PREPARED — SELECT-ONLY. Safe to run by hand in the Supabase SQL
--         editor. Contains NO CREATE/ALTER/DROP/GRANT/REVOKE/INSERT/UPDATE/
--         DELETE/TRUNCATE. It changes nothing. Expected results are inline;
--         if any check disagrees, do not assume the migration succeeded.
--
-- Run each block individually. All blocks target only public.compliance_audit_log
-- and its guard function.

-- ---------------------------------------------------------------------------
-- C1. Table exists, RLS enabled, row-force flag stays false.
--     Expect: rls_enabled = t, row_force_flag = f
-- ---------------------------------------------------------------------------
SELECT c.relname            AS table_name,
       c.relrowsecurity     AS rls_enabled,
       c.relforcerowsecurity AS row_force_flag,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'compliance_audit_log';

-- ---------------------------------------------------------------------------
-- C2. Existing RLS policies unchanged: exactly the admin INSERT + admin SELECT.
--     Expect 2 rows, and ZERO rows with cmd IN ('UPDATE','DELETE','ALL').
--       admin insert : cmd = INSERT, with_check = is_ddp_admin()
--       admin select : cmd = SELECT, qual       = is_ddp_admin()
-- ---------------------------------------------------------------------------
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename  = 'compliance_audit_log'
ORDER BY cmd, policyname;

-- ---------------------------------------------------------------------------
-- C3. Triggers on the table: the existing row-level UPDATE/DELETE guard MUST
--     remain, and the new statement-level TRUNCATE guard MUST be present.
--     tgtype bitmask: 1=ROW, 2=BEFORE, 4=INSERT, 8=DELETE, 16=UPDATE, 32=TRUNCATE
--
--     Expect exactly 2 rows:
--       compliance_audit_log_no_truncate      : before=t row_level=f truncate=t
--                                                (insert/update/delete = f)
--       compliance_audit_log_no_update_delete : before=t row_level=t update=t
--                                                delete=t truncate=f
--     Both: enabled = 'O', function = prevent_compliance_audit_log_mutation
-- ---------------------------------------------------------------------------
SELECT t.tgname                       AS trigger_name,
       (t.tgtype & 2)  <> 0           AS is_before,
       (t.tgtype & 1)  <> 0           AS is_row_level,   -- false => statement-level
       (t.tgtype & 4)  <> 0           AS on_insert,
       (t.tgtype & 8)  <> 0           AS on_delete,
       (t.tgtype & 16) <> 0           AS on_update,
       (t.tgtype & 32) <> 0           AS on_truncate,
       t.tgenabled                    AS enabled,
       fn_ns.nspname                  AS function_schema,
       fn.proname                     AS function_name
FROM pg_trigger t
JOIN pg_proc fn        ON fn.oid = t.tgfoid
JOIN pg_namespace fn_ns ON fn_ns.oid = fn.pronamespace
WHERE t.tgrelid = 'public.compliance_audit_log'::regclass
  AND NOT t.tgisinternal
ORDER BY t.tgname;

-- ---------------------------------------------------------------------------
-- C4. Guard function unchanged in the ways that matter:
--     owner = postgres, security_definer = t, config carries a fixed search_path.
--     Expect: security_definer = t, owner = postgres,
--             config contains 'search_path=public'
-- ---------------------------------------------------------------------------
SELECT p.proname                       AS function_name,
       pg_get_userbyid(p.proowner)     AS owner,
       p.prosecdef                     AS security_definer,
       p.proconfig                     AS config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'prevent_compliance_audit_log_mutation';

-- ---------------------------------------------------------------------------
-- C5. EXECUTE on the guard function after the migration.
--     Expect: anon = f, authenticated = f, service_role = t, postgres = t
-- ---------------------------------------------------------------------------
SELECT r.rolname AS role,
       has_function_privilege(
         r.rolname,
         'public.prevent_compliance_audit_log_mutation()',
         'EXECUTE') AS has_execute
FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('postgres')) AS r(rolname)
ORDER BY r.rolname;

-- ---------------------------------------------------------------------------
-- C6. Same EXECUTE picture straight from the function ACL (materialised after
--     the REVOKEs). Expect NO row where grantee is PUBLIC, anon, or
--     authenticated; service_role (and the owner) may remain.
-- ---------------------------------------------------------------------------
SELECT COALESCE(acl.grantee::regrole::text, 'PUBLIC') AS grantee,
       acl.privilege_type
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(p.proacl) acl
WHERE p.oid = 'public.prevent_compliance_audit_log_mutation()'::regprocedure
ORDER BY grantee;

-- ---------------------------------------------------------------------------
-- C7. Scope guard #1 — no relation in public gained a forced row-security flag.
--     (Confirms this migration introduced no row-force change anywhere.)
--     Expect: forced_public_relations = 0
-- ---------------------------------------------------------------------------
SELECT count(*) AS forced_public_relations
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relforcerowsecurity;

-- ---------------------------------------------------------------------------
-- C8. Scope guard #2 — the only non-internal triggers this migration is
--     responsible for live on compliance_audit_log. No object from the
--     unapplied draft migration #10, and no managed-schema object, is
--     referenced or created by this migration (structural: the hardening file
--     names no such object). This count re-confirms the table's trigger set.
--     Expect: audit_log_triggers = 2
-- ---------------------------------------------------------------------------
SELECT count(*) AS audit_log_triggers
FROM pg_trigger t
WHERE t.tgrelid = 'public.compliance_audit_log'::regclass
  AND NOT t.tgisinternal;
