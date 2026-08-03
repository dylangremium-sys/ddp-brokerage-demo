-- DEFECT A: Function created as ai_create_audit_event, but rollback tries to drop log_audit_event (wrong name)

CREATE TABLE IF NOT EXISTS ai_audit_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  details JSONB
);

CREATE FUNCTION ai_create_audit_event(
  p_event_type TEXT,
  p_details JSONB
) RETURNS UUID AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO ai_audit_events (id, event_type, details) VALUES (v_id, p_event_type, p_details);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;
