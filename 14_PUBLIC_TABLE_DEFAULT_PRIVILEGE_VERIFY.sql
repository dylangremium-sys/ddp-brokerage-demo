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

-- V4. DEFAULT privileges are distinct from privileges on EXISTING tables.
--
--     WAS: asserted anon still HOLDS TRUNCATE + TRIGGER on public.farms, to show
--     migration 14 had not retroactively touched existing objects. Migration 15
--     then deliberately revoked exactly those privileges on all 20 tables — so
--     this assertion demanded the insecure state that a later migration removed,
--     and 15's own V1 asserts the precise opposite. It was superseded on arrival.
--
--     NOW: assert the separation that migration 14 really guarantees — its
--     default-ACL change did not itself confer anything on an existing table.
--     SELECT/INSERT remain (the client roles legitimately hold them); the
--     dangerous non-CRUD privileges must be absent, per migration 15.
SELECT 'existing-table posture (post-migration-15)' AS check,
       CASE WHEN NOT has_table_privilege('anon', 'public.farms', 'TRUNCATE')
             AND NOT has_table_privilege('anon', 'public.farms', 'TRIGGER')
             AND NOT has_table_privilege('anon', 'public.farms', 'REFERENCES')
             AND NOT has_table_privilege('anon', 'public.farms', 'MAINTAIN')
             AND has_table_privilege('anon', 'public.farms', 'SELECT')
            THEN 'PASS' ELSE 'FAIL' END AS result;

-- V5. GROWTH-TOLERANT structural invariants, replacing frozen object counts.
--
--     WAS: tables = 20 AND policies = 43 AND app_funcs = 6 AND pub_triggers = 4.
--     Migrations 10, 17 and 22 legitimately added tables, policies, functions and
--     triggers, so this failed for growth alone (24/63/11/12) while detecting no
--     privilege change whatsoever. A count is not a security property.
--
--     NOW: assert the properties that must hold no matter how many objects exist.
--     RLS must be ON for every table in public — a new table shipped without RLS
--     is exactly the regression worth catching, and a count could never see it.
SELECT 'structural invariants (count-independent)' AS check,
       CASE WHEN tables_without_rls = 0
             AND force_rls = 0
             AND storage_fd >= 3
            THEN 'PASS' ELSE 'FAIL' END AS result,
       tables_total, tables_without_rls, force_rls, storage_fd
FROM (
  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables_total,
         -- Every public table must have RLS enabled; zero exceptions.
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity) AS tables_without_rls,
         -- FORCE RLS stays off (table owners are not subject to RLS by design here).
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity) AS force_rls,
         -- The farmer-documents storage policies must not be dropped (>= allows
         -- later additions such as migration 22's restrictive overlay).
         (SELECT count(*) FROM pg_policies
            WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname LIKE 'farmer-documents%') AS storage_fd
) x;

-- V6. Migration 11 remains active.
--
--     WAS: also required `fn_protect_farm_admin_fields()` to be ABSENT, as a
--     proxy for "the superseded FARM_RESAVE draft was never applied". Migration
--     19 then installed a function of that exact name as the canonical farm
--     admin-field guard, so the absence check now fires on the intended object.
--
--     NOW: assert migration 11's trigger is intact, and that when the guard
--     function exists it is the migration-19 implementation (is_ddp_admin-based,
--     no hardcoded 'admin' role literal) rather than the rejected draft.
SELECT 'mig11 active & farm guard is the migration-19 implementation' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'compliance_audit_log_no_truncate')
             AND (
               to_regprocedure('public.fn_protect_farm_admin_fields()') IS NULL
               OR (
                 pg_get_functiondef(to_regprocedure('public.fn_protect_farm_admin_fields()')) LIKE '%is_ddp_admin%'
                 AND pg_get_functiondef(to_regprocedure('public.fn_protect_farm_admin_fields()')) NOT LIKE '%= ''admin''%'
               )
             )
            THEN 'PASS' ELSE 'FAIL' END AS result;
