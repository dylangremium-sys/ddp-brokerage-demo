-- Deliberately defective ROLLBACK: it re-creates the function under the correct
-- name and signature but does NOT restore the prior body — it leaves a third,
-- wrong implementation behind.
--
-- Every statement exits 0. The object exists before and after, with identical
-- name and arguments, so name-and-signature comparison sees nothing. Only a
-- definition digest catches it.

CREATE OR REPLACE FUNCTION fixture_audit_action()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN 'something_else_entirely';
END;
$$;
