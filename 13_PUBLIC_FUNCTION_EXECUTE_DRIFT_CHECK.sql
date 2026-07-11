-- 13_PUBLIC_FUNCTION_EXECUTE_DRIFT_CHECK.sql
-- SELECT-ONLY drift check: reports any public-schema function that is executable
-- by PUBLIC or anon. Run in staging (and production, read-only) after any
-- migration that adds/replaces a public function. Expected: zero rows / count 0.
--
-- STATUS: PREPARED — SELECT-ONLY. Contains no CREATE/ALTER/DROP/GRANT/REVOKE/
--         INSERT/UPDATE/DELETE/TRUNCATE. It changes nothing.
--
-- To intentionally exempt a function (rare), add its name to the allowlist array
-- in BOTH queries below AND document the justification.

-- D1. Detail — every public function currently executable by PUBLIC or anon.
--     Expect ZERO rows.
SELECT n.nspname                                   AS schema,
       p.oid::regprocedure::text                   AS signature,
       pg_get_userbyid(p.proowner)                 AS owner,
       p.prosecdef                                 AS security_definer,
       COALESCE(array_to_string(p.proconfig, ','), '-') AS search_path_config,
       has_function_privilege('public',        p.oid, 'EXECUTE') AS public_execute,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND ( has_function_privilege('public', p.oid, 'EXECUTE')
     OR has_function_privilege('anon',   p.oid, 'EXECUTE') )
  AND p.proname <> ALL (ARRAY[]::text[])   -- intentionally-public allowlist (currently empty)
ORDER BY signature;

-- D2. Summary — must be 0.
SELECT count(*) AS functions_executable_by_public_or_anon
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND ( has_function_privilege('public', p.oid, 'EXECUTE')
     OR has_function_privilege('anon',   p.oid, 'EXECUTE') )
  AND p.proname <> ALL (ARRAY[]::text[]);
