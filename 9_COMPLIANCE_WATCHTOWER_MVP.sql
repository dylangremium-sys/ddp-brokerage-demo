-- 9_COMPLIANCE_WATCHTOWER_MVP.sql
-- Compliance Watchtower / Regulatory Intelligence & Export Readiness Engine MVP.
-- Apply after AUTH_RLS_SCHEMA.sql so public.is_ddp_admin() exists.
-- This creates admin-only compliance tables and does not expose compliance data
-- to farmer, buyer, or public pages.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.regulatory_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.legal_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES public.regulatory_sources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  affected_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_risk_level TEXT CHECK (ai_risk_level IS NULL OR ai_risk_level IN ('info', 'low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'needs_review', 'reviewed', 'rule_suggested', 'sent_to_legal', 'archived', 'rejected')),
  reviewer_notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.compliance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_update_id UUID REFERENCES public.legal_updates(id) ON DELETE SET NULL,
  alert_id UUID,
  rule_id UUID,
  title TEXT NOT NULL,
  review_type TEXT NOT NULL CHECK (review_type IN ('legal_update', 'alert', 'rule', 'readiness', 'document_status')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'reviewed', 'sent_to_legal', 'rejected', 'archived')),
  reviewer_notes TEXT NOT NULL DEFAULT '',
  decision TEXT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.compliance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  jurisdiction TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('farm', 'batch', 'coa', 'buyer', 'document', 'shipment', 'platform_claim', 'data_protection')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  is_blocking BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'suggested', 'approved', 'active', 'paused', 'retired', 'rejected')),
  source_legal_update_id UUID REFERENCES public.legal_updates(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.compliance_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('farm', 'batch', 'coa', 'buyer', 'document', 'shipment', 'platform_claim', 'data_protection')),
  entity_id TEXT NOT NULL,
  rule_id UUID REFERENCES public.compliance_rules(id) ON DELETE SET NULL,
  legal_update_id UUID REFERENCES public.legal_updates(id) ON DELETE SET NULL,
  alert_title TEXT NOT NULL,
  alert_detail TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'blocked', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT
);

CREATE TABLE IF NOT EXISTS public.compliance_entity_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('farm', 'batch', 'coa', 'buyer', 'document', 'shipment', 'platform_claim', 'data_protection')),
  entity_id TEXT NOT NULL,
  readiness_status TEXT NOT NULL CHECK (readiness_status IN ('not_ready', 'missing_documents', 'needs_compliance_review', 'buyer_ready_for_discussion', 'export_readiness_incomplete', 'ready_for_legal_review', 'human_approved', 'blocked')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('info', 'low', 'medium', 'high', 'critical')),
  missing_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocking_alert_count INTEGER NOT NULL DEFAULT 0 CHECK (blocking_alert_count >= 0),
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS public.compliance_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'ai_assistant', 'system', 'legal_reviewer')),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN (
    'legal_update_created',
    'legal_update_reviewed',
    'rule_suggested',
    'rule_approved',
    'rule_paused',
    'rule_retired',
    'alert_created',
    'alert_resolved',
    'readiness_status_changed',
    'document_status_changed',
    'sent_to_legal_review',
    'reviewer_note_added',
    'rule_rejected',
    'legal_update_archived',
    'alert_dismissed'
  )),
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_state JSONB,
  after_state JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_updates_status ON public.legal_updates(status);
CREATE INDEX IF NOT EXISTS idx_legal_updates_detected_at ON public.legal_updates(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_reviews_status ON public.compliance_reviews(status);
CREATE INDEX IF NOT EXISTS idx_compliance_rules_status ON public.compliance_rules(status);
CREATE INDEX IF NOT EXISTS idx_compliance_alerts_status ON public.compliance_alerts(status);
CREATE INDEX IF NOT EXISTS idx_compliance_alerts_entity ON public.compliance_alerts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_compliance_entity_status_entity ON public.compliance_entity_status(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_entity ON public.compliance_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_created_at ON public.compliance_audit_log(created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_compliance_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'compliance_audit_log is append-only; attempted % is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS compliance_audit_log_no_update_delete ON public.compliance_audit_log;
CREATE TRIGGER compliance_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON public.compliance_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_compliance_audit_log_mutation();

ALTER TABLE public.regulatory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_entity_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "regulatory_sources: admin all" ON public.regulatory_sources;
CREATE POLICY "regulatory_sources: admin all" ON public.regulatory_sources
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "legal_updates: admin all" ON public.legal_updates;
CREATE POLICY "legal_updates: admin all" ON public.legal_updates
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_reviews: admin all" ON public.compliance_reviews;
CREATE POLICY "compliance_reviews: admin all" ON public.compliance_reviews
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_rules: admin all" ON public.compliance_rules;
CREATE POLICY "compliance_rules: admin all" ON public.compliance_rules
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_alerts: admin all" ON public.compliance_alerts;
CREATE POLICY "compliance_alerts: admin all" ON public.compliance_alerts
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_entity_status: admin all" ON public.compliance_entity_status;
CREATE POLICY "compliance_entity_status: admin all" ON public.compliance_entity_status
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_audit_log: admin insert" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: admin insert" ON public.compliance_audit_log
  FOR INSERT WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "compliance_audit_log: admin select" ON public.compliance_audit_log;
CREATE POLICY "compliance_audit_log: admin select" ON public.compliance_audit_log
  FOR SELECT USING (public.is_ddp_admin());
