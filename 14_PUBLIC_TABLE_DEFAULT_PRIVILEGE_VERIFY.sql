-- 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql
-- Read-only verification for 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql.
--
-- STATUS: SELECT-ONLY verification. Committed and pushed. Migration applied to
--         staging and production; production verification completed 2026-07-11.
--         Repository commit: d6aee658c236e588027b880e34ad47c9277262c4. Contains no
--         CREATE/ALTER/DROP/GRANT/REVOKE/INSERT/UPDATE/DELETE/TRUNCATE. It
--         changes nothing. Catalog queries only.
--
-- Expected: every row's result column reads PASS.

-- V1. Stored default table ACLs (role postgres, schema public), per grantee.
--     Reference view — read alongside V2/V3.
SELECT acl.grantee::regrole::text AS grantee,
       string_agg(acl.privilege_type, ',' ORDER BY acl.privilege_type) AS default_privileges
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
WHERE d.defaclrole::regrole::text = 'postgres'
  AND n.nspname = 'public'
  AND d.defaclobjtype = 'r'
GROUP BY 1
ORDER BY 1;

-- V2. Future defaults for anon and authenticated:
--     CRUD present; TRUNCATE/TRIGGER/REFERENCES/MAINTAIN absent.
SELECT grantee,
       CASE WHEN has_del AND has_ins AND has_sel AND has_upd
             AND NOT has_trunc AND NOT has_trig AND NOT has_ref AND NOT has_maint
            THEN 'PASS' ELSE 'FAIL' END AS result,
       privs
FROM (
  SELECT acl.grantee::regrole::text AS grantee,
         string_agg(acl.privilege_type, ',' ORDER BY acl.privilege_type) AS privs,
         bool_or(acl.privilege_type = 'DELETE')     AS has_del,
         bool_or(acl.privilege_type = 'INSERT')     AS has_ins,
         bool_or(acl.privilege_type = 'SELECT')     AS has_sel,
         bool_or(acl.privilege_type = 'UPDATE')     AS has_upd,
         bool_or(acl.privilege_type = 'TRUNCATE')   AS has_trunc,
         bool_or(acl.privilege_type = 'TRIGGER')    AS has_trig,
         bool_or(acl.privilege_type = 'REFERENCES') AS has_ref,
         bool_or(acl.privilege_type = 'MAINTAIN')   AS has_maint
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  WHERE d.defaclrole::regrole::text = 'postgres'
    AND n.nspname = 'public'
    AND d.defaclobjtype = 'r'
    AND acl.grantee::regrole::text IN ('anon', 'authenticated')
  GROUP BY 1
) x
ORDER BY grantee;

-- V3. service_role and postgres defaults unchanged (all eight privileges).
SELECT grantee,
       CASE WHEN cnt = 8 THEN 'PASS' ELSE 'FAIL' END AS result,
       privs
FROM (
  SELECT acl.grantee::regrole::text AS grantee,
         count(*) AS cnt,
         string_agg(acl.privilege_type, ',' ORDER BY acl.privilege_type) AS privs
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  WHERE d.defaclrole::regrole::text = 'postgres'
    AND n.nspname = 'public'
    AND d.defaclobjtype = 'r'
    AND acl.grantee::regrole::text IN ('service_role', 'postgres')
  GROUP BY 1
) x
ORDER BY grantee;

-- V4. EXISTING tables unaffected: a known existing table still grants anon the
--     full set (proves default-privilege change did NOT touch existing objects).
SELECT 'existing table public.farms unchanged for anon' AS check,
       CASE WHEN has_table_privilege('anon', 'public.farms', 'TRUNCATE')
             AND has_table_privilege('anon', 'public.farms', 'TRIGGER')
             AND has_table_privilege('anon', 'public.farms', 'SELECT')
            THEN 'PASS' ELSE 'FAIL' END AS result;

-- V5. Baseline object counts unchanged (20 tables → also confirms no Buyer Pack
--     table was introduced; 6 functions → no Buyer Pack function).
SELECT 'object counts' AS check,
       CASE WHEN tables = 20 AND policies = 43 AND storage_fd = 3
             AND app_funcs = 6 AND pub_triggers = 4 AND force_rls = 0
            THEN 'PASS' ELSE 'FAIL' END AS result,
       tables, policies, storage_fd, app_funcs, pub_triggers, force_rls
FROM (
  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies,
         (SELECT count(*) FROM pg_policies
            WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname LIKE 'farmer-documents%') AS storage_fd,
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f') AS app_funcs,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS pub_triggers,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity) AS force_rls
) x;

-- V6. Migration 11 remains active; FARM_RESAVE guard remains absent.
SELECT 'mig11 active & farm-resave absent' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'compliance_audit_log_no_truncate')
             AND to_regprocedure('public.fn_protect_farm_admin_fields()') IS NULL
            THEN 'PASS' ELSE 'FAIL' END AS result;
