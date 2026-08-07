-- =============================================================================
-- 62_STATUS_HISTORY_APPEND_ONLY_ROLLBACK.sql
--
-- Restores status_history to its pre-62 state exactly: no protective triggers,
-- no actor column, and authenticated=arwd.
--
-- READ THIS BEFORE RUNNING IT. This re-opens a real gap: it makes the status
-- trail editable and deletable again by any DDP administrator, by service_role
-- and by the table owner, with no record of who did it. It exists because a
-- migration without a proven reversal is not a migration — the repo's
-- rollback-symmetry check requires one and the check is right — not because
-- reverting is a neutral act.
--
-- The column drop is destructive: any attribution recorded since 62 applied is
-- discarded and re-applying 62 cannot bring it back. Stated here rather than
-- discovered afterwards.
--
-- NOTE WHAT IS ABSENT. 62 did not touch any policy, so this does not restore
-- one. If you find yourself adding a CREATE POLICY here, the forward migration
-- has changed and this file is no longer its mirror.
-- =============================================================================

BEGIN;

-- 1. Triggers and their functions.
DROP TRIGGER IF EXISTS status_history_no_truncate ON public.status_history;
DROP TRIGGER IF EXISTS status_history_no_update_delete ON public.status_history;
DROP TRIGGER IF EXISTS status_history_set_actor ON public.status_history;
DROP FUNCTION IF EXISTS public.prevent_status_history_mutation();
DROP FUNCTION IF EXISTS public.fn_status_history_set_actor();

-- 2. Privileges: restore authenticated=arwd.
GRANT UPDATE, DELETE ON public.status_history TO authenticated;

-- 3. Attribution column. Destructive — see the header.
ALTER TABLE public.status_history DROP COLUMN IF EXISTS changed_by;

-- 4. The table comment 62 added.
COMMENT ON TABLE public.status_history IS NULL;

COMMIT;
