-- =============================================================================
-- 58_ANON_LOSES_WRITE_PRIVILEGES_ROLLBACK.sql
--
-- Reverses 58_ANON_LOSES_WRITE_PRIVILEGES_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This hands INSERT, UPDATE and DELETE on every public table back to `anon`, and
-- restores the default so every future table gets them too. Afterwards, RLS is
-- once again the ONLY thing standing between an anonymous caller and the
-- commercial spine — and nothing about the result looks wrong, because RLS still
-- refuses everything today. The failure only appears later, the first time a
-- policy is loosened or RLS is disabled on one table.
--
-- Before running it, be clear about what you are trying to fix. If an anonymous
-- caller needs to write ONE table, grant that ONE table:
--
--   GRANT INSERT ON public.<table> TO anon;
--
-- That is reversible, greppable, and leaves the other twenty alone. This
-- rollback is none of those things.
--
-- SCOPE, STATED HONESTLY: this restores the BROAD grant migration 58 removed. It
-- does not reconstruct a per-table record of who held what beforehand, because
-- no such record was taken — the pre-migration state was uniform (anon held all
-- four verbs on every table that granted anything), which is precisely the
-- condition that made migration 58 worth writing.
-- =============================================================================

BEGIN;

GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
GRANT INSERT, UPDATE, DELETE
ON TABLES
TO anon;

DO $postcondition$
DECLARE
  v_missing int;
BEGIN
  -- Every table that grants anon anything at all must now grant all three write
  -- verbs again. Tables anon never had a grant on are not the concern here.
  SELECT count(*) INTO v_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 WHERE a.grantee = 'anon'::regrole)
    AND (SELECT count(DISTINCT a.privilege_type)
           FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          WHERE a.grantee = 'anon'::regrole
            AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')) <> 3;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK 58 INCOMPLETE: % table(s) grant anon something but not all three write verbs.',
      v_missing;
  END IF;

  RAISE NOTICE 'ROLLBACK 58: anon holds INSERT, UPDATE and DELETE again on every public table it has any grant on, and the default privilege is restored.';
END
$postcondition$;

COMMIT;
