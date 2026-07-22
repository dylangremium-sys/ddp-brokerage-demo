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
--     Driven from the EXPECTED set and LEFT JOINed to pg_class, not filtered by
--     it. A catalog-driven `relname IN (...)` cannot see absence: a dropped or
--     renamed governed table simply contributes no rows, so `missing_crud_grants`
--     stayed 0 and the check passed. The old `V6 tables = 20` used to catch that
--     incidentally; removing it (correctly, since it also failed on growth) left
--     nothing detecting disappearance. Anti-joining restores absence detection
--     without reintroducing any count.
--
--     ABSENT and PRESENT-BUT-UNDER-GRANTED are reported as distinct causes.
WITH expected(relname) AS (
  VALUES ('compliance_alerts'),('compliance_entity_status'),('compliance_reviews'),
         ('compliance_rules'),('ddp_scores'),('documents'),('farm_memberships'),
         ('farm_profiles'),('farmer_documents'),('farmer_photos'),
         ('farmer_review_requests'),('farms'),('inventory_batches'),
         ('legal_updates'),('market_price_benchmarks'),('profiles'),
         ('regulatory_sources'),('risk_flags'),('status_history')
),
resolved AS (
  SELECT e.relname,
         (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = e.relname) AS oid
  FROM expected e
),
findings AS (
  -- Cause 1: the governed table is gone (dropped or renamed).
  SELECT relname, 'ABSENT' AS cause, relname AS detail
  FROM resolved WHERE oid IS NULL
  UNION ALL
  -- Cause 2: present, but a required client CRUD grant is missing.
  SELECT r.relname, 'MISSING_GRANT' AS cause, r.relname || '/' || ro.rolname || '/' || p.priv AS detail
  FROM resolved r
  CROSS JOIN (VALUES ('anon'), ('authenticated')) ro(rolname)
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
  WHERE r.oid IS NOT NULL
    AND NOT has_table_privilege(ro.rolname, r.oid, p.priv)
)
SELECT 'V2 governed tables present with client CRUD' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) FILTER (WHERE cause = 'ABSENT')        AS absent_tables,
       count(*) FILTER (WHERE cause = 'MISSING_GRANT') AS missing_crud_grants,
       coalesce(string_agg(cause || ': ' || detail, ', ' ORDER BY cause, detail), '') AS detail
FROM findings;

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

-- V5a. REQUIRED audit-log guard triggers, driven from an EXPECTED set.
--
--      WHY: V5 above enumerates the triggers that EXIST on compliance_audit_log,
--      so a dropped guard emits no row and therefore no FAIL. The removed
--      `V6 triggers = 4` was the only thing that caught disappearance, and the
--      staging harness marks a VERIFY file failed only when its output contains
--      the literal FAIL — so without this, dropping
--      `compliance_audit_log_no_update_delete` would leave the append-only
--      guarantee silently unverified while the whole run reported PASS.
--      11_..._VERIFY.sql is not a backstop: it emits counts and rows for human
--      reading and contains no FAIL verdict at all.
--
--      Anti-joins the two required triggers and classifies the defect. Joining on
--      tgname alone (trigger names are unique per table, not globally) is what
--      lets WRONG_TABLE be distinguished from ABSENT.
WITH expected(tgname) AS (
  VALUES ('compliance_audit_log_no_truncate'),
         ('compliance_audit_log_no_update_delete')
),
resolved AS (
  SELECT e.tgname,
         t.oid            AS trg_oid,
         c.relname::text  AS on_table,
         t.tgfoid         AS fn_oid,
         t.tgenabled::text AS enabled
  FROM expected e
  LEFT JOIN pg_trigger t ON t.tgname = e.tgname AND NOT t.tgisinternal
  LEFT JOIN pg_class   c ON c.oid = t.tgrelid
),
graded AS (
  SELECT tgname,
         CASE
           WHEN trg_oid IS NULL
             THEN 'ABSENT'
           WHEN on_table IS DISTINCT FROM 'compliance_audit_log'
             THEN 'WRONG_TABLE'
           WHEN fn_oid IS DISTINCT FROM to_regprocedure('public.prevent_compliance_audit_log_mutation()')::oid
             THEN 'WRONG_FUNCTION'
           WHEN enabled <> 'A'
             THEN 'DISABLED'
         END AS defect
  FROM resolved
)
SELECT 'V5a required audit-log guard triggers present' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS defective_triggers,
       coalesce(string_agg(tgname || ': ' || defect, ', ' ORDER BY tgname), '') AS detail
FROM graded
WHERE defect IS NOT NULL;

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
           -- Exemption scoped to the EXACT reviewed signature, not the bare name.
           -- `proname <> '...'` would exempt every overload of that name, so a
           -- future `prevent_procurement_decision_mutation(uuid)` shipped as
           -- SECURITY INVOKER would escape review — defeating the very purpose of
           -- this clause. regprocedure renders the identity signature, so only the
           -- zero-argument trigger body reviewed under migration 17 is exempt.
           WHEN NOT p.prosecdef
            AND p.oid::regprocedure::text <> 'prevent_procurement_decision_mutation()'
                                                                      THEN 'not SECURITY DEFINER (review required)'
         END AS defect
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
) y
WHERE defect IS NOT NULL;

-- V9. Required public RLS policies remain present, on the right table, with the
--     right command, mode, roles and enforcement clauses.
--
--     WHY: removing `V6 policies = 43` deleted the ONLY assertion in the whole
--     harness-effective set (12/14/15) that could notice a public RLS policy
--     disappearing. Nothing else covered it: V6 now checks that RLS is ENABLED
--     per table, which stays true when every policy on that table is dropped;
--     V2/V2a check table-level grants, not policies; and 14/V5 counts only the
--     `farmer-documents%` policies in schema `storage`. The staging harness marks
--     a VERIFY file failed only when its output contains the literal FAIL, and
--     22_..._VERIFY.sql — which does cover migration 22's policies — is not in
--     the harness allowlist and raises exceptions instead of emitting FAIL. So a
--     dropped policy was invisible end to end.
--
--     Dropping a PERMISSIVE policy is fail-safe: access narrows. Dropping a
--     RESTRICTIVE one is NOT — it removes an AND-ed deny layer, so migration 22's
--     twelve restrictive overlays silently re-open the pending-account write path
--     that migration closed. That is a real privilege escalation, and it is the
--     specific regression this check exists to catch.
--
--     A COUNT IS DELIBERATELY NOT RESTORED. `policies = 63` fails on legitimate
--     growth (exactly the defect this PR removes) and cannot see a swap: drop one
--     policy, add an unrelated one, and the count is unchanged while the security
--     property is gone. This anti-joins an EXPLICIT expected set instead, so
--     absence and substitution both fail while new policies are free to appear.
--
--     Clause checks assert PRESENCE of USING / WITH CHECK, never their text.
--     Comparing `qual` as a string would break on any semantically neutral
--     reformat or on PostgreSQL's own deparsing changes across versions.
--
--     The expected set is derived from the migration SQL (9, 10, 17, 21, 22,
--     RLS_ENABLE_STAGED, FARMER_MVP, INVENTORY_BATCHES_*, 4), not from a live
--     catalog snapshot. Two deliberate exclusions:
--       * `farm_profiles: farmer update own` — FARM_RESAVE_PERSISTENCE_MIGRATION
--         is an unapplied draft ("Do not run this file automatically"). Only its
--         `farms: farmer update own` half was applied, and that one IS required
--         below because 19_..._VERIFY.sql fails outright if it is missing and
--         19_..._ROLLBACK.sql treats dropping it as rollback overreach.
--       * storage.objects policies — different schema; 14/V5 owns those.
WITH expected(tablename, policyname, cmd, permissive, roles, has_using, has_check) AS (
  VALUES
    ('buyer_pack_audit_log', 'buyer_pack_audit_log: admin insert', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('buyer_pack_audit_log', 'buyer_pack_audit_log: admin select', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('buyer_pack_download_log', 'buyer_pack_download_log: admin insert', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('buyer_pack_download_log', 'buyer_pack_download_log: admin select', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('buyer_pack_snapshots', 'buyer_pack_snapshots: admin select', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('compliance_alerts', 'compliance_alerts: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('compliance_audit_log', 'compliance_audit_log: admin insert', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('compliance_audit_log', 'compliance_audit_log: admin select', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('compliance_entity_status', 'compliance_entity_status: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('compliance_reviews', 'compliance_reviews: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('compliance_rules', 'compliance_rules: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('ddp_scores', 'ddp_scores: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('ddp_scores', 'ddp_scores: farmer select own farm', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('ddp_scores', 'ddp_scores: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('documents', 'documents: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('documents', 'documents: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('documents', 'documents: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('farm_memberships', 'farm_memberships: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('farm_memberships', 'farm_memberships: farmer insert own', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('farm_memberships', 'farm_memberships: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('farm_memberships', 'farm_memberships: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('farm_profiles', 'farm_profiles: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('farm_profiles', 'farm_profiles: farmer insert own', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('farm_profiles', 'farm_profiles: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('farm_profiles', 'farm_profiles: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('farmer_documents', 'farmer_documents: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('farmer_documents', 'farmer_documents: farmer insert own', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('farmer_documents', 'farmer_documents: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('farmer_documents', 'farmer_documents: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('farmer_photos', 'farmer_photos: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('farmer_photos', 'farmer_photos: farmer insert own', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('farmer_photos', 'farmer_photos: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('farmer_photos', 'farmer_photos: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('farmer_review_requests', 'farmer_review_requests: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('farmer_review_requests', 'farmer_review_requests: farmer resolve own', 'UPDATE', 'PERMISSIVE', 'public', true, true),
    ('farmer_review_requests', 'farmer_review_requests: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('farmer_review_requests', 'farmer_review_requests: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('farms', 'farms: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('farms', 'farms: farmer insert own', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('farms', 'farms: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('farms', 'farms: farmer update own', 'UPDATE', 'PERMISSIVE', 'authenticated', true, true),
    ('farms', 'farms: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('inventory_batches', 'inventory_batches: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('inventory_batches', 'inventory_batches: farmer insert own', 'INSERT', 'PERMISSIVE', 'public', false, true),
    ('inventory_batches', 'inventory_batches: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('inventory_batches', 'inventory_batches: farmer update own', 'UPDATE', 'PERMISSIVE', 'public', true, true),
    ('inventory_batches', 'inventory_batches: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('legal_updates', 'legal_updates: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('market_price_benchmarks', 'market_price_benchmarks: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('market_price_benchmarks', 'market_price_benchmarks: farmer select visible', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('market_price_benchmarks', 'market_price_benchmarks: operational farmer or admin', 'SELECT', 'RESTRICTIVE', 'public', true, false),
    ('procurement_decisions', 'procurement_decisions: admin insert', 'INSERT', 'PERMISSIVE', 'authenticated', false, true),
    ('procurement_decisions', 'procurement_decisions: admin select', 'SELECT', 'PERMISSIVE', 'authenticated', true, false),
    ('profiles', 'profiles: admin update role', 'UPDATE', 'PERMISSIVE', 'public', true, false),
    ('profiles', 'profiles: select own or admin', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('profiles', 'profiles: update own no role change', 'UPDATE', 'PERMISSIVE', 'public', true, true),
    ('regulatory_sources', 'regulatory_sources: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('risk_flags', 'risk_flags: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('risk_flags', 'risk_flags: farmer select own farm', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('risk_flags', 'risk_flags: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true),
    ('status_history', 'status_history: admin all', 'ALL', 'PERMISSIVE', 'public', true, true),
    ('status_history', 'status_history: farmer select own', 'SELECT', 'PERMISSIVE', 'public', true, false),
    ('status_history', 'status_history: operational farmer or admin', 'ALL', 'RESTRICTIVE', 'public', true, true)
),
-- Located by NAME across schema public, so a policy moved to another table is
-- reported as WRONG_TABLE rather than masquerading as ABSENT.
by_name AS (
  -- ::text casts are explicit: pg_policies exposes these as `name`, which has no
  -- native min() aggregate and would resolve only via an implicit cast.
  SELECT p.policyname::text                                AS policyname,
         count(*)                                          AS name_matches,
         min(p.tablename::text)                            AS any_table
  FROM pg_policies p
  WHERE p.schemaname = 'public'
  GROUP BY p.policyname
),
resolved AS (
  SELECT e.tablename, e.policyname, e.cmd, e.permissive, e.roles,
         e.has_using, e.has_check,
         a.policyname::text                                AS found,
         a.cmd                                             AS actual_cmd,
         a.permissive                                      AS actual_permissive,
         array_to_string(ARRAY(SELECT unnest(a.roles::text[]) ORDER BY 1), ',') AS actual_roles,
         a.qual       IS NOT NULL                          AS actual_using,
         a.with_check IS NOT NULL                          AS actual_check,
         n.name_matches, n.any_table
  FROM expected e
  LEFT JOIN pg_policies a
         ON a.schemaname = 'public'
        AND a.tablename  = e.tablename
        AND a.policyname = e.policyname
  LEFT JOIN by_name n ON n.policyname = e.policyname
),
graded AS (
  SELECT tablename, policyname,
         CASE
           WHEN found IS NULL AND coalesce(name_matches, 0) > 0
             THEN 'WRONG_TABLE (found on ' || coalesce(any_table, '?') || ')'
           WHEN found IS NULL
             THEN 'ABSENT'
           -- A second policy of the same name on another table is an extra
           -- enforcement surface that review never saw; the expected row alone
           -- cannot reveal it because it joins on the table too.
           WHEN name_matches > 1
             THEN 'DUPLICATE_MATCH (' || name_matches || ' policies share this name)'
           WHEN actual_permissive IS DISTINCT FROM permissive
             THEN 'WRONG_MODE (is ' || coalesce(actual_permissive, '?') || ', expected ' || permissive || ')'
           WHEN actual_cmd IS DISTINCT FROM cmd
             THEN 'WRONG_COMMAND (is ' || coalesce(actual_cmd, '?') || ', expected ' || cmd || ')'
           WHEN actual_roles IS DISTINCT FROM roles
             THEN 'WRONG_ROLES (is ' || coalesce(actual_roles, '?') || ', expected ' || roles || ')'
           WHEN actual_using IS DISTINCT FROM has_using
             THEN 'USING clause ' || CASE WHEN has_using THEN 'missing' ELSE 'unexpectedly present' END
           WHEN actual_check IS DISTINCT FROM has_check
             THEN 'WITH CHECK clause ' || CASE WHEN has_check THEN 'missing' ELSE 'unexpectedly present' END
         END AS defect
  FROM resolved
)
SELECT 'V9 required public RLS policies present' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS defective_policies,
       coalesce(string_agg(tablename || '.' || policyname || ': ' || defect, '; '
                           ORDER BY tablename, policyname), '') AS detail
FROM graded
WHERE defect IS NOT NULL;

-- V9a. The restrictive overlay specifically. Migration 22 installs one
--      AS RESTRICTIVE policy per farmer-operated table; losing any of them
--      re-opens direct REST/Storage writes to non-operational accounts. Reported
--      separately from V9 so the blast radius is legible at a glance instead of
--      being one entry in a combined list.
WITH expected_restrictive(tablename) AS (
  VALUES ('farms'), ('farm_profiles'), ('farm_memberships'), ('inventory_batches'),
         ('farmer_documents'), ('farmer_photos'), ('farmer_review_requests'),
         ('documents'), ('ddp_scores'), ('risk_flags'), ('status_history')
)
SELECT 'V9a migration-22 restrictive overlay intact' AS check,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS tables_missing_overlay,
       coalesce(string_agg(tablename, ', ' ORDER BY tablename), '') AS detail
FROM expected_restrictive e
WHERE NOT EXISTS (
  SELECT 1 FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename  = e.tablename
    AND p.policyname = e.tablename || ': operational farmer or admin'
    AND p.permissive = 'RESTRICTIVE'
    AND p.cmd        = 'ALL'
);
