-- Target stage: replaces the function IN PLACE, as migration 45 does to
-- fn_audit_organisation_change(). The name and signature never change, so a
-- snapshot recording only name and arguments cannot see this migration at all.

CREATE OR REPLACE FUNCTION fixture_audit_action()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN 'organisation_verification_changed';
END;
$$;
