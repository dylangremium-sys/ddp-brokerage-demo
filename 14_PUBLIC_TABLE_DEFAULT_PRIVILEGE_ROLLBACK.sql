-- 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_ROLLBACK.sql
-- Rollback for 14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql.
--
-- STATUS: PREPARED — NOT COMMITTED. NOT PUSHED. Staging only.
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
