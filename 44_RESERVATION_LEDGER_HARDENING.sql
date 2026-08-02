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
-- COMMERCIAL EVENTS GO IN THEIR OWN LOG
-- Reservations are commercial, not regulatory, so this migration creates
-- public.commercial_audit_log rather than widening compliance_audit_log's closed
-- 15-value regulatory vocabulary. Target architecture §2.6, gap item MC-18. The
-- compliance log's constraint is NOT touched here.
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

  -- SEAM 6 PLUG POINT (docs/OPTION_B_SEAM_CONTRACT.md).
  --
  -- A batch row carries farm-identifying columns, so a buyer-facing record bound
  -- to it leaves the double-blind rule resting on RLS alone with nothing
  -- structural underneath. Buyers are meant to transact against a LISTING.
  --
  -- `listings` does not exist yet, so this is nullable and unconstrained — the
  -- same shape as the consignment_ref plug points in migrations 40 and 42. While
  -- there are no listings, inventory_batch_id stays authoritative and this is
  -- NULL. When listings lands, new reservations set both, listing_id becomes the
  -- buyer-facing reference, and the change is a BACKFILL of a column that already
  -- exists rather than a migration of live reservations. That is the entire
  -- reason to add it now, while it costs nothing.
  listing_id             uuid,

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

-- A row-level trigger does not fire on TRUNCATE, and on hosted Supabase
-- service_role inherits TRUNCATE on new public tables — so without this a
-- single statement empties an "append-only" log. Statement-level guard,
-- modelled on migration 11. The reused function raises on TG_OP alone (no
-- NEW, no OLD), which is what makes it safe at statement level.
DROP TRIGGER IF EXISTS reservations_no_truncate ON public.reservations;
CREATE TRIGGER reservations_no_truncate
  BEFORE TRUNCATE ON public.reservations
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_reservation_mutation();

DROP TRIGGER IF EXISTS reservations_no_update_delete ON public.reservations;
CREATE TRIGGER reservations_no_update_delete
  BEFORE UPDATE OR DELETE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_reservation_mutation();

-- A row-level trigger does not fire on TRUNCATE, and on hosted Supabase
-- service_role inherits TRUNCATE on new public tables — so without this a
-- single statement empties an "append-only" log. Statement-level guard,
-- modelled on migration 11. The reused function raises on TG_OP alone (no
-- NEW, no OLD), which is what makes it safe at statement level.
DROP TRIGGER IF EXISTS reservation_releases_no_truncate ON public.reservation_releases;
CREATE TRIGGER reservation_releases_no_truncate
  BEFORE TRUNCATE ON public.reservation_releases
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_reservation_mutation();

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
  v_now       timestamptz := now();
BEGIN
  -- created_at IS SERVER-AUTHORITATIVE, AND THIS IS A SECURITY CONTROL.
  --
  -- It is a plain column with a default, so a client holding INSERT — which a
  -- buyer does, for their own organisation — could otherwise supply one. A
  -- FUTURE created_at makes the availability check below measure the batch at a
  -- moment when earlier holds have already lapsed, so the ceiling is computed
  -- against a batch that looks emptier than it is, and the reservation lands
  -- anyway. The result is a batch reserved beyond its own quantity, right now.
  -- Overwriting the value costs nothing and closes it completely.
  NEW.created_at := v_now;

  -- Likewise the hold length. Without a ceiling a buyer could set expires_at
  -- years out and hold stock indefinitely, which is the same denial-of-supply
  -- with a different shape. 7 days is the owner's policy (2026-07-30);
  -- lengthening it is a policy change and belongs in a migration, not a payload.
  IF NEW.expires_at > v_now + interval '7 days' THEN
    RAISE EXCEPTION
      'reservation hold may not exceed 7 days (requested expiry %, limit %)',
      NEW.expires_at, v_now + interval '7 days';
  END IF;

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

  -- Evaluated at NOW, never at a caller-supplied instant. See the created_at
  -- note above: measuring at any other moment is precisely the bypass.
  v_reserved := public.batch_reserved_kg_unchecked(NEW.inventory_batch_id, v_now);

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
-- 6. Commercial audit — a SEPARATE log, and deliberately not the compliance one
--
-- A reservation is a COMMERCIAL event. compliance_audit_log's `action` CHECK is a
-- closed regulatory vocabulary, and forcing it open to admit commercial traffic
-- dilutes an evidentiary record whose whole value is that it was never opened:
-- an auditor reading it should find regulatory decisions and nothing else.
--
-- So this migration does NOT touch compliance_audit_log's constraint. It creates
-- commercial_audit_log with the identical shape, its own closed vocabulary and
-- its own anti-mutation trigger, per the marketplace target architecture §2.6
-- and gap item MC-18.
--
-- Note the asymmetry with migrations 39–42, which DID widen the compliance
-- vocabulary. That is correct and stays: an organisation verification, a licence
-- state change, a permit draw-down and an export-gate decision are all
-- regulatory facts. A stock reservation is not.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.commercial_audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  actor_type   text NOT NULL CHECK (actor_type IN ('admin', 'buyer', 'farmer', 'system')),
  actor_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Closed, and intended to stay that way. A commercial migration that adds an
  -- event type widens THIS list, never the compliance one.
  action       text NOT NULL CHECK (action IN (
                 'reservation_created', 'reservation_released')),

  entity_type  text NOT NULL,
  entity_id    text,
  before_state jsonb,
  after_state  jsonb,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commercial_audit_log_entity
  ON public.commercial_audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_commercial_audit_log_created_at
  ON public.commercial_audit_log (created_at DESC);

COMMENT ON TABLE public.commercial_audit_log IS
  'Append-only commercial event trail. Separate from compliance_audit_log by '
  'design (target architecture §2.6 / MC-18): mixing commercial events into the '
  'regulatory log would force its closed vocabulary open and dilute an '
  'evidentiary record.';

-- Modelled on prevent_compliance_audit_log_mutation() from migration 9.
CREATE OR REPLACE FUNCTION public.prevent_commercial_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'commercial_audit_log is append-only; attempted % is not allowed.', TG_OP;
END
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_commercial_audit_log_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prevent_commercial_audit_log_mutation() TO service_role;

-- A row-level trigger does not fire on TRUNCATE, and on hosted Supabase
-- service_role inherits TRUNCATE on new public tables — so without this a
-- single statement empties an "append-only" log. Statement-level guard,
-- modelled on migration 11. The reused function raises on TG_OP alone (no
-- NEW, no OLD), which is what makes it safe at statement level.
DROP TRIGGER IF EXISTS commercial_audit_log_no_truncate ON public.commercial_audit_log;
CREATE TRIGGER commercial_audit_log_no_truncate
  BEFORE TRUNCATE ON public.commercial_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_commercial_audit_log_mutation();

DROP TRIGGER IF EXISTS commercial_audit_log_no_update_delete ON public.commercial_audit_log;
CREATE TRIGGER commercial_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON public.commercial_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_commercial_audit_log_mutation();

ALTER TABLE public.commercial_audit_log ENABLE ROW LEVEL SECURITY;

-- Readable by DDP only: a commercial event names a buyer and a batch in the same
-- row, so it is a double-blind surface exactly like a reservation.
DROP POLICY IF EXISTS commercial_audit_log_admin_select ON public.commercial_audit_log;
CREATE POLICY commercial_audit_log_admin_select ON public.commercial_audit_log
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin());

REVOKE ALL ON public.commercial_audit_log FROM PUBLIC, anon, authenticated;
-- SELECT only. Rows arrive via the SECURITY DEFINER trigger below; no client
-- role may write the audit trail directly, and none may amend it.
GRANT SELECT ON public.commercial_audit_log TO authenticated, service_role;

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
  v_actor_type text;
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

  -- A buyer can create their own reservation, so the actor is genuinely not
  -- always an admin. Recording every commercial event as 'admin' would make the
  -- trail describe a broker acting where a customer acted.
  IF v_actor IS NULL THEN
    v_actor_type := 'system';
  ELSE
    SELECT CASE p.role WHEN 'ddp_admin' THEN 'admin'
                       WHEN 'buyer'     THEN 'buyer'
                       WHEN 'farmer'    THEN 'farmer'
                       ELSE 'system' END
      INTO v_actor_type
    FROM public.profiles p WHERE p.id = v_actor;
    v_actor_type := coalesce(v_actor_type, 'system');
  END IF;

  INSERT INTO public.commercial_audit_log
    (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (v_actor_type, v_actor, v_action, 'reservation', v_entity, NULL, v_row, v_reason);

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
REVOKE ALL ON public.reservations         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.reservation_releases FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON public.reservations         TO authenticated, service_role;
GRANT SELECT, INSERT ON public.reservation_releases TO authenticated, service_role;

COMMIT;
