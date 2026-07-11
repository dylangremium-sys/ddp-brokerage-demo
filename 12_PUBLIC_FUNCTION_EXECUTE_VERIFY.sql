-- 12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql
-- Read-only verification for 12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql.
--
-- STATUS: PREPARED — SELECT-ONLY. Contains no CREATE/ALTER/DROP/GRANT/REVOKE/
--         INSERT/UPDATE/DELETE/TRUNCATE. It changes nothing. Catalog queries only.
--
-- Expected: every row's result column reads PASS.

-- V1. All six functions exist with exact signatures; owner=postgres;
--     SECURITY DEFINER=true; a fixed search_path is present.
SELECT sig,
       CASE WHEN owner = 'postgres' AND security_definer AND has_fixed_search_path
            THEN 'PASS' ELSE 'FAIL' END AS result,
       owner, security_definer, has_fixed_search_path
FROM (
  SELECT p.oid::regprocedure::text AS sig,
         pg_get_userbyid(p.proowner) AS owner,
         p.prosecdef AS security_definer,
         EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, array[]::text[])) s
                 WHERE s LIKE 'search_path=%') AS has_fixed_search_path
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.oid::regprocedure::text IN (
      'is_ddp_admin()','has_farm_membership(uuid)','handle_new_user()',
      'fn_protect_owner_notes()','fn_protect_review_request_fields()',
      'prevent_compliance_audit_log_mutation()')
) x
ORDER BY sig;

-- V2. RLS helpers: PUBLIC=false, anon=false, authenticated=true,
--     service_role=true, postgres=true.
SELECT sig,
       CASE WHEN NOT pub AND NOT anon_x AND auth_x AND svc AND pg
            THEN 'PASS' ELSE 'FAIL' END AS result,
       pub AS "PUBLIC", anon_x AS anon, auth_x AS authenticated, svc AS service_role, pg AS postgres
FROM (
  SELECT p.oid::regprocedure::text AS sig,
         has_function_privilege('public',p.oid,'EXECUTE') pub,
         has_function_privilege('anon',p.oid,'EXECUTE') anon_x,
         has_function_privilege('authenticated',p.oid,'EXECUTE') auth_x,
         has_function_privilege('service_role',p.oid,'EXECUTE') svc,
         has_function_privilege('postgres',p.oid,'EXECUTE') pg
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.oid::regprocedure::text IN ('is_ddp_admin()','has_farm_membership(uuid)')
) x ORDER BY sig;

-- V3. Trigger-only functions: PUBLIC=false, anon=false, authenticated=false,
--     service_role=true, postgres=true.
SELECT sig,
       CASE WHEN NOT pub AND NOT anon_x AND NOT auth_x AND svc AND pg
            THEN 'PASS' ELSE 'FAIL' END AS result,
       pub AS "PUBLIC", anon_x AS anon, auth_x AS authenticated, svc AS service_role, pg AS postgres
FROM (
  SELECT p.oid::regprocedure::text AS sig,
         has_function_privilege('public',p.oid,'EXECUTE') pub,
         has_function_privilege('anon',p.oid,'EXECUTE') anon_x,
         has_function_privilege('authenticated',p.oid,'EXECUTE') auth_x,
         has_function_privilege('service_role',p.oid,'EXECUTE') svc,
         has_function_privilege('postgres',p.oid,'EXECUTE') pg
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.oid::regprocedure::text IN (
      'handle_new_user()','fn_protect_owner_notes()',
      'fn_protect_review_request_fields()','prevent_compliance_audit_log_mutation()')
) x ORDER BY sig;

-- V4. GLOBAL GUARD: no function in schema public is executable by PUBLIC or anon.
--     Expect count = 0.
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS public_or_anon_executable_functions
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND ( has_function_privilege('public', p.oid, 'EXECUTE')
     OR has_function_privilege('anon',   p.oid, 'EXECUTE') );

-- V5. Public function inventory is exactly the six known application functions
--     (implicitly confirms no unexpected/extra function was introduced).
SELECT CASE WHEN count(*) = 6
              AND bool_and(p.proname IN (
                'is_ddp_admin','has_farm_membership','handle_new_user',
                'fn_protect_owner_notes','fn_protect_review_request_fields',
                'prevent_compliance_audit_log_mutation'))
            THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS public_function_count
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f';
