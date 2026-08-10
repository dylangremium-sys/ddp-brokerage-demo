-- Harness self-proof fixture (negative scenario).
--
-- Reproduces the defect that shipped twice in migrations 47-51: the ROLLBACK
-- names the right function but the WRONG argument list. `DROP FUNCTION IF
-- EXISTS` with a signature matching no function is not an error, so the
-- rollback exits 0 having removed nothing and looks identical to a correct one.
--
-- Paired with negative_asymmetric_rollback_rollback.sql, which drops the wrong
-- signature on purpose. The catalog symmetry check must fail this run.

CREATE TABLE IF NOT EXISTS fixture_audit_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION fixture_create_audit_event(
  p_event_type TEXT,
  p_actor TEXT,
  p_farm_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO fixture_audit_events (id, event_type) VALUES (v_id, p_event_type);
  RETURN v_id;
END;
$$;
