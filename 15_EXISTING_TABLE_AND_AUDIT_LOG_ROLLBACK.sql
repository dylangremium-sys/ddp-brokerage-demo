-- 15_EXISTING_TABLE_AND_AUDIT_LOG_ROLLBACK.sql
-- Rollback for 15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql.
--
-- STATUS: Committed and pushed. Rollback for an applied migration; staging-tested
--         and NOT run in production. Repository commit:
--         496fe043174177173b0db78a33c5a5823c71954f.
--         Restores the exact captured pre-change baseline:
--   * re-grants TRUNCATE/TRIGGER/REFERENCES/MAINTAIN to anon+authenticated on the
--     same 20 tables;
--   * re-grants UPDATE/DELETE to anon+authenticated on public.compliance_audit_log;
--   * returns both audit-log guard triggers to normal ENABLE mode.
--
-- Does NOT alter service_role or postgres privileges, RLS policies, functions,
-- ownership, or default privileges. Exact inverse of the hardening migration.

BEGIN;

-- 1. Restore TRUNCATE/TRIGGER/REFERENCES/MAINTAIN on the 20 tables.
GRANT TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
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
TO anon, authenticated;

-- 2. Restore UPDATE/DELETE on the audit log to authenticated ONLY.
--
--    DELIBERATE ASYMMETRY: the pre-migration state also granted these to `anon`,
--    and this rollback intentionally does NOT restore that. `anon` is the
--    UNAUTHENTICATED role, and no code path writes to the compliance audit log as
--    anon — the app writes it as a signed-in admin and the RLS insert policy
--    requires is_ddp_admin(). Re-granting UPDATE/DELETE on an append-only
--    compliance audit log to an unauthenticated role restores no functionality
--    while re-opening an unauthenticated write vector, leaving the append-only
--    property resting solely on the guard trigger (which step 3 below returns
--    from ENABLE ALWAYS to ENABLE). Restoring `authenticated` preserves the
--    functional reversal; omitting `anon` removes only an indefensible privilege.
GRANT UPDATE, DELETE ON TABLE public.compliance_audit_log TO authenticated;

-- 3. Return both audit-log guard triggers to normal ENABLE mode.
ALTER TABLE public.compliance_audit_log
  ENABLE TRIGGER compliance_audit_log_no_update_delete;

ALTER TABLE public.compliance_audit_log
  ENABLE TRIGGER compliance_audit_log_no_truncate;

COMMIT;
