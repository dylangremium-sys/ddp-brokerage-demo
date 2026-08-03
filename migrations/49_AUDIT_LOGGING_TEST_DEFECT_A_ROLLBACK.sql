-- This drops the WRONG function name — does not exist, so DROP succeeds vacuously
DROP FUNCTION IF EXISTS log_audit_event(TEXT, JSONB);
DROP TABLE IF EXISTS ai_audit_events;
