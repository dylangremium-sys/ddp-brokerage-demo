-- 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_ROLLBACK.sql
-- Rollback for 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql.
--
-- STATUS: Committed and pushed. Rollback for an applied migration; staging-tested
--         and NOT run in production. Repository commit:
--         d6aee658c236e588027b880e34ad47c9277262c4.
--
-- Restores the prior broad DEFAULT privileges for FUTURE tables created by role
-- `postgres` in schema `public`, re-granting TRUNCATE / TRIGGER / REFERENCES /
-- MAINTAIN to anon and authenticated.
--
--   * FUTURE OBJECTS ONLY — does not touch any existing table ACL.
--   * Symmetric with the hardening migration (exact inverse).
--   * Touches no policy, no function, no managed-schema default, and no default
--     for service_role or postgres.

BEGIN;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
GRANT TRUNCATE, TRIGGER, REFERENCES, MAINTAIN
ON TABLES
TO anon, authenticated;

COMMIT;
