-- 12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql
-- Read-only verification for 12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql.
--
-- STATUS: SELECT-ONLY verification. Committed and pushed. Migration applied to
--         staging and production; production verification completed 2026-07-11.
--         Repository commit: e4a952c614c9eba99828773d9f9b0c10f485d643. Contains no
--         CREATE/ALTER/DROP/GRANT/REVOKE/INSERT/UPDATE/DELETE/TRUNCATE. It
--         changes nothing. Catalog queries only.
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

-- V5. The six migration-12 functions are all still present.
--
--     WAS: `count(*) = 6` over every function in schema public — a frozen
--     inventory. Migrations 10, 17, 19, 22 and 23 have since added five more
--     application functions, so the count assertion failed purely because the
--     schema grew as intended, while telling us nothing about privileges. The
--     security property migration 12 actually protects is EXECUTE exposure
--     (V2/V3/V4), not the size of the catalog.
--
--     NOW: assert presence of the six, and let V6 police every function that
--     exists — including future ones — on the properties that matter.
SELECT 'migration-12 functions all present' AS check,
       CASE WHEN count(*) = 6 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS found_of_six
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND p.proname IN (
    'is_ddp_admin','has_farm_membership','handle_new_user',
    'fn_protect_owner_notes','fn_protect_review_request_fields',
    'prevent_compliance_audit_log_mutation');

-- V6. GROWTH-TOLERANT GUARD over EVERY function in schema public, present and
--     future. A new function is allowed to exist; it is NOT allowed to be owned
--     by a non-superuser role, to be reachable by PUBLIC/anon, or — if it is
--     SECURITY DEFINER — to run without a pinned search_path (the search-path
--     hijack that migration 12's `SET search_path` clauses exist to prevent).
--     Expect: offenders = 0. Any row listed names the exact function and defect.
SELECT 'no public function is unsafely exposed or configured' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS offenders,
       coalesce(string_agg(sig || ' [' || defect || ']', '; ' ORDER BY sig), '') AS detail
FROM (
  SELECT p.oid::regprocedure::text AS sig,
         CASE
           WHEN has_function_privilege('public', p.oid, 'EXECUTE') THEN 'PUBLIC can EXECUTE'
           WHEN has_function_privilege('anon',   p.oid, 'EXECUTE') THEN 'anon can EXECUTE'
           WHEN pg_get_userbyid(p.proowner) <> 'postgres'          THEN 'owner is not postgres'
           WHEN p.prosecdef AND NOT EXISTS (
                  SELECT 1 FROM unnest(coalesce(p.proconfig, array[]::text[])) s
                  WHERE s LIKE 'search_path=%')                    THEN 'SECURITY DEFINER without a pinned search_path'
         END AS defect
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
) y
WHERE defect IS NOT NULL;
