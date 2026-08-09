-- ════════════════════════════════════════════════════════════════════════════
-- 66 — ROLLBACK
--
-- Drops the table and everything attached to it. There is no partial rollback:
-- the table did not exist before this migration and nothing else references it,
-- so removing it returns the database to exactly its prior state.
--
-- THIS DESTROYS CONSENT RECORDS. If any address has been confirmed, rolling
-- back deletes the evidence that it consented — which is the one thing that
-- cannot be reconstructed and the thing a regulator would ask for. Export
-- before running this on any database that has taken a real subscription.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DROP INDEX IF EXISTS public.regulatory_subscribers_unsubscribe_token_key;
DROP INDEX IF EXISTS public.regulatory_subscribers_confirm_token_key;
DROP INDEX IF EXISTS public.regulatory_subscribers_canonical_key;
DROP TABLE IF EXISTS public.regulatory_subscribers;

COMMIT;
