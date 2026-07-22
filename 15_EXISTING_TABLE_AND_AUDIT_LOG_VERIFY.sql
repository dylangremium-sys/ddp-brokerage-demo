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

-- V2. The 20 migration-15 tables retain client CRUD.
--
--     WAS: applied to EVERY table in schema public except compliance_audit_log.
--     Migration 17 then added `procurement_decisions` as a deliberately
--     admin-only, append-only table — anon holds none of SELECT/INSERT/UPDATE/
--     DELETE and authenticated holds no UPDATE/DELETE — so this reported 6
--     "missing" grants that are the intended hardened design. Read literally the
--     old assertion demanded that every future table be fully client-writable,
--     which is the opposite of the posture the programme is moving towards.
--
--     NOW: scope to the 20 tables migration 15 actually governs. Tables added by
--     later migrations carry their own privilege design and are verified by their
--     own VERIFY scripts; V2a below still ensures they cannot be over-granted.
SELECT 'V2 crud_intact_non_audit (migration-15 tables)' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS missing_crud_grants,
       coalesce(string_agg(DISTINCT c.relname || '/' || r.rolname || '/' || p.priv, ', '), '') AS detail
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname <> 'compliance_audit_log'
  AND c.relname IN (
    'compliance_alerts','compliance_entity_status','compliance_reviews',
    'compliance_rules','ddp_scores','documents','farm_memberships','farm_profiles',
    'farmer_documents','farmer_photos','farmer_review_requests','farms',
    'inventory_batches','legal_updates','market_price_benchmarks','profiles',
    'regulatory_sources','risk_flags','status_history')
  AND NOT has_table_privilege(r.rolname, c.oid, p.priv);

-- V2a. GROWTH-TOLERANT over-grant guard: NO table in schema public — including
--      every table added after migration 15 — may expose TRUNCATE, TRIGGER,
--      REFERENCES or MAINTAIN to anon or authenticated. This is the invariant a
--      new table could actually violate, and it is enforced without any count.
--      (V1 above already asserts the same for the whole schema; V2a names the
--      offender so a failure is actionable rather than a bare number.)
SELECT 'V2a no table over-grants non-CRUD to client roles' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS over_grants,
       coalesce(string_agg(c.relname || '/' || r.rolname || '/' || p.priv, ', ' ORDER BY c.relname), '') AS detail
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) p(priv)
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND has_table_privilege(r.rolname, c.oid, p.priv);

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

-- V6. RLS posture, count-independent.
--
--     WAS: tables = 20 AND policies = 43 AND funcs = 6 AND triggers = 4 AND
--     rls_on = 20. Migrations 10, 17, 19, 22 and 23 legitimately grew all four
--     numbers (24/63/11/12), so this failed on intended growth while proving
--     nothing about access control. Worse, `rls_on = 20` would have FAILED had a
--     21st table been added *with* RLS — penalising the secure outcome.
--
--     NOW: assert the property. Every public table has RLS on, no table forces
--     RLS, and the farmer-documents storage policies still exist. This holds for
--     20 tables or 200, and fails the moment a table ships without RLS.
SELECT 'V6 rls_posture (count-independent)' AS check,
       CASE WHEN tables_without_rls = 0 AND force_rls = 0 AND storage_fd >= 3
            THEN 'PASS' ELSE 'FAIL' END AS result,
       tables_total, tables_without_rls, force_rls, storage_fd,
       coalesce(no_rls_names, '') AS tables_missing_rls
FROM (
  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r') AS tables_total,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity) AS tables_without_rls,
         (SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity) AS no_rls_names,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity) AS force_rls,
         (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
            AND policyname LIKE 'farmer-documents%') AS storage_fd
) x;

-- V7. Prior migrations remain active.
--
--     WAS: additionally required buyer_pack* tables to be ABSENT and
--     `fn_protect_farm_admin_fields()` to be ABSENT. Migration 10 created
--     `buyer_pack_snapshots` and migration 19 created that guard — both
--     intentionally — so the absence clauses now fire on objects the programme
--     deliberately shipped. Absence of a not-yet-written feature is not a
--     security invariant; it expires the moment the feature lands.
--
--     NOW: keep the three genuine invariants (migration 11's trigger, migration
--     A's default-ACL revoke, migration B2's anon EXECUTE revoke) and drop the
--     two expired absence clauses. Buyer Pack objects are verified by
--     10_/23_..._VERIFY.sql; the farm guard by 19_..._VERIFY.sql.
SELECT 'V7 prior_migrations_active' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='compliance_audit_log_no_truncate')            -- mig 11
             AND (SELECT count(*) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace
                    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                    WHERE d.defaclrole::regrole::text='postgres' AND n.nspname='public' AND d.defaclobjtype='r'
                      AND a.grantee::regrole::text='anon' AND a.privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES','MAINTAIN')) = 0  -- mig A
             AND NOT has_function_privilege('anon','public.is_ddp_admin()','EXECUTE')                          -- mig B2
            THEN 'PASS' ELSE 'FAIL' END AS result;

-- V8. Function safety across EVERY public function, present and future.
--
--     WAS: required every function in schema public to be SECURITY DEFINER. That
--     held for migration 15's six, but migration 17 added
--     `prevent_procurement_decision_mutation()` — a trigger body whose entire
--     content is `RAISE EXCEPTION`. It reads nothing and holds no privileges, so
--     SECURITY INVOKER is correct for it; blanket-requiring DEFINER would push a
--     needless privilege escalation onto every future guard function.
--
--     NOW: assert the properties that are dangerous to violate — non-postgres
--     owner, PUBLIC/anon EXECUTE, or SECURITY DEFINER without a pinned
--     search_path. The known, reviewed exception is named explicitly rather than
--     silently absorbed, so a NEW non-definer function still surfaces here for a
--     decision. Failures name the function and the defect.
SELECT 'V8 function_safety (all public functions)' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS functions_out_of_spec,
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
           WHEN NOT p.prosecdef
            AND p.proname <> 'prevent_procurement_decision_mutation'  -- reviewed: RAISE-only trigger body, migration 17
                                                                      THEN 'not SECURITY DEFINER (review required)'
         END AS defect
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
) y
WHERE defect IS NOT NULL;
