-- ===========================================================================
-- 17_PROCUREMENT_DECISIONS_VERIFY.sql
-- READ-ONLY verification for 17_PROCUREMENT_DECISIONS_MVP.sql.
-- No DDL, no DML. Safe to run against production at any time.
-- Every check should report verdict = 'ok'.
-- ===========================================================================

-- V1. Table exists with the expected shape.
SELECT 'V1 table shape' AS check,
       column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'procurement_decisions'
ORDER BY ordinal_position;

-- V2. A rejection can now be recorded (the whole point of this migration).
--     Expect the CHECK to permit progress | hold | reject.
SELECT 'V2 decision CHECK' AS check,
       pg_get_constraintdef(c.oid) AS definition,
       CASE WHEN pg_get_constraintdef(c.oid) LIKE '%reject%'
                 AND pg_get_constraintdef(c.oid) LIKE '%hold%'
            THEN 'ok' ELSE '*** cannot record a rejection ***' END AS verdict
FROM pg_constraint c
WHERE c.conrelid = 'public.procurement_decisions'::regclass
  AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%decision%';

-- V3. Reason is mandatory and non-empty.
SELECT 'V3 reason mandatory' AS check,
       pg_get_constraintdef(c.oid) AS definition,
       'ok' AS verdict
FROM pg_constraint c
WHERE c.conrelid = 'public.procurement_decisions'::regclass
  AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%reason%';

-- V4. RLS enabled; exactly one SELECT policy and one INSERT policy; NO update/delete policy.
SELECT 'V4 rls + policies' AS check,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.procurement_decisions'::regclass) AS rls_enabled,
       count(*) FILTER (WHERE cmd = 'SELECT') AS select_policies,
       count(*) FILTER (WHERE cmd = 'INSERT') AS insert_policies,
       count(*) FILTER (WHERE cmd IN ('UPDATE','DELETE','ALL')) AS mutation_policies,
       CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.procurement_decisions'::regclass)
                 AND count(*) FILTER (WHERE cmd IN ('UPDATE','DELETE','ALL')) = 0
            THEN 'ok' ELSE '*** append-only guarantee broken ***' END AS verdict
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'procurement_decisions';

-- V5. Append-only trigger is installed and fires on UPDATE and DELETE.
SELECT 'V5 append-only trigger' AS check,
       t.tgname,
       pg_get_triggerdef(t.oid) AS definition,
       CASE WHEN pg_get_triggerdef(t.oid) LIKE '%UPDATE%'
                 AND pg_get_triggerdef(t.oid) LIKE '%DELETE%'
            THEN 'ok' ELSE '*** trigger does not cover both UPDATE and DELETE ***' END AS verdict
FROM pg_trigger t
WHERE t.tgrelid = 'public.procurement_decisions'::regclass AND NOT t.tgisinternal;

-- V6. anon has no access; authenticated has SELECT+INSERT but NOT UPDATE/DELETE.
SELECT 'V6 privileges' AS check,
       has_table_privilege('anon',          'public.procurement_decisions', 'SELECT') AS anon_select,
       has_table_privilege('authenticated', 'public.procurement_decisions', 'SELECT') AS auth_select,
       has_table_privilege('authenticated', 'public.procurement_decisions', 'INSERT') AS auth_insert,
       has_table_privilege('authenticated', 'public.procurement_decisions', 'UPDATE') AS auth_update,
       has_table_privilege('authenticated', 'public.procurement_decisions', 'DELETE') AS auth_delete,
       CASE WHEN NOT has_table_privilege('anon', 'public.procurement_decisions', 'SELECT')
                 AND NOT has_table_privilege('authenticated', 'public.procurement_decisions', 'UPDATE')
                 AND NOT has_table_privilege('authenticated', 'public.procurement_decisions', 'DELETE')
            THEN 'ok' ELSE '*** privilege leak ***' END AS verdict;

-- V7. Trigger-only function is not directly executable.
SELECT 'V7 trigger fn not executable' AS check,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute,
       CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE')
            THEN '*** directly executable ***' ELSE 'ok' END AS verdict
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'prevent_procurement_decision_mutation';

-- V8. Current-decision view resolves newest-per-batch.
SELECT 'V8 current view' AS check,
       (SELECT count(*) FROM public.procurement_decisions)         AS total_decision_rows,
       (SELECT count(*) FROM public.procurement_decisions_current) AS distinct_batches,
       'ok' AS verdict;
