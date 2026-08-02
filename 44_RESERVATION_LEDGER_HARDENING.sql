-- =============================================================================
-- 44_RESERVATION_LEDGER_HARDENING.sql
--
-- Marketplace reservations, as an append-only ledger.
--
-- Depends on migration 39 (public.organisations) and the pre-numbering
-- inventory_batches columns quantity_kg / client_visible.
--
-- FIRST MIGRATION OF THE OPTION B MARKETPLACE. It is written to the four rules
-- in docs/OPTION_B_SEAM_CONTRACT.md, which exist so that adding physical
-- custody later is a plug-in and not a rewrite. Read that document before
-- changing anything here.
--
-- WHY A LEDGER AND NOT A COLUMN (seam 2)
-- The obvious design is `inventory_batches.reserved_kg`, decremented on
-- reservation. It fails three ways at once:
--   • it loses its own history the moment it is written;
--   • two concurrent buyers both read it before either writes, and both succeed;
--   • when Option A introduces lots that SPLIT, the identity the number was
--     attached to stops existing, and every reservation silently points at the
--     wrong thing.
-- So a reservation is a row, a release is another row, and availability is a
-- SUM evaluated when asked — exactly the shape migration 40 already uses for
-- permit draw-down.
--
-- WHY EXPIRY IS COMPUTED (seam 3)
-- There is no `expired` state and no sweeper to write one. This repository has
-- no scheduler at all — `vercel.json` declares zero crons — so a stored expiry
-- flag would be exactly as fresh as a job that never runs, and a buyer would
-- see quantity held by a reservation that lapsed days ago. A reservation is
-- active when nothing has released it AND `expires_at` is still in the future.
-- Hold is 7 days.
--
-- WHY stock_status IS NOT TOUCHED
-- `inventory_batches.stock_status` already carries a 'reserved' value. It is a
-- FARMER-FACING WORKFLOW FLAG that predates this work, and writing it here
-- would create a second source of truth that goes stale the instant a
-- reservation expires. The ledger is authoritative. VERIFY section G asserts
-- this migration never writes it.
--
-- OVERSELLING IS A COMPLIANCE INCIDENT, NOT A CUSTOMER-SERVICE PROBLEM
-- Enforced by a trigger holding `SELECT … FOR UPDATE` on the batch, so two
-- simultaneous reservations serialise rather than both passing the check. A
-- CHECK constraint cannot express a cross-row SUM; this is the correct
-- mechanism and it is the one already proven in migration 40.
--
--   • Rollback: 44_RESERVATION_LEDGER_ROLLBACK.sql
--   • Verify:   44_RESERVATION_LEDGER_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 39 (public.organisations)');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inventory_batches' AND column_name='quantity_kg') THEN
    v_missing := array_append(v_missing, 'inventory_batches.quantity_kg');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inventory_batches' AND column_name='client_visible') THEN
    v_missing := array_append(v_missing, 'inventory_batches.client_visible');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 44 requires: %.', array_to_string(v_missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Reservations — immutable once made
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reservations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  inventory_batch_id     uuid NOT NULL REFERENCES public.inventory_batches(id) ON DELETE RESTRICT,
  buyer_organisation_id  uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,

  -- Upper bound is not decoration: PostgreSQL sorts numeric NaN ABOVE every real
  -- number, so a lower-bound-only CHECK would admit it, and one NaN in an
  -- availability subtraction turns every later comparison false.
  quantity_kg            numeric(14,3) NOT NULL
                           CHECK (quantity_kg > 0 AND quantity_kg <= 1000000),

  created_at             timestamptz NOT NULL DEFAULT now(),

  -- 7-day hold (owner decision, 2026-07-30). Explicit rather than derived so a
  -- future change of policy does not silently re-date reservations already made.
  expires_at             timestamptz NOT NULL DEFAULT (now() + interval '7 days'),

  created_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  note                   text,

  CONSTRAINT reservations_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_reservations_batch  ON public.reservations (inventory_batch_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_buyer  ON public.reservations (buyer_organisation_id, created_at DESC);

COMMENT ON TABLE public.reservations IS
  'Append-only marketplace reservations. Availability is quantity_kg minus the SUM '
  'of active reservations, computed at read time. There is no stored expiry state '
  'and no sweeper; see docs/OPTION_B_SEAM_CONTRACT.md.';

-- -----------------------------------------------------------------------------
-- 2. Releases — one per reservation, also append-only
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reservation_releases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- UNIQUE, so a reservation cannot be released twice. Releasing twice would
  -- not double-free quantity today (active-ness is boolean), but it would make
  -- the ledger describe two different endings for one reservation.
  reservation_id   uuid NOT NULL UNIQUE REFERENCES public.reservations(id) ON DELETE RESTRICT,

  kind             text NOT NULL CHECK (kind IN ('released', 'cancelled', 'converted')),

  -- SEAM 1 PLUG POINT. Free text today because the consignment entity does not
  -- exist yet; this becomes a foreign key when it does. A conversion with no
  -- reference is a reservation that turned into a shipment nobody can find.
  consignment_ref  text,

  reason           text NOT NULL CHECK (length(btrim(reason)) > 0),
  released_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  released_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT releases_converted_requires_consignment
    CHECK (kind <> 'converted'
           OR (consignment_ref IS NOT NULL AND length(btrim(consignment_ref)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_reservation_releases_reservation
  ON public.reservation_releases (reservation_id);

-- -----------------------------------------------------------------------------
-- 3. Append-only enforcement
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_reservation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; attempted % is not allowed. End a reservation by inserting a '
    'release row, never by editing or deleting the reservation.', TG_TABLE_NAME, TG_OP;
END
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_reservation_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prevent_reservation_mutation() TO service_role;

DROP TRIGGER IF EXISTS reservations_no_update_delete ON public.reservations;
CREATE TRIGGER reservations_no_update_delete
  BEFORE UPDATE OR DELETE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_reservation_mutation();

DROP TRIGGER IF EXISTS reservation_releases_no_update_delete ON public.reservation_releases;
CREATE TRIGGER reservation_releases_no_update_delete
  BEFORE UPDATE OR DELETE ON public.reservation_releases
  FOR EACH ROW EXECUTE FUNCTION public.prevent_reservation_mutation();

-- -----------------------------------------------------------------------------
-- 4. Active-ness, reserved and available — all computed
-- -----------------------------------------------------------------------------

-- A reservation is active when nothing released it and it has not lapsed.
-- Fail closed on an unknown id: false, never NULL.
CREATE OR REPLACE FUNCTION public.reservation_is_active(
  p_reservation_id uuid,
  p_as_of          timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT r.expires_at > p_as_of
        AND NOT EXISTS (SELECT 1 FROM public.reservation_releases x WHERE x.reservation_id = r.id)
     FROM public.reservations r
     WHERE r.id = p_reservation_id),
    false)
$$;

-- Internal, unguarded sum. Split out so the authorisation wrapper below and the
-- availability trigger can share one definition of "active".
CREATE OR REPLACE FUNCTION public.batch_reserved_kg_unchecked(
  p_batch_id uuid,
  p_as_of    timestamptz DEFAULT now())
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(r.quantity_kg), 0)::numeric
  FROM public.reservations r
  WHERE r.inventory_batch_id = p_batch_id
    AND r.expires_at > p_as_of
    AND NOT EXISTS (SELECT 1 FROM public.reservation_releases x WHERE x.reservation_id = r.id)
$$;

REVOKE EXECUTE ON FUNCTION public.batch_reserved_kg_unchecked(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.batch_reserved_kg_unchecked(uuid, timestamptz) TO service_role;

-- How much of this batch is held.
--
-- SEAM 4: this is SUPPLY-SIDE information. It tells a farm how much of their own
-- stock is spoken for, and it is not a buyer's business — aggregate demand on a
-- listing is commercially sensitive and, over time, correlating. Restricted to
-- DDP and the owning farm; everyone else is refused rather than given zero,
-- because zero and "not allowed to know" are different answers.
CREATE OR REPLACE FUNCTION public.batch_reserved_kg(
  p_batch_id uuid,
  p_as_of    timestamptz DEFAULT now())
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_farm uuid;
BEGIN
  SELECT b.farm_id INTO v_farm FROM public.inventory_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % does not exist', p_batch_id;
  END IF;

  IF NOT (public.is_ddp_admin() OR public.has_farm_membership(v_farm)) THEN
    RAISE EXCEPTION
      'not permitted: reserved quantity for a batch is visible to DDP and to the owning farm only';
  END IF;

  RETURN public.batch_reserved_kg_unchecked(p_batch_id, p_as_of);
END
$$;

-- How much a buyer could still take.
--
-- Readable by DDP, by the owning farm, and — only for a PUBLISHED batch — by any
-- signed-in caller, because that is the number a marketplace listing exists to
-- show. An unpublished batch is not a listing and its availability is nobody's
-- business.
--
-- FAIL CLOSED ON AN UNUSABLE QUANTITY. A batch whose quantity_kg is NULL, NaN,
-- Infinity or non-positive has no meaningful availability, and returning 0 for
-- it is the honest answer: nothing can be reserved against a number that cannot
-- be compared.
CREATE OR REPLACE FUNCTION public.batch_available_kg(
  p_batch_id uuid,
  p_as_of    timestamptz DEFAULT now())
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_farm    uuid;
  v_qty     numeric;
  v_visible boolean;
BEGIN
  SELECT b.farm_id, b.quantity_kg, b.client_visible
    INTO v_farm, v_qty, v_visible
  FROM public.inventory_batches b WHERE b.id = p_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % does not exist', p_batch_id;
  END IF;

  IF NOT (public.is_ddp_admin() OR public.has_farm_membership(v_farm) OR v_visible) THEN
    RAISE EXCEPTION
      'not permitted: availability for an unpublished batch is visible to DDP and to the owning farm only';
  END IF;

  IF v_qty IS NULL OR NOT (v_qty > 0 AND v_qty <= 1000000) THEN
    RETURN 0;
  END IF;

  RETURN greatest(v_qty - public.batch_reserved_kg_unchecked(p_batch_id, p_as_of), 0);
END
$$;

REVOKE EXECUTE ON FUNCTION public.reservation_is_active(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.batch_reserved_kg(uuid, timestamptz)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.batch_available_kg(uuid, timestamptz)    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reservation_is_active(uuid, timestamptz) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.batch_reserved_kg(uuid, timestamptz)     TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.batch_available_kg(uuid, timestamptz)    TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. The oversell guard
--
-- CONCURRENCY. Two buyers reserving the last of a batch at the same instant
-- would, under READ COMMITTED, both compute availability before either row was
-- visible to the other, and both would succeed. `FOR UPDATE` on the batch makes
-- the second transaction wait for the first to commit and then recompute.
--
-- It also enforces WHAT MAY BE RESERVED AT ALL, which belongs here rather than
-- in application code: the batch must be published, and the buyer must be a
-- verified buyer organisation. A marketplace should be structurally incapable
-- of holding stock for a party that could not lawfully receive it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_enforce_reservation_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_qty       numeric;
  v_visible   boolean;
  v_reserved  numeric;
  v_org_type  text;
  v_org_state text;
BEGIN
  SELECT b.quantity_kg, b.client_visible
    INTO v_qty, v_visible
  FROM public.inventory_batches b
  WHERE b.id = NEW.inventory_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch % does not exist', NEW.inventory_batch_id;
  END IF;

  IF NOT v_visible THEN
    RAISE EXCEPTION
      'batch % is not published; an unpublished batch is not a listing and cannot be reserved',
      NEW.inventory_batch_id;
  END IF;

  -- NULL / NaN / Infinity / non-positive all land here. A quantity that cannot
  -- be compared cannot be reserved against.
  IF v_qty IS NULL OR NOT (v_qty > 0 AND v_qty <= 1000000) THEN
    RAISE EXCEPTION
      'batch % has no usable quantity (%); nothing can be reserved against it',
      NEW.inventory_batch_id, v_qty;
  END IF;

  SELECT o.org_type, o.verification_state
    INTO v_org_type, v_org_state
  FROM public.organisations o WHERE o.id = NEW.buyer_organisation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'organisation % does not exist', NEW.buyer_organisation_id;
  END IF;
  IF v_org_type <> 'buyer' THEN
    RAISE EXCEPTION
      'organisation % is of type "%", not a buyer, and may not hold a reservation',
      NEW.buyer_organisation_id, v_org_type;
  END IF;
  IF v_org_state <> 'verified' THEN
    RAISE EXCEPTION
      'buyer % is in verification state "%"; only a verified buyer may hold stock',
      NEW.buyer_organisation_id, v_org_state;
  END IF;

  v_reserved := public.batch_reserved_kg_unchecked(NEW.inventory_batch_id, NEW.created_at);

  IF v_reserved + NEW.quantity_kg > v_qty THEN
    RAISE EXCEPTION
      'batch % has % kg available (quantity % kg, % kg already reserved) and cannot absorb a % kg reservation',
      NEW.inventory_batch_id, v_qty - v_reserved, v_qty, v_reserved, NEW.quantity_kg;
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_enforce_reservation_availability() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_enforce_reservation_availability() TO service_role;

DROP TRIGGER IF EXISTS reservations_enforce_availability ON public.reservations;
CREATE TRIGGER reservations_enforce_availability
  BEFORE INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_reservation_availability();

-- -----------------------------------------------------------------------------
-- 6. Audit vocabulary — cumulative
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_audit_log
  DROP CONSTRAINT IF EXISTS compliance_audit_log_action_check;
ALTER TABLE public.compliance_audit_log
  ADD CONSTRAINT compliance_audit_log_action_check
  CHECK (action IN (
    'legal_update_created', 'legal_update_reviewed', 'rule_suggested', 'rule_approved',
    'rule_paused', 'rule_retired', 'alert_created', 'alert_resolved',
    'readiness_status_changed', 'document_status_changed', 'sent_to_legal_review',
    'reviewer_note_added', 'rule_rejected', 'legal_update_archived', 'alert_dismissed',
    'organisation_created', 'organisation_updated', 'organisation_verification_changed',
    'organisation_membership_granted', 'organisation_membership_revoked',
    'licence_recorded', 'licence_state_changed', 'permit_recorded', 'permit_state_changed',
    'permit_drawn_down', 'permit_drawdown_reversed',
    'export_eligibility_evaluated', 'export_gate_overridden', 'export_gate_override_reviewed',
    'screening_recorded',
    'reservation_created', 'reservation_released'
  ));

CREATE OR REPLACE FUNCTION public.fn_audit_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  -- One trigger function serves two tables with different shapes. Field access
  -- like NEW.reservation_id cannot be used here: plpgsql resolves record fields
  -- when it PLANS the expression, not when it evaluates it, so a CASE naming a
  -- column that exists on only one of the two tables fails on the other even in
  -- the branch that is never taken. Going through jsonb resolves at runtime.
  v_row    jsonb := to_jsonb(NEW);
  v_action text;
  v_entity text;
  v_reason text;
BEGIN
  IF TG_TABLE_NAME = 'reservations' THEN
    v_action := 'reservation_created';
    v_entity := v_row ->> 'id';
    v_reason := v_row ->> 'note';
  ELSE
    v_action := 'reservation_released';
    v_entity := v_row ->> 'reservation_id';
    v_reason := v_row ->> 'reason';
  END IF;

  INSERT INTO public.compliance_audit_log
    (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'admin' END,
    v_actor, v_action, 'reservation', v_entity, NULL, v_row, v_reason
  );
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_audit_reservation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_audit_reservation() TO service_role;

DROP TRIGGER IF EXISTS reservations_audit ON public.reservations;
CREATE TRIGGER reservations_audit
  AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_reservation();

DROP TRIGGER IF EXISTS reservation_releases_audit ON public.reservation_releases;
CREATE TRIGGER reservation_releases_audit
  AFTER INSERT ON public.reservation_releases
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_reservation();

-- -----------------------------------------------------------------------------
-- 7. Row level security — seam 4, the double-blind rule
--
-- A reservation row names a buyer organisation AND a farm's batch in the same
-- row. It is the most direct leak surface in the marketplace and, unlike an
-- export evaluation, buyers can see it.
--
--   • a BUYER reads their own reservations, and cannot resolve the farm behind
--     the batch (inventory_batches' own RLS denies them the row);
--   • a FARMER reads NO reservation rows at all — they get a quantity through
--     batch_reserved_kg(), never a counterparty;
--   • only ddp_admin sees both sides.
-- -----------------------------------------------------------------------------
ALTER TABLE public.reservations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_releases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservations_select ON public.reservations;
CREATE POLICY reservations_select ON public.reservations
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_organisation_membership(buyer_organisation_id));

-- A buyer may reserve for their OWN organisation only. Reserving on behalf of
-- another organisation would put a hold, and later a shipment, in somebody
-- else's name.
DROP POLICY IF EXISTS reservations_insert ON public.reservations;
CREATE POLICY reservations_insert ON public.reservations
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ddp_admin() OR public.has_organisation_membership(buyer_organisation_id));

DROP POLICY IF EXISTS reservation_releases_select ON public.reservation_releases;
CREATE POLICY reservation_releases_select ON public.reservation_releases
  FOR SELECT TO authenticated
  USING (
    public.is_ddp_admin()
    OR EXISTS (SELECT 1 FROM public.reservations r
               WHERE r.id = reservation_id
                 AND public.has_organisation_membership(r.buyer_organisation_id))
  );

-- A buyer may CANCEL their own reservation. 'released' and 'converted' are DDP
-- actions: releasing is a broker decision, and converting turns a hold into a
-- shipment, which is not a thing a buyer does unilaterally.
DROP POLICY IF EXISTS reservation_releases_insert ON public.reservation_releases;
CREATE POLICY reservation_releases_insert ON public.reservation_releases
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_ddp_admin()
    OR (kind = 'cancelled'
        AND EXISTS (SELECT 1 FROM public.reservations r
                    WHERE r.id = reservation_id
                      AND public.has_organisation_membership(r.buyer_organisation_id)))
  );

-- -----------------------------------------------------------------------------
-- 8. Grants
--
-- No UPDATE or DELETE is granted on either table, to anyone. The append-only
-- triggers are the behavioural guarantee; withholding the privilege means they
-- are the second line of defence rather than the only one.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.reservations         FROM PUBLIC, anon;
REVOKE ALL ON public.reservation_releases FROM PUBLIC, anon;

GRANT SELECT, INSERT ON public.reservations         TO authenticated, service_role;
GRANT SELECT, INSERT ON public.reservation_releases TO authenticated, service_role;

COMMIT;
