-- Prerequisite stage for the restore-in-place self-proof fixture.
--
-- Stands in for migration 39: it establishes the definition that a later
-- migration replaces and that the later migration's ROLLBACK is supposed to put
-- back. This stage is NOT rolled back, so it forms the symmetry baseline.

CREATE OR REPLACE FUNCTION fixture_audit_action()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN 'organisation_updated';
END;
$$;
