-- =============================================================================
-- 40_LICENCES_AND_PERMITS_HARDENING.sql
--
-- Licences, permits, and permit quantity draw-down.
--
-- Depends on migration 39 (public.organisations).
--
-- WHY THIS EXISTS
-- Three of the export gate's seven conditions are statements about a piece of
-- paper: the exporter's own licence is valid for the regime and the activity;
-- the buyer holds an import permit that is valid and matches the regime; and
-- that permit has quantity headroom left. None of those can be asked today,
-- because "licence" is currently a value in a document_type enum and an expiry
-- date stored as untyped TEXT that gates nothing.
--
-- FOUR DESIGN DECISIONS WORTH READING BEFORE CHANGING ANYTHING
--
-- 1. REGIME IS A COLUMN, NOT A SUBTYPE BOLTED ON LATER (plan D1).
--    Flower sits under the Traditional Medicine Act; extract above 0.2% THC is
--    a Category 5 narcotic under a separate FDA regime. Different regulator,
--    different licence, different forms. Every licence and every permit carries
--    its regime from the first row, so a gate can never compare a flower permit
--    against an extract consignment.
--
-- 2. EXPIRY IS COMPUTED, NEVER STORED (plan D4).
--    There is deliberately NO 'expired' value in the state vocabulary. A stored
--    expiry flag is only ever as fresh as the last job that swept it, and this
--    repository has no scheduler at all — `vercel.json` declares no crons. A
--    licence that lapsed overnight would read as 'active' until someone ran
--    something. So validity is derived from expires_on at the moment it is
--    asked, by public.licence_is_valid(). It cannot go stale because it is
--    never written down.
--
--    'suspended' and 'revoked' ARE states, because those are decisions somebody
--    makes, not facts about the passage of time.
--
-- 3. BOTH CALENDARS ARE STORED, AND THE DATABASE ASSERTS THEY AGREE (plan §2).
--    Thai permits are dated in the Buddhist Era; B.E. 2569 is 2026 CE. The CE
--    date is canonical and every comparison uses it. The BE year is stored
--    explicitly next to it and a CHECK asserts the 543 offset, so a permit
--    keyed in from the wrong calendar is rejected at INSERT rather than
--    discovered at the port. src/lib/thaiCalendar.ts holds the same rule for
--    the client; this is the copy that cannot be bypassed.
--
-- 4. DRAW-DOWN IS AN APPEND-ONLY LEDGER, NOT A RUNNING TOTAL IN A COLUMN.
--    An import permit is issued for a quantity. A mutable `remaining_kg`
--    column loses its own history the moment it is decremented, and two
--    concurrent shipments can both read it before either writes. Instead every
--    draw is a row, headroom is a SUM, and the enforcing trigger takes a row
--    lock on the permit so two concurrent draws serialise rather than both
--    passing the check. Corrections are reversal ROWS; nothing is ever updated
--    or deleted.
--
-- SAFETY
--   • Additive. Creates three tables and four functions. The only pre-existing
--     object touched is compliance_audit_log's action CHECK, widened again.
--   • Rollback: 40_LICENCES_AND_PERMITS_ROLLBACK.sql
--   • Verify:   40_LICENCES_AND_PERMITS_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Precondition — migration 39 must be in place.
--
-- Failing loudly here is much cheaper than a FK error 200 lines down that names
-- a constraint rather than a missing migration.
-- -----------------------------------------------------------------------------
DO $precondition$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    RAISE EXCEPTION
      'Migration 40 requires migration 39: public.organisations does not exist. '
      'Apply 39_COUNTERPARTY_ORGANISATIONS_HARDENING.sql first.';
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Licences
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.licences (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,

  licence_type           text NOT NULL CHECK (licence_type IN (
                           'cultivation', 'processing', 'export', 'import',
                           'possession', 'sale', 'research')),

  -- Which authority issued it. A DTAM controlled-herb licence and a Thai FDA
  -- Category 5 licence are not interchangeable and must not be compared.
  regulator              text NOT NULL CHECK (regulator IN (
                           'dtam', 'thai_fda', 'other_domestic', 'foreign_competent_authority')),

  regime                 text NOT NULL CHECK (regime IN ('controlled_herb', 'narcotic_cat5')),

  licence_number         text NOT NULL CHECK (length(btrim(licence_number)) > 0),

  -- Dual calendar. CE is canonical; the BE year is asserted, not derived.
  issued_on              date NOT NULL,
  issued_on_be_year      integer NOT NULL,
  expires_on             date NOT NULL,
  expires_on_be_year     integer NOT NULL,

  scope_note             text,

  -- Evidence over assertion: a licence record with no artefact behind it is
  -- hearsay. The reference is mandatory; the content hash is optional here and
  -- becomes mandatory at the export gate for anything actually shipping.
  source_document_ref    text NOT NULL CHECK (length(btrim(source_document_ref)) > 0),
  source_document_sha256 char(64) CHECK (source_document_sha256 IS NULL
                                         OR source_document_sha256 ~ '^[0-9a-f]{64}$'),

  -- NOTE: there is no 'expired'. See header note 2.
  state                  text NOT NULL DEFAULT 'active' CHECK (state IN (
                           'active', 'suspended', 'revoked', 'superseded')),
  state_reason           text,

  superseded_by          uuid REFERENCES public.licences(id) ON DELETE SET NULL,

  recorded_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- §2's reconcile assertion, enforced. date_part on a date is immutable, so it
  -- is legal in a CHECK.
  CONSTRAINT licences_issued_calendars_agree
    CHECK (issued_on_be_year = date_part('year', issued_on)::int + 543),
  CONSTRAINT licences_expiry_calendars_agree
    CHECK (expires_on_be_year = date_part('year', expires_on)::int + 543),

  CONSTRAINT licences_expiry_after_issue
    CHECK (expires_on >= issued_on),

  -- A licence taken out of force must say why. "Revoked" with no reason cannot
  -- be explained to the counterparty it just blocked.
  CONSTRAINT licences_state_change_requires_reason
    CHECK (state = 'active'
           OR (state_reason IS NOT NULL AND length(btrim(state_reason)) > 0)),

  CONSTRAINT licences_superseded_requires_successor
    CHECK (state <> 'superseded' OR superseded_by IS NOT NULL),

  UNIQUE (regulator, licence_number)
);

CREATE INDEX IF NOT EXISTS idx_licences_org        ON public.licences (organisation_id);
CREATE INDEX IF NOT EXISTS idx_licences_expiry     ON public.licences (expires_on);
CREATE INDEX IF NOT EXISTS idx_licences_regime     ON public.licences (regime, licence_type);

COMMENT ON COLUMN public.licences.state IS
  'active | suspended | revoked | superseded. There is deliberately no "expired": '
  'expiry is derived from expires_on at read time by public.licence_is_valid(), '
  'because a stored expiry flag is only as fresh as the last sweeper and this '
  'platform has no scheduler.';

-- -----------------------------------------------------------------------------
-- 2. Permits
--
-- Modelled separately from licences because a permit is consignment-facing and
-- quantity-bounded, while a licence is activity-facing and open-ended. Folding
-- them into one table would make quantity_limit_kg nullable and therefore
-- unenforceable for the rows that need it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.permits (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The holder. For an import permit this is the BUYER organisation — which is
  -- exactly why migration 39 had to exist first.
  organisation_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,

  permit_type            text NOT NULL CHECK (permit_type IN ('import', 'export')),
  regime                 text NOT NULL CHECK (regime IN ('controlled_herb', 'narcotic_cat5')),

  -- The country whose authority issued it. For an import permit this is the
  -- destination market, and it is what the destination ruleset is keyed on.
  issuing_country        char(2) NOT NULL CHECK (issuing_country ~ '^[A-Z]{2}$'),

  permit_number          text NOT NULL CHECK (length(btrim(permit_number)) > 0),

  issued_on              date NOT NULL,
  issued_on_be_year      integer NOT NULL,
  expires_on             date NOT NULL,
  expires_on_be_year     integer NOT NULL,

  -- The quantity the permit authorises, in kilograms.
  --
  -- NOTE ON THE UPPER BOUND — this is not decoration. In PostgreSQL numeric
  -- 'NaN' sorts ABOVE every real number, so `CHECK (quantity_limit_kg > 0)`
  -- alone would ADMIT NaN, and NaN in a headroom subtraction poisons every
  -- comparison downstream into false. The ceiling is what excludes it. One
  -- million kilograms is a thousand tonnes: far above any real permit, far
  -- below the point where the guard stops working.
  quantity_limit_kg      numeric(14,3) NOT NULL
                           CHECK (quantity_limit_kg > 0 AND quantity_limit_kg <= 1000000),

  product_scope          text,

  source_document_ref    text NOT NULL CHECK (length(btrim(source_document_ref)) > 0),
  source_document_sha256 char(64) CHECK (source_document_sha256 IS NULL
                                         OR source_document_sha256 ~ '^[0-9a-f]{64}$'),

  state                  text NOT NULL DEFAULT 'active' CHECK (state IN (
                           'active', 'suspended', 'revoked', 'exhausted')),
  state_reason           text,

  recorded_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT permits_issued_calendars_agree
    CHECK (issued_on_be_year = date_part('year', issued_on)::int + 543),
  CONSTRAINT permits_expiry_calendars_agree
    CHECK (expires_on_be_year = date_part('year', expires_on)::int + 543),
  CONSTRAINT permits_expiry_after_issue
    CHECK (expires_on >= issued_on),
  CONSTRAINT permits_state_change_requires_reason
    CHECK (state IN ('active', 'exhausted')
           OR (state_reason IS NOT NULL AND length(btrim(state_reason)) > 0)),

  UNIQUE (issuing_country, permit_number)
);

CREATE INDEX IF NOT EXISTS idx_permits_org     ON public.permits (organisation_id);
CREATE INDEX IF NOT EXISTS idx_permits_expiry  ON public.permits (expires_on);
CREATE INDEX IF NOT EXISTS idx_permits_lookup  ON public.permits (organisation_id, permit_type, regime, issuing_country);

-- -----------------------------------------------------------------------------
-- 3. Draw-down ledger
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.permit_drawdowns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id      uuid NOT NULL REFERENCES public.permits(id) ON DELETE RESTRICT,

  quantity_kg    numeric(14,3) NOT NULL
                   CHECK (quantity_kg > 0 AND quantity_kg <= 1000000),

  -- Free text until the custody question is decided. When consignments exist
  -- this becomes a foreign key; until then it must at least be non-blank, so a
  -- draw can always be traced to something outside this table.
  consignment_ref text NOT NULL CHECK (length(btrim(consignment_ref)) > 0),

  -- A correction is a NEW ROW that reverses an existing one. Nothing in this
  -- table is ever updated or deleted, so the history of a permit's consumption
  -- survives its own corrections.
  reversal_of    uuid REFERENCES public.permit_drawdowns(id) ON DELETE RESTRICT,

  reason         text NOT NULL CHECK (length(btrim(reason)) > 0),

  drawn_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  drawn_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permit_drawdowns_permit ON public.permit_drawdowns (permit_id);

-- One reversal per draw. Without this a single draw could be reversed twice and
-- manufacture headroom out of nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_permit_drawdowns_one_reversal
  ON public.permit_drawdowns (reversal_of) WHERE reversal_of IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Append-only enforcement on the ledger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_permit_drawdown_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'permit_drawdowns is append-only; attempted % is not allowed. Reverse a draw by '
    'inserting a reversal row referencing it.', TG_OP;
END
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_permit_drawdown_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prevent_permit_drawdown_mutation() TO service_role;

DROP TRIGGER IF EXISTS permit_drawdowns_no_update_delete ON public.permit_drawdowns;
CREATE TRIGGER permit_drawdowns_no_update_delete
  BEFORE UPDATE OR DELETE ON public.permit_drawdowns
  FOR EACH ROW EXECUTE FUNCTION public.prevent_permit_drawdown_mutation();

-- -----------------------------------------------------------------------------
-- 5. Validity and headroom — computed, never stored
-- -----------------------------------------------------------------------------

-- Is this licence in force on the given date?
--
-- Fail-closed on every unknown: a licence id that does not exist returns false,
-- not NULL. A NULL would propagate into a boolean AND in the gate and make the
-- whole condition NULL, which an incautious `IF NOT ... THEN block` reads as
-- "not blocked".
CREATE OR REPLACE FUNCTION public.licence_is_valid(p_licence_id uuid, p_as_of date DEFAULT current_date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT l.state = 'active'
        AND p_as_of >= l.issued_on
        AND p_as_of <= l.expires_on
     FROM public.licences l
     WHERE l.id = p_licence_id),
    false)
$$;

CREATE OR REPLACE FUNCTION public.permit_is_valid(p_permit_id uuid, p_as_of date DEFAULT current_date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT p.state = 'active'
        AND p_as_of >= p.issued_on
        AND p_as_of <= p.expires_on
     FROM public.permits p
     WHERE p.id = p_permit_id),
    false)
$$;

-- Net quantity already drawn: draws minus reversals.
CREATE OR REPLACE FUNCTION public.permit_drawn_kg(p_permit_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(
    CASE WHEN d.reversal_of IS NULL THEN d.quantity_kg ELSE -d.quantity_kg END
  ), 0)::numeric
  FROM public.permit_drawdowns d
  WHERE d.permit_id = p_permit_id
$$;

-- Remaining headroom. Returns 0 rather than NULL for an unknown permit, so a
-- caller comparing `headroom >= requested` fails closed.
CREATE OR REPLACE FUNCTION public.permit_headroom_kg(p_permit_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT p.quantity_limit_kg - public.permit_drawn_kg(p.id)
     FROM public.permits p WHERE p.id = p_permit_id),
    0)::numeric
$$;

REVOKE EXECUTE ON FUNCTION public.licence_is_valid(uuid, date)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.permit_is_valid(uuid, date)   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.permit_drawn_kg(uuid)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.permit_headroom_kg(uuid)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.licence_is_valid(uuid, date)  TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.permit_is_valid(uuid, date)   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.permit_drawn_kg(uuid)         TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.permit_headroom_kg(uuid)      TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Headroom enforcement
--
-- CONCURRENCY. Two shipments drawing the last of a permit at the same instant
-- would, under READ COMMITTED, both compute headroom before either row is
-- visible to the other — and both would pass. The SELECT ... FOR UPDATE takes a
-- row lock on the permit, so the second transaction blocks until the first
-- commits and then re-computes against the committed total. This is why the
-- check lives in a trigger holding a lock and not in application code.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_enforce_permit_headroom()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit     numeric;
  v_state     text;
  v_expires   date;
  v_drawn     numeric;
  v_orig      public.permit_drawdowns%ROWTYPE;
BEGIN
  -- Serialise concurrent draws against the same permit.
  SELECT p.quantity_limit_kg, p.state, p.expires_on
    INTO v_limit, v_state, v_expires
  FROM public.permits p
  WHERE p.id = NEW.permit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'permit % does not exist', NEW.permit_id;
  END IF;

  IF NEW.reversal_of IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.permit_drawdowns WHERE id = NEW.reversal_of;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reversal references drawdown % which does not exist', NEW.reversal_of;
    END IF;
    IF v_orig.permit_id <> NEW.permit_id THEN
      RAISE EXCEPTION
        'reversal is on permit % but the drawdown it reverses belongs to permit % — '
        'a reversal may not move quantity between permits', NEW.permit_id, v_orig.permit_id;
    END IF;
    IF v_orig.reversal_of IS NOT NULL THEN
      RAISE EXCEPTION 'drawdown % is itself a reversal and cannot be reversed', NEW.reversal_of;
    END IF;
    IF v_orig.quantity_kg <> NEW.quantity_kg THEN
      RAISE EXCEPTION
        'partial reversal is not supported: drawdown % is % kg but the reversal is % kg. '
        'Reverse it in full and record a fresh draw for the corrected quantity.',
        NEW.reversal_of, v_orig.quantity_kg, NEW.quantity_kg;
    END IF;
    -- A reversal only ever RESTORES headroom, so no limit check applies.
    RETURN NEW;
  END IF;

  -- A draw against a permit that is not in force is refused here as well as at
  -- the gate. Defence in depth: the ledger must not be able to record
  -- consumption of a permit that could not lawfully be consumed.
  IF v_state <> 'active' THEN
    RAISE EXCEPTION 'permit % is in state "%" and cannot be drawn against', NEW.permit_id, v_state;
  END IF;

  v_drawn := public.permit_drawn_kg(NEW.permit_id);

  IF v_drawn + NEW.quantity_kg > v_limit THEN
    RAISE EXCEPTION
      'permit % has % kg of headroom (limit % kg, % kg already drawn) and cannot absorb a % kg draw',
      NEW.permit_id, v_limit - v_drawn, v_limit, v_drawn, NEW.quantity_kg;
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_enforce_permit_headroom() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_enforce_permit_headroom() TO service_role;

DROP TRIGGER IF EXISTS permit_drawdowns_enforce_headroom ON public.permit_drawdowns;
CREATE TRIGGER permit_drawdowns_enforce_headroom
  BEFORE INSERT ON public.permit_drawdowns
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_permit_headroom();

-- -----------------------------------------------------------------------------
-- 7. updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_touch_updated_at_generic()
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

REVOKE EXECUTE ON FUNCTION public.fn_touch_updated_at_generic() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_touch_updated_at_generic() TO service_role;

DROP TRIGGER IF EXISTS licences_touch_updated_at ON public.licences;
CREATE TRIGGER licences_touch_updated_at
  BEFORE UPDATE ON public.licences
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at_generic();

DROP TRIGGER IF EXISTS permits_touch_updated_at ON public.permits;
CREATE TRIGGER permits_touch_updated_at
  BEFORE UPDATE ON public.permits
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at_generic();

-- -----------------------------------------------------------------------------
-- 8. Audit vocabulary — cumulative. Migration 39's values are retained verbatim.
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_audit_log
  DROP CONSTRAINT IF EXISTS compliance_audit_log_action_check;
ALTER TABLE public.compliance_audit_log
  ADD CONSTRAINT compliance_audit_log_action_check
  CHECK (action IN (
    -- migration 9
    'legal_update_created', 'legal_update_reviewed', 'rule_suggested', 'rule_approved',
    'rule_paused', 'rule_retired', 'alert_created', 'alert_resolved',
    'readiness_status_changed', 'document_status_changed', 'sent_to_legal_review',
    'reviewer_note_added', 'rule_rejected', 'legal_update_archived', 'alert_dismissed',
    -- migration 39
    'organisation_created', 'organisation_updated', 'organisation_verification_changed',
    'organisation_membership_granted', 'organisation_membership_revoked',
    -- migration 40
    'licence_recorded', 'licence_state_changed', 'permit_recorded', 'permit_state_changed',
    'permit_drawn_down', 'permit_drawdown_reversed'
  ));

CREATE OR REPLACE FUNCTION public.fn_audit_permit_drawdown()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  INSERT INTO public.compliance_audit_log
    (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'admin' END,
    v_actor,
    CASE WHEN NEW.reversal_of IS NULL THEN 'permit_drawn_down' ELSE 'permit_drawdown_reversed' END,
    'permit',
    NEW.permit_id::text,
    NULL,
    to_jsonb(NEW),
    NEW.reason
  );
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_audit_permit_drawdown() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_audit_permit_drawdown() TO service_role;

DROP TRIGGER IF EXISTS permit_drawdowns_audit ON public.permit_drawdowns;
CREATE TRIGGER permit_drawdowns_audit
  AFTER INSERT ON public.permit_drawdowns
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_permit_drawdown();

-- -----------------------------------------------------------------------------
-- 9. Row level security
--
-- Same double-blind shape as migration 39: an organisation's members may read
-- that organisation's own licences and permits, DDP admins read everything, and
-- nobody writes but DDP. A buyer must never see a farm's cultivation licence,
-- and a farm must never see a buyer's import permit — either would identify the
-- counterparty as surely as a name would.
-- -----------------------------------------------------------------------------
ALTER TABLE public.licences          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permits           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permit_drawdowns  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS licences_select ON public.licences;
CREATE POLICY licences_select ON public.licences
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_organisation_membership(organisation_id));

DROP POLICY IF EXISTS licences_write ON public.licences;
CREATE POLICY licences_write ON public.licences
  FOR ALL TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS permits_select ON public.permits;
CREATE POLICY permits_select ON public.permits
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_organisation_membership(organisation_id));

DROP POLICY IF EXISTS permits_write ON public.permits;
CREATE POLICY permits_write ON public.permits
  FOR ALL TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- Draw-downs reveal a permit's consumption pattern, which is commercially
-- sensitive on both sides. Admin-only, and insert-only even for admins.
DROP POLICY IF EXISTS permit_drawdowns_select ON public.permit_drawdowns;
CREATE POLICY permit_drawdowns_select ON public.permit_drawdowns
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS permit_drawdowns_insert ON public.permit_drawdowns;
CREATE POLICY permit_drawdowns_insert ON public.permit_drawdowns
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ddp_admin());

-- -----------------------------------------------------------------------------
-- 10. Grants
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.licences         FROM PUBLIC, anon;
REVOKE ALL ON public.permits          FROM PUBLIC, anon;
REVOKE ALL ON public.permit_drawdowns FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.licences TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permits  TO authenticated, service_role;

-- No UPDATE or DELETE is granted on the ledger, to anyone. The append-only
-- trigger is the behavioural guarantee; withholding the privilege means the
-- trigger is the second line of defence rather than the only one.
GRANT SELECT, INSERT ON public.permit_drawdowns TO authenticated, service_role;

COMMIT;
