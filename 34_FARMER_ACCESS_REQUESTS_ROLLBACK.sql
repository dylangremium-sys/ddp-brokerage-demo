-- =============================================================================
-- Migration 34 — ROLLBACK (farmer access requests)
--
-- DESTRUCTIVE: the table holds enquiries from real people who asked for access.
-- Refuses to run while any request exists unless the operator opts in:
--   SET LOCAL farmer_access.rollback_destructive = 'true';
-- =============================================================================
BEGIN;

DO $guard$
DECLARE n integer := 0; opt_in text;
BEGIN
  IF to_regclass('public.farmer_access_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.farmer_access_requests' INTO n;
  END IF;

  IF n > 0 THEN
    BEGIN
      opt_in := current_setting('farmer_access.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 34 refused: % access request(s) exist. These are enquiries from real '
        'people and cannot be reconstructed. To proceed deliberately, run '
        'SET LOCAL farmer_access.rollback_destructive = ''true''; in the same transaction.', n;
    END IF;
    RAISE NOTICE 'rollback 34: destructive opt-in acknowledged — removing % request(s).', n;
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS farmer_access_requests_stamp_review ON public.farmer_access_requests;
DROP FUNCTION IF EXISTS public.stamp_farmer_access_request_review();
DROP TABLE IF EXISTS public.farmer_access_requests;

COMMIT;
