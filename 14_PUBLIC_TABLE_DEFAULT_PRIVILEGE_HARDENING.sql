-- 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql
-- Tighten the DEFAULT privileges for FUTURE tables created by role `postgres`
-- in schema `public`: client roles never need TRUNCATE / TRIGGER / REFERENCES /
-- MAINTAIN.
--
-- STATUS: Committed and pushed. Applied to staging and production.
--         Production verification completed: 2026-07-11.
--         Repository commit: d6aee658c236e588027b880e34ad47c9277262c4.
--         Rollback file available and staging-tested; not required in production.
--
-- SCOPE (deliberately narrow):
--   * FUTURE OBJECTS ONLY — affects tables created AFTER this runs; the ACLs of
--     existing tables are NOT changed (PostgreSQL default privileges never
--     retroactively alter existing objects).
--   * CRUD PRESERVED — the four data privileges (read/insert/update/delete) that
--     PostgREST relies on for anon/authenticated remain granted by default.
--   * Removes only the four privileges no client role needs.
--   * Touches no existing table ACL, no policy, no function, no default for the
--     `storage`/`realtime`/`vault`/`auth` managed schemas, and no default for
--     `service_role` or `postgres`.
--
-- Companion files:
--   14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql   (SELECT-only checks)
--   14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_ROLLBACK.sql (restore prior broad defaults)

BEGIN;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
REVOKE TRUNCATE, TRIGGER, REFERENCES, MAINTAIN
ON TABLES
FROM anon, authenticated;

COMMIT;
