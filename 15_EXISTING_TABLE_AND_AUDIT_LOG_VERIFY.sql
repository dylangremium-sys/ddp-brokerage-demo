-- 15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql
-- Read-only verification for 15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql.
--
-- STATUS: SELECT-ONLY verification. Committed and pushed. Migration applied to
--         staging and production; production verification completed 2026-07-11.
--         Repository commit: 496fe043174177173b0db78a33c5a5823c71954f. No
--         CREATE/ALTER/DROP/GRANT/REVOKE/INSERT/UPDATE/DELETE/TRUNCATE.
--         Catalog queries only; it changes nothing.
-- Expected: every result column reads PASS.

-- V1. All 20 public tables: anon AND authenticated LACK
--     TRUNCATE / TRIGGER / REFERENCES / MAINTAIN.  Expect: bad_tables = 0
SELECT 'V1 non_crud_revoked_all20' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS tables_still_holding_any
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) p(priv)
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND has_table_privilege(r.rolname, c.oid, p.priv);

-- V2. Non-audit tables (19): anon AND authenticated RETAIN SELECT/INSERT/UPDATE/DELETE.
--     Expect: missing = 0
SELECT 'V2 crud_intact_non_audit' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS missing_crud_grants
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname <> 'compliance_audit_log'
  AND NOT has_table_privilege(r.rolname, c.oid, p.priv);

-- V3. compliance_audit_log: SELECT+INSERT retained; UPDATE/DELETE/TRUNCATE removed
--     for anon AND authenticated.
SELECT 'V3 audit_log_client_acls' AS check,
       CASE WHEN has_table_privilege('anon','public.compliance_audit_log','SELECT')
             AND has_table_privilege('anon','public.compliance_audit_log','INSERT')
             AND has_table_privilege('authenticated','public.compliance_audit_log','SELECT')
             AND has_table_privilege('authenticated','public.compliance_audit_log','INSERT')
             AND NOT has_table_privilege('anon','public.compliance_audit_log','UPDATE')
             AND NOT has_table_privilege('anon','public.compliance_audit_log','DELETE')
             AND NOT has_table_privilege('anon','public.compliance_audit_log','TRUNCATE')
             AND NOT has_table_privilege('authenticated','public.compliance_audit_log','UPDATE')
             AND NOT has_table_privilege('authenticated','public.compliance_audit_log','DELETE')
             AND NOT has_table_privilege('authenticated','public.compliance_audit_log','TRUNCATE')
            THEN 'PASS' ELSE 'FAIL' END AS result;

-- V4. service_role privileges on the audit log unchanged (retains all 8).
SELECT 'V4 audit_log_service_role_unchanged' AS check,
       CASE WHEN has_table_privilege('service_role','public.compliance_audit_log','SELECT')
             AND has_table_privilege('service_role','public.compliance_audit_log','INSERT')
             AND has_table_privilege('service_role','public.compliance_audit_log','UPDATE')
             AND has_table_privilege('service_role','public.compliance_audit_log','DELETE')
             AND has_table_privilege('service_role','public.compliance_audit_log','TRUNCATE')
             AND has_table_privilege('service_role','public.compliance_audit_log','TRIGGER')
             AND has_table_privilege('service_role','public.compliance_audit_log','REFERENCES')
             AND has_table_privilege('service_role','public.compliance_audit_log','MAINTAIN')
            THEN 'PASS' ELSE 'FAIL' END AS result;

-- V5. Both audit-log guard triggers: on compliance_audit_log, ENABLE ALWAYS ('A'),
--     BEFORE, correct events, correct scope, calling the guard function.
--     Expect exactly 2 rows, both PASS.
SELECT 'V5 '||t.tgname AS check,
       CASE WHEN t.tgenabled = 'A'
             AND (t.tgtype & 2) <> 0                       -- BEFORE
             AND fn.proname = 'prevent_compliance_audit_log_mutation'
             AND (
               (t.tgname = 'compliance_audit_log_no_truncate'
                  AND (t.tgtype & 1) = 0                    -- statement-level
                  AND (t.tgtype & 32) <> 0                  -- TRUNCATE
                  AND (t.tgtype & 16) = 0 AND (t.tgtype & 8) = 0)
               OR
               (t.tgname = 'compliance_audit_log_no_update_delete'
                  AND (t.tgtype & 1) <> 0                   -- row-level
                  AND (t.tgtype & 16) <> 0 AND (t.tgtype & 8) <> 0  -- UPDATE + DELETE
                  AND (t.tgtype & 32) = 0)
             )
            THEN 'PASS' ELSE 'FAIL' END AS result,
       t.tgenabled AS enabled_mode
FROM pg_trigger t
JOIN pg_proc fn ON fn.oid = t.tgfoid
WHERE t.tgrelid = 'public.compliance_audit_log'::regclass
  AND NOT t.tgisinternal
ORDER BY t.tgname;

-- V6. Object counts unchanged; RLS + FORCE RLS unchanged.
SELECT 'V6 counts_and_rls' AS check,
       CASE WHEN tables = 20 AND policies = 43 AND storage_fd = 3
             AND funcs = 6 AND triggers = 4 AND force_rls = 0 AND rls_on = 20
            THEN 'PASS' ELSE 'FAIL' END AS result,
       tables, policies, storage_fd, funcs, triggers, force_rls, rls_on
FROM (
  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r') AS tables,
         (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
         (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
            AND policyname LIKE 'farmer-documents%') AS storage_fd,
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prokind='f') AS funcs,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity) AS force_rls,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) AS rls_on
) x;

-- V7. Migrations 11 / A / B2 remain active; Buyer Pack + FARM_RESAVE remain absent.
SELECT 'V7 prior_migrations_and_absences' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='compliance_audit_log_no_truncate')            -- mig 11
             AND (SELECT count(*) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace
                    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                    WHERE d.defaclrole::regrole::text='postgres' AND n.nspname='public' AND d.defaclobjtype='r'
                      AND a.grantee::regrole::text='anon' AND a.privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES','MAINTAIN')) = 0  -- mig A
             AND NOT has_function_privilege('anon','public.is_ddp_admin()','EXECUTE')                          -- mig B2
             AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname LIKE 'buyer_pack%') = 0                             -- buyer pack absent
             AND to_regprocedure('public.fn_protect_farm_admin_fields()') IS NULL                             -- FARM_RESAVE absent
            THEN 'PASS' ELSE 'FAIL' END AS result;

-- V8. Function ACLs/definitions unchanged: all 6 functions still owner=postgres,
--     SECURITY DEFINER, fixed search_path, and none PUBLIC/anon-executable.
SELECT 'V8 functions_unchanged' AS check,
       CASE WHEN bad = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       bad AS functions_out_of_spec
FROM (
  SELECT count(*) AS bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
    AND ( pg_get_userbyid(p.proowner) <> 'postgres'
       OR NOT p.prosecdef
       OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,array[]::text[])) s WHERE s LIKE 'search_path=%')
       OR has_function_privilege('public', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE') )
) y;
