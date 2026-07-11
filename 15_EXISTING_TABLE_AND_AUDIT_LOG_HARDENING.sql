-- 15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql
-- Defense-in-depth on EXISTING public tables + the compliance audit log.
--
-- STATUS: PREPARED — staging-tested only. Apply by hand, staging first, after review.
--
-- WHAT THIS DOES (narrow, least-privilege):
--   1. Removes the four privileges no client role needs — TRUNCATE, TRIGGER,
--      REFERENCES, MAINTAIN — from anon and authenticated on the 20 existing
--      public application tables (explicitly enumerated below).
--   2. Additionally removes UPDATE and DELETE from anon and authenticated on
--      public.compliance_audit_log only (append-only; no client role needs them).
--   3. Promotes the two audit-log guard triggers to ENABLE ALWAYS so they fire
--      even under session_replication_role='replica'.
--
-- WHAT THIS DOES NOT DO / IS NOT:
--   * Preserves SELECT/INSERT for all roles and UPDATE/DELETE for every table
--     OTHER than compliance_audit_log (PostgREST CRUD unaffected).
--   * Does not touch service_role or postgres privileges, RLS policies, FORCE
--     RLS, function bodies/ownership/ACLs, default privileges, or any managed
--     schema.
--   * This is DEFENSE-IN-DEPTH ONLY. It is NOT cryptographic immutability, NOT
--     WORM compliance, and does NOT protect against a database owner/superuser
--     who can still disable/drop the triggers or bypass with elevated rights.
--
-- Companion files:
--   15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql   (SELECT-only checks)
--   15_EXISTING_TABLE_AND_AUDIT_LOG_ROLLBACK.sql (restore captured baseline)

BEGIN;

-- 1. Remove TRUNCATE / TRIGGER / REFERENCES / MAINTAIN from anon + authenticated
--    on the 20 existing public application tables (explicitly listed — not ALL).
REVOKE TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
  public.compliance_alerts,
  public.compliance_audit_log,
  public.compliance_entity_status,
  public.compliance_reviews,
  public.compliance_rules,
  public.ddp_scores,
  public.documents,
  public.farm_memberships,
  public.farm_profiles,
  public.farmer_documents,
  public.farmer_photos,
  public.farmer_review_requests,
  public.farms,
  public.inventory_batches,
  public.legal_updates,
  public.market_price_benchmarks,
  public.profiles,
  public.regulatory_sources,
  public.risk_flags,
  public.status_history
FROM anon, authenticated;

-- 2. Remove UPDATE + DELETE from anon + authenticated on the audit log only.
REVOKE UPDATE, DELETE ON TABLE public.compliance_audit_log FROM anon, authenticated;

-- 3. Promote both audit-log guard triggers to ENABLE ALWAYS.
ALTER TABLE public.compliance_audit_log
  ENABLE ALWAYS TRIGGER compliance_audit_log_no_update_delete;

ALTER TABLE public.compliance_audit_log
  ENABLE ALWAYS TRIGGER compliance_audit_log_no_truncate;

COMMIT;
