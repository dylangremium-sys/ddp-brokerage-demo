-- =============================================================================
-- 39_COUNTERPARTY_ORGANISATIONS_HARDENING.sql
--
-- Counterparty identity: organisations, memberships, and the buyer role.
--
-- WHY THIS EXISTS
-- Until this migration the database knows exactly two kinds of party: DDP and a
-- farm. There is no buyer, no laboratory, no carrier. Every downstream export
-- control in the technology plan — buyer eligibility, import-permit draw-down,
-- licence expiry gating, denied-party screening — is a statement ABOUT a
-- counterparty, and none of them can be written until a counterparty is a row.
-- This migration is that row and nothing more.
--
-- WHAT IT DOES
--   1. public.organisations          — farm | buyer | laboratory | carrier |
--                                      broker | internal, with country, Foreign
--                                      Business Act ownership attributes, and a
--                                      verification state that requires evidence.
--   2. public.organisation_memberships — which users act for which organisation.
--   3. profiles.role gains 'buyer'   — so a buyer identity can exist at all.
--   4. public.has_organisation_membership(uuid) — the RLS predicate.
--   5. compliance_audit_log's action vocabulary widened, and an audit trigger on
--      organisations, so §11.2's "an audit event for every state change" holds
--      for the new domain without opening a second audit trail.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   • No lots, custody events, consignments or warehouse objects. The custody
--     question is open (Option A vs Option B) and nothing here presumes it.
--   • No buyer self-service writes. Organisations are DDP-admin-written and
--     member-readable. That is not a temporary simplification: under the
--     double-blind brokerage rule DDP is the only party permitted to see both
--     sides, so counterparty records are a DDP function by construction.
--   • No licences and no permits. They are migration 40, and they depend on
--     this table existing first.
--
-- THE DOUBLE-BLIND RULE IS THE POINT OF THE RLS HERE
-- Neither side may ever learn the other's identity: a leak in either direction
-- loses both the supplier and the customer at once, because they transact
-- direct. So the SELECT policy is membership-scoped with no cross-organisation
-- visibility of any kind — not even "buyers can see other buyers". A farmer
-- identity sees zero buyer organisations and a buyer identity sees zero farm
-- organisations, and VERIFY section E proves it by querying as those roles
-- rather than by reading the policy text.
--
-- SAFETY
--   • Additive. Creates two new tables; the only pre-existing objects touched
--     are profiles' role CHECK (widened, never narrowed) and
--     compliance_audit_log's action CHECK (widened, never narrowed).
--   • Idempotent. Safe to re-run; every object is IF NOT EXISTS or OR REPLACE.
--   • Rollback: 39_COUNTERPARTY_ORGANISATIONS_ROLLBACK.sql
--   • Verify:   39_COUNTERPARTY_ORGANISATIONS_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Organisations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organisations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Every counterparty class the plan's domain model names. Enumerated at the
  -- database rather than in TypeScript because the export gate's behaviour
  -- diverges by class, and a typo'd org_type would silently route a consignment
  -- down the wrong branch.
  org_type            text NOT NULL CHECK (org_type IN (
                        'farm', 'buyer', 'laboratory', 'carrier', 'broker', 'internal')),

  legal_name          text NOT NULL CHECK (length(btrim(legal_name)) > 0),

  -- Trading name, where it differs from the registered legal name. Optional:
  -- the legal name is the one that must match the permit.
  display_name        text,

  -- ISO 3166-1 alpha-2, upper case. The destination ruleset is keyed on this,
  -- so a lower-case or three-letter value would fail to resolve a ruleset and —
  -- under a fail-closed gate — block a legitimate shipment. Constrain it here.
  country_code        char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),

  -- Foreign Business Act attribute (plan D5). Eligibility to hold a Thai licence
  -- turns on a Thai ownership threshold, and that is a CONTINUOUS condition, not
  -- a one-off check — so it is a column that can be re-measured and re-evidenced.
  --
  -- NOTE ON THE UPPER BOUND. In PostgreSQL, numeric 'NaN' compares GREATER THAN
  -- every non-NaN value, so `CHECK (pct >= 0)` alone would ADMIT NaN. It is the
  -- `<= 100` half that excludes it. Anyone relaxing the upper bound re-opens a
  -- hole through which an unorderable value enters an eligibility calculation.
  thai_ownership_pct  numeric(5,2) CHECK (
                        thai_ownership_pct IS NULL
                        OR (thai_ownership_pct >= 0 AND thai_ownership_pct <= 100)),
  ownership_evidence_note text,

  -- Verification is an actor, a timestamp and a basis — never a boolean.
  verification_state  text NOT NULL DEFAULT 'unverified' CHECK (verification_state IN (
                        'unverified', 'in_review', 'verified', 'rejected', 'suspended')),
  verified_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at         timestamptz,
  verification_basis  text,

  -- When this organisation IS one of the farms already onboarded, point at it
  -- rather than duplicating the identity. A second, drifting copy of a farm's
  -- legal name is how a dossier ends up naming a party that does not exist.
  farm_id             uuid REFERENCES public.farms(id) ON DELETE RESTRICT,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A farm link only makes sense on a farm organisation, and one farm may not
  -- be represented by two organisations.
  CONSTRAINT organisations_farm_link_requires_farm_type
    CHECK (farm_id IS NULL OR org_type = 'farm'),

  -- "Verified" with no named verifier and no timestamp is an assertion, not
  -- evidence, and the export gate is entitled to rely on this field.
  CONSTRAINT organisations_verified_requires_evidence
    CHECK (verification_state <> 'verified'
           OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),

  -- Likewise a rejection: a counterparty refused with no recorded basis cannot
  -- be reviewed, appealed, or explained to a regulator.
  CONSTRAINT organisations_rejected_requires_basis
    CHECK (verification_state <> 'rejected'
           OR (verification_basis IS NOT NULL AND length(btrim(verification_basis)) > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_organisations_farm_id
  ON public.organisations (farm_id) WHERE farm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organisations_type_state
  ON public.organisations (org_type, verification_state);
CREATE INDEX IF NOT EXISTS idx_organisations_country
  ON public.organisations (country_code);

COMMENT ON TABLE public.organisations IS
  'Counterparty registry: farms, buyers, laboratories, carriers, brokers. '
  'DDP-admin-written, member-readable. Under the double-blind rule no '
  'organisation is ever visible to a member of a different organisation.';

-- -----------------------------------------------------------------------------
-- 2. Organisation memberships
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organisation_memberships (
  organisation_id  uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Mirrors farm_memberships' vocabulary ('owner','operator') and extends it,
  -- so the two membership models read the same way to a reviewer.
  org_role         text NOT NULL DEFAULT 'operator'
                     CHECK (org_role IN ('owner', 'admin', 'operator', 'viewer')),

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  PRIMARY KEY (organisation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organisation_memberships_user
  ON public.organisation_memberships (user_id);

-- -----------------------------------------------------------------------------
-- 3. The buyer role
--
-- profiles.role has been widened once before (migration 21 added 'pending'), by
-- dropping and re-adding the constraint under its auto-generated name. Same
-- approach, same name. The list is cumulative: this migration ADDS 'buyer' and
-- removes nothing, so no existing row can be invalidated by it.
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('ddp_admin', 'farmer', 'pending', 'buyer'));

-- -----------------------------------------------------------------------------
-- 4. RLS predicate
--
-- SECURITY DEFINER with a pinned search_path: it is called from inside RLS
-- USING clauses evaluated as the querying role, which cannot itself read
-- organisation_memberships. An unpinned search_path on a DEFINER function is a
-- privilege-escalation vector and `npm run security:sql` fails the build on one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_organisation_membership(target_organisation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_memberships
    WHERE organisation_id = target_organisation_id
      AND user_id = auth.uid()
  )
$$;

REVOKE EXECUTE ON FUNCTION public.has_organisation_membership(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_organisation_membership(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_organisations_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_organisations_touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_organisations_touch_updated_at() TO service_role;

DROP TRIGGER IF EXISTS organisations_touch_updated_at ON public.organisations;
CREATE TRIGGER organisations_touch_updated_at
  BEFORE UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.fn_organisations_touch_updated_at();

-- -----------------------------------------------------------------------------
-- 6. Audit
--
-- One audit trail, not two. compliance_audit_log is already append-only
-- (migration 9's trigger) and TRUNCATE-hardened (migration 11); routing
-- counterparty events anywhere else would create a second log with neither
-- property, and §10 asks for one immutable log an auditor can read.
--
-- The action CHECK is inline in migration 9 and therefore auto-named
-- `compliance_audit_log_action_check`. Widening it is a DROP + re-ADD under
-- that name. Every pre-existing value is retained verbatim.
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_audit_log
  DROP CONSTRAINT IF EXISTS compliance_audit_log_action_check;
ALTER TABLE public.compliance_audit_log
  ADD CONSTRAINT compliance_audit_log_action_check
  CHECK (action IN (
    -- migration 9's original vocabulary, unchanged
    'legal_update_created', 'legal_update_reviewed', 'rule_suggested', 'rule_approved',
    'rule_paused', 'rule_retired', 'alert_created', 'alert_resolved',
    'readiness_status_changed', 'document_status_changed', 'sent_to_legal_review',
    'reviewer_note_added', 'rule_rejected', 'legal_update_archived', 'alert_dismissed',
    -- migration 39: counterparty identity
    'organisation_created', 'organisation_updated', 'organisation_verification_changed',
    'organisation_membership_granted', 'organisation_membership_revoked'
  ));

CREATE OR REPLACE FUNCTION public.fn_audit_organisation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_action   text;
  v_before   jsonb;
  v_after    jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'organisation_created';
    v_before := NULL;
    v_after  := to_jsonb(NEW);
  ELSE
    -- A verification-state change is its own action. It is the event a
    -- regulator or an auditor actually looks for, and burying it inside a
    -- generic "updated" makes it unfindable in a log of any size.
    v_action := CASE
                  WHEN NEW.verification_state IS DISTINCT FROM OLD.verification_state
                    THEN 'organisation_verification_changed'
                  ELSE 'organisation_updated'
                END;
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
  END IF;

  INSERT INTO public.compliance_audit_log
    (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (
    -- auth.uid() is NULL for a service_role/back-office connection with no JWT.
    -- That is a genuinely different actor from a signed-in admin and is recorded
    -- as such rather than being attributed to whoever happens to be an admin.
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'admin' END,
    v_actor,
    v_action,
    'organisation',
    NEW.id::text,
    v_before,
    v_after,
    NEW.verification_basis
  );

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_audit_organisation_change() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_audit_organisation_change() TO service_role;

DROP TRIGGER IF EXISTS organisations_audit ON public.organisations;
CREATE TRIGGER organisations_audit
  AFTER INSERT OR UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_organisation_change();

-- -----------------------------------------------------------------------------
-- 7. Row level security
--
-- Deny by default: RLS is enabled and no policy names anon. Table privileges are
-- revoked from anon as well, so the policies are the second line rather than the
-- only one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.organisations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organisations_select ON public.organisations;
CREATE POLICY organisations_select ON public.organisations
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_organisation_membership(id));

DROP POLICY IF EXISTS organisations_insert ON public.organisations;
CREATE POLICY organisations_insert ON public.organisations
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS organisations_update ON public.organisations;
CREATE POLICY organisations_update ON public.organisations
  FOR UPDATE TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS organisations_delete ON public.organisations;
CREATE POLICY organisations_delete ON public.organisations
  FOR DELETE TO authenticated
  USING (public.is_ddp_admin());

-- Memberships: a user may see their OWN membership rows, and an admin sees all.
-- Co-members are deliberately not visible to each other; that is a directory
-- feature, and a directory is a disclosure surface.
DROP POLICY IF EXISTS organisation_memberships_select ON public.organisation_memberships;
CREATE POLICY organisation_memberships_select ON public.organisation_memberships
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR user_id = auth.uid());

DROP POLICY IF EXISTS organisation_memberships_write ON public.organisation_memberships;
CREATE POLICY organisation_memberships_write ON public.organisation_memberships
  FOR ALL TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.organisations            FROM PUBLIC, anon;
REVOKE ALL ON public.organisation_memberships FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisations            TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisation_memberships TO authenticated, service_role;

COMMIT;
