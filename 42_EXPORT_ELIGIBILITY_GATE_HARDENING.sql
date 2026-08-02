-- =============================================================================
-- 42_EXPORT_ELIGIBILITY_GATE_HARDENING.sql
--
-- The export gate: buyer eligibility, evaluated fail-closed, recorded, and
-- overridable only by a named human who gives a reason.
--
-- Depends on migrations 39 (organisations), 40 (licences/permits/draw-down)
-- and 41 (destination rulesets).
--
-- THIS IS THE REGULATORY HEART OF THE PLATFORM (plan §7.1)
-- A consignment may not leave until every one of seven conditions is true
-- against the ruleset in force ON THE SHIPMENT DATE. Today the platform's only
-- gate asks whether the SUPPLIER is documented. This asks whether the BUYER may
-- lawfully receive — which is a different question, and the one that keeps
-- product from entering a market that never authorised it.
--
-- THE SEVEN CONDITIONS
--   1. destination_ruleset_resolved   — a researched ruleset exists for this
--                                       market and regime on this date
--   2. buyer_verified                 — buyer organisation exists and is verified
--   3. buyer_import_permit_valid      — permit on file, in force, matching regime
--                                       and destination
--   4. permit_headroom_sufficient     — the permit can absorb this quantity
--   5. exporter_licence_valid         — the exporter's own export licence is in
--                                       force for this regime
--   6. batch_releasable               — the batch has an ACCEPTED COA with no
--                                       FAILED contaminant result
--   7. screening_clear                — denied-party screening is clear AND not
--                                       stale
--
-- FAIL CLOSED — WHAT THAT ACTUALLY MEANS HERE
-- Every condition starts false and can only be made true by affirmative
-- evidence. There is no branch anywhere in this function that turns an absent
-- record, a NULL, or an unresearched market into a pass. That is not a stylistic
-- preference: the three most likely production states early on are "no ruleset
-- researched yet", "screening never run" and "permit not captured", and all
-- three MUST block. An empty result is not permission.
--
-- WHY THE EVALUATION IS RECORDED EVEN WHEN IT PASSES
-- The evaluation row is the evidence that the gate ran and what it saw. A gate
-- that only records its refusals cannot later demonstrate that a shipment which
-- did leave was checked at all — which is precisely what an inspector asks.
-- Evaluations are append-only.
--
-- OVERRIDES
-- The gate is a hard stop. An override is a first-class row naming an approver
-- and carrying a reason, and it must name the SPECIFIC conditions it waives —
-- a blanket override is indistinguishable from switching the gate off. Overrides
-- surface on public.export_gate_overrides_pending_review until a second person
-- reviews them, because an override nobody reviews is just a slower failure.
--
--   • Rollback: 42_EXPORT_ELIGIBILITY_GATE_ROLLBACK.sql
--   • Verify:   42_EXPORT_ELIGIBILITY_GATE_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.organisations')        IS NULL THEN v_missing := array_append(v_missing, 'migration 39 (organisations)'); END IF;
  IF to_regclass('public.permits')              IS NULL THEN v_missing := array_append(v_missing, 'migration 40 (permits)');       END IF;
  IF to_regclass('public.destination_rulesets') IS NULL THEN v_missing := array_append(v_missing, 'migration 41 (destination_rulesets)'); END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 42 requires: %. Apply them first.', array_to_string(v_missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Denied-party screening records
--
-- This table is the RECORD of a screening, not an integration with a screening
-- provider. The provider is a commercial API and a procurement decision; what
-- the platform owns is the evidence that a check was run, by whom, against
-- which list, and when it goes stale.
--
-- valid_until is mandatory and is the point. A "clear" from two years ago is
-- not a clear — sanctions lists change weekly — and a screening record with no
-- expiry would let one stale check clear every future shipment.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.screening_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,

  provider           text NOT NULL CHECK (length(btrim(provider)) > 0),
  provider_reference text,

  result             text NOT NULL CHECK (result IN (
                       'clear', 'potential_match', 'confirmed_match', 'error')),

  screened_at        timestamptz NOT NULL DEFAULT now(),
  valid_until        date NOT NULL,

  screened_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Where the screening report itself is kept.
  evidence_ref       text NOT NULL CHECK (length(btrim(evidence_ref)) > 0),
  notes              text,

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- A match that has been reviewed and cleared must say so in writing. Without
  -- this, "potential_match" with an empty notes field is an unanswered question
  -- that somebody will eventually wave through.
  CONSTRAINT screening_checks_match_requires_notes
    CHECK (result NOT IN ('potential_match', 'confirmed_match')
           OR (notes IS NOT NULL AND length(btrim(notes)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_screening_checks_org
  ON public.screening_checks (organisation_id, valid_until DESC);

-- -----------------------------------------------------------------------------
-- 2. Evaluations — append-only
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.export_eligibility_evaluations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Free text until the custody decision produces a consignment entity.
  consignment_ref           text NOT NULL CHECK (length(btrim(consignment_ref)) > 0),

  buyer_organisation_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
  exporter_organisation_id  uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,

  -- The batch being shipped, where one is named. Nullable because a dry-run
  -- evaluation before a batch is allocated is legitimate and useful.
  inventory_batch_id        uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,

  regime                    text NOT NULL CHECK (regime IN ('controlled_herb', 'narcotic_cat5')),
  destination_country       char(2) NOT NULL CHECK (destination_country ~ '^[A-Z]{2}$'),

  quantity_kg               numeric(14,3) NOT NULL
                              CHECK (quantity_kg > 0 AND quantity_kg <= 1000000),

  -- The date the ruleset was resolved FOR. Recorded separately from
  -- evaluated_at, because re-evaluating a March shipment today must resolve
  -- March's ruleset, and the record has to show which date was used.
  evaluated_as_of           date NOT NULL,
  evaluated_at              timestamptz NOT NULL DEFAULT now(),
  evaluated_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  outcome                   text NOT NULL CHECK (outcome IN ('pass', 'blocked')),

  -- Per-condition results, so a refusal can be explained condition by condition
  -- rather than as an opaque "not eligible".
  conditions                jsonb NOT NULL,
  blocking_reasons          text[] NOT NULL DEFAULT ARRAY[]::text[],

  ruleset_id                uuid REFERENCES public.destination_rulesets(id) ON DELETE SET NULL,
  permit_id                 uuid REFERENCES public.permits(id) ON DELETE SET NULL,

  -- An outcome of 'blocked' with no reasons, or 'pass' with reasons, would mean
  -- the recorded verdict and the recorded evidence disagree.
  --
  -- Both halves are coalesced for the reason given on
  -- export_gate_overrides.conditions_overridden below: array_length() of an
  -- empty array is NULL, and a NULL CHECK passes. Without the coalesce, a
  -- 'blocked' verdict with an EMPTY reasons array — a gate that refused and
  -- could not say why — would slip straight through this constraint.
  CONSTRAINT evaluations_outcome_matches_reasons
    CHECK ((outcome = 'blocked' AND coalesce(array_length(blocking_reasons, 1), 0) >= 1)
           OR (outcome = 'pass'    AND coalesce(array_length(blocking_reasons, 1), 0) = 0))
);

CREATE INDEX IF NOT EXISTS idx_evaluations_consignment
  ON public.export_eligibility_evaluations (consignment_ref, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_buyer
  ON public.export_eligibility_evaluations (buyer_organisation_id, evaluated_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_evaluation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'export_eligibility_evaluations is append-only; attempted % is not allowed. '
    'Re-evaluate to produce a new record — never edit the record of what the gate saw.', TG_OP;
END
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_evaluation_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prevent_evaluation_mutation() TO service_role;

DROP TRIGGER IF EXISTS export_eligibility_evaluations_no_update_delete ON public.export_eligibility_evaluations;
CREATE TRIGGER export_eligibility_evaluations_no_update_delete
  BEFORE UPDATE OR DELETE ON public.export_eligibility_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_mutation();

-- -----------------------------------------------------------------------------
-- 3. Overrides — append-only, except for the review stamp
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.export_gate_overrides (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id          uuid NOT NULL REFERENCES public.export_eligibility_evaluations(id) ON DELETE RESTRICT,

  -- The named human. NOT NULL, no default, no "system" path: nothing may
  -- override the export gate without a person's identity attached.
  approved_by            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,

  -- A reason short enough to be meaningless is not a reason. Twenty characters
  -- will not stop a determined shrug, but it does stop "ok" and "approved".
  reason                 text NOT NULL CHECK (length(btrim(reason)) >= 20),

  -- WHICH conditions are waived. A blanket override is indistinguishable from
  -- turning the gate off, so the specific conditions must be named and at least
  -- one must be listed.
  --
  -- NOTE THE coalesce, WHICH IS NOT DECORATION. array_length() on an EMPTY
  -- array returns NULL, not 0 — and a CHECK constraint only rejects FALSE, never
  -- NULL. So `CHECK (array_length(x, 1) >= 1)` evaluates to NULL for the exact
  -- input it exists to reject, and admits it. This is the same class of hole as
  -- the NaN comparisons in migration 40: a guard that reads correctly and does
  -- nothing.
  conditions_overridden  text[] NOT NULL
                           CHECK (coalesce(array_length(conditions_overridden, 1), 0) >= 1),

  approved_at            timestamptz NOT NULL DEFAULT now(),

  -- The standing exceptions report. An override nobody reviews is just a slower
  -- failure, so these stay visible until a SECOND person signs them off.
  reviewed_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at            timestamptz,
  review_note            text,

  CONSTRAINT overrides_review_is_complete
    CHECK ((reviewed_by IS NULL AND reviewed_at IS NULL)
           OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),

  -- Self-review defeats the purpose.
  CONSTRAINT overrides_reviewer_is_not_approver
    CHECK (reviewed_by IS NULL OR reviewed_by <> approved_by)
);

CREATE INDEX IF NOT EXISTS idx_overrides_unreviewed
  ON public.export_gate_overrides (approved_at DESC) WHERE reviewed_at IS NULL;

-- The override record itself is immutable; only the review stamp may be filled
-- in, and only once. Anything else is an attempt to rewrite why a hard stop was
-- bypassed.
CREATE OR REPLACE FUNCTION public.fn_guard_override_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'export_gate_overrides is append-only; an override may not be deleted.';
  END IF;

  IF NEW.evaluation_id         IS DISTINCT FROM OLD.evaluation_id
     OR NEW.approved_by        IS DISTINCT FROM OLD.approved_by
     OR NEW.reason             IS DISTINCT FROM OLD.reason
     OR NEW.conditions_overridden IS DISTINCT FROM OLD.conditions_overridden
     OR NEW.approved_at        IS DISTINCT FROM OLD.approved_at
  THEN
    RAISE EXCEPTION
      'an export gate override is immutable: the approver, the reason, the waived conditions '
      'and the approval time may never be changed. Only the review stamp may be filled in.';
  END IF;

  IF OLD.reviewed_at IS NOT NULL AND NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    RAISE EXCEPTION 'this override has already been reviewed; the review stamp may not be rewritten.';
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_guard_override_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_guard_override_mutation() TO service_role;

DROP TRIGGER IF EXISTS export_gate_overrides_guard ON public.export_gate_overrides;
CREATE TRIGGER export_gate_overrides_guard
  BEFORE UPDATE OR DELETE ON public.export_gate_overrides
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_override_mutation();

-- The standing exceptions report.
CREATE OR REPLACE VIEW public.export_gate_overrides_pending_review AS
  SELECT o.id, o.evaluation_id, o.approved_by, o.approved_at, o.reason,
         o.conditions_overridden,
         e.consignment_ref, e.destination_country, e.regime, e.quantity_kg,
         e.blocking_reasons
  FROM public.export_gate_overrides o
  JOIN public.export_eligibility_evaluations e ON e.id = o.evaluation_id
  WHERE o.reviewed_at IS NULL;

-- -----------------------------------------------------------------------------
-- 4. Screening freshness
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.screening_is_clear(p_organisation_id uuid, p_as_of date DEFAULT current_date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- COALESCE to false: an organisation that has NEVER been screened is not
  -- clear. There is no third state at a gate.
  --
  -- THE TIE-BREAK IS FAIL-CLOSED, AND IT IS LOAD-BEARING.
  -- "Most recent screening wins" is the right rule, but screened_at defaults to
  -- now(), which is TRANSACTION time — so two screenings recorded in the same
  -- transaction carry an identical timestamp and `ORDER BY screened_at DESC`
  -- alone leaves the winner to the planner. A confirmed denied-party match
  -- could then lose a coin flip to an older clear, silently.
  --
  -- Ordering non-clear results first among equal timestamps makes the ambiguous
  -- case block rather than pass. `(result = 'clear') ASC` puts false before
  -- true; the id is a final deterministic tiebreak so the same question always
  -- gets the same answer.
  SELECT COALESCE(
    (SELECT s.result = 'clear'
     FROM public.screening_checks s
     WHERE s.organisation_id = p_organisation_id
       AND s.valid_until >= p_as_of
       AND s.screened_at::date <= p_as_of
     ORDER BY s.screened_at DESC, (s.result = 'clear') ASC, s.id
     LIMIT 1),
    false)
$$;

REVOKE EXECUTE ON FUNCTION public.screening_is_clear(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.screening_is_clear(uuid, date) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. The gate
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_export_eligibility(
  p_consignment_ref          text,
  p_buyer_organisation_id    uuid,
  p_exporter_organisation_id uuid,
  p_regime                   text,
  p_destination_country      char(2),
  p_quantity_kg              numeric,
  p_inventory_batch_id       uuid DEFAULT NULL,
  p_as_of                    date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_conditions   jsonb := '{}'::jsonb;
  v_reasons      text[] := ARRAY[]::text[];
  v_ruleset      public.destination_rulesets%ROWTYPE;
  v_buyer        public.organisations%ROWTYPE;
  v_exporter     public.organisations%ROWTYPE;
  v_permit       public.permits%ROWTYPE;
  v_licence_ok   boolean := false;
  v_headroom     numeric := 0;
  v_batch_ok     boolean := false;
  v_outcome      text;
  v_eval_id      uuid;
  v_detail       text;
BEGIN
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'evaluate_export_eligibility: ddp_admin role required';
  END IF;

  IF p_quantity_kg IS NULL OR NOT (p_quantity_kg > 0 AND p_quantity_kg <= 1000000) THEN
    -- Catches NULL, NaN and Infinity in one test: NaN fails the upper bound and
    -- Infinity fails it too. A quantity that cannot be compared cannot be
    -- checked against headroom, so it cannot be allowed to reach the ledger.
    RAISE EXCEPTION 'evaluate_export_eligibility: quantity_kg must be a real number in (0, 1000000]; got %', p_quantity_kg;
  END IF;

  -- ── 1. Destination ruleset ───────────────────────────────────────────────
  SELECT * INTO v_ruleset
  FROM public.destination_ruleset_in_force(p_destination_country, p_regime, p_as_of);

  IF v_ruleset.id IS NULL THEN
    v_reasons := array_append(v_reasons,
      format('No researched ruleset for %s/%s on %s. An unresearched market is not an open market.',
             p_destination_country, p_regime, p_as_of));
    v_conditions := v_conditions || jsonb_build_object('destination_ruleset_resolved',
      jsonb_build_object('pass', false, 'detail', 'no ruleset in force on the evaluation date'));
  ELSE
    v_conditions := v_conditions || jsonb_build_object('destination_ruleset_resolved',
      jsonb_build_object('pass', true, 'detail', format('ruleset version %s', v_ruleset.version),
                         'ruleset_id', v_ruleset.id));
  END IF;

  -- ── 2. Buyer verified ────────────────────────────────────────────────────
  SELECT * INTO v_buyer FROM public.organisations WHERE id = p_buyer_organisation_id;

  IF v_buyer.id IS NULL THEN
    v_detail := 'buyer organisation does not exist';
  ELSIF v_buyer.org_type <> 'buyer' THEN
    v_detail := format('organisation is of type %s, not a buyer', v_buyer.org_type);
  ELSIF v_buyer.verification_state <> 'verified' THEN
    v_detail := format('buyer verification state is %s', v_buyer.verification_state);
  ELSE
    v_detail := NULL;
  END IF;

  IF v_detail IS NOT NULL THEN
    v_reasons := array_append(v_reasons, 'Buyer not verified: ' || v_detail);
    v_conditions := v_conditions || jsonb_build_object('buyer_verified',
      jsonb_build_object('pass', false, 'detail', v_detail));
  ELSE
    v_conditions := v_conditions || jsonb_build_object('buyer_verified',
      jsonb_build_object('pass', true, 'detail', 'verified with a named verifier'));
  END IF;

  -- ── 3. Buyer import permit ───────────────────────────────────────────────
  -- Matched on holder, type, regime AND issuing country. Matching on holder
  -- alone would let a German permit clear a shipment to Australia.
  SELECT * INTO v_permit
  FROM public.permits p
  WHERE p.organisation_id = p_buyer_organisation_id
    AND p.permit_type = 'import'
    AND p.regime = p_regime
    AND p.issuing_country = p_destination_country
    AND public.permit_is_valid(p.id, p_as_of)
  ORDER BY p.expires_on DESC
  LIMIT 1;

  IF v_ruleset.id IS NOT NULL AND v_ruleset.requires_import_permit = false THEN
    v_conditions := v_conditions || jsonb_build_object('buyer_import_permit_valid',
      jsonb_build_object('pass', true, 'detail', 'ruleset records that this market requires no import permit'));
  ELSIF v_permit.id IS NULL THEN
    v_reasons := array_append(v_reasons,
      format('No valid %s import permit on file for this buyer in regime %s on %s.',
             p_destination_country, p_regime, p_as_of));
    v_conditions := v_conditions || jsonb_build_object('buyer_import_permit_valid',
      jsonb_build_object('pass', false, 'detail', 'no in-force permit matching holder, type, regime and destination'));
  ELSE
    v_conditions := v_conditions || jsonb_build_object('buyer_import_permit_valid',
      jsonb_build_object('pass', true, 'detail', format('permit %s valid to %s', v_permit.permit_number, v_permit.expires_on),
                         'permit_id', v_permit.id));
  END IF;

  -- ── 4. Permit headroom ───────────────────────────────────────────────────
  IF v_ruleset.id IS NOT NULL AND v_ruleset.requires_import_permit = false THEN
    v_conditions := v_conditions || jsonb_build_object('permit_headroom_sufficient',
      jsonb_build_object('pass', true, 'detail', 'no permit required, so no quantity ceiling applies'));
  ELSIF v_permit.id IS NULL THEN
    -- No permit means no headroom. Reported as its own failed condition rather
    -- than silently inheriting condition 3's failure, so the refusal explains
    -- both things that are wrong.
    v_reasons := array_append(v_reasons, 'Permit headroom cannot be established without a valid permit.');
    v_conditions := v_conditions || jsonb_build_object('permit_headroom_sufficient',
      jsonb_build_object('pass', false, 'detail', 'no permit to draw against'));
  ELSE
    v_headroom := public.permit_headroom_kg(v_permit.id);
    IF v_headroom >= p_quantity_kg THEN
      v_conditions := v_conditions || jsonb_build_object('permit_headroom_sufficient',
        jsonb_build_object('pass', true, 'detail', format('%s kg headroom for a %s kg consignment', v_headroom, p_quantity_kg)));
    ELSE
      v_reasons := array_append(v_reasons,
        format('Permit %s has %s kg headroom, short of the %s kg consignment.',
               v_permit.permit_number, v_headroom, p_quantity_kg));
      v_conditions := v_conditions || jsonb_build_object('permit_headroom_sufficient',
        jsonb_build_object('pass', false, 'detail', format('%s kg available, %s kg required', v_headroom, p_quantity_kg)));
    END IF;
  END IF;

  -- ── 5. Exporter licence ──────────────────────────────────────────────────
  SELECT * INTO v_exporter FROM public.organisations WHERE id = p_exporter_organisation_id;

  SELECT EXISTS (
    SELECT 1 FROM public.licences l
    WHERE l.organisation_id = p_exporter_organisation_id
      AND l.licence_type = 'export'
      AND l.regime = p_regime
      AND public.licence_is_valid(l.id, p_as_of)
  ) INTO v_licence_ok;

  IF v_licence_ok THEN
    v_conditions := v_conditions || jsonb_build_object('exporter_licence_valid',
      jsonb_build_object('pass', true, 'detail', format('export licence in force for regime %s', p_regime)));
  ELSE
    v_reasons := array_append(v_reasons,
      format('Exporter holds no export licence in force for regime %s on %s.', p_regime, p_as_of));
    v_conditions := v_conditions || jsonb_build_object('exporter_licence_valid',
      jsonb_build_object('pass', false, 'detail', 'no in-force export licence for this regime'));
  END IF;

  -- ── 6. Batch releasable ──────────────────────────────────────────────────
  -- A COA that has been ACCEPTED by a reviewer, with no contaminant result
  -- recorded as 'fail'. A batch with no COA at all fails, as does one whose COA
  -- is still pending review — an uploaded document is not a passed test.
  IF p_inventory_batch_id IS NULL THEN
    v_reasons := array_append(v_reasons, 'No batch named; batch releasability cannot be established.');
    v_conditions := v_conditions || jsonb_build_object('batch_releasable',
      jsonb_build_object('pass', false, 'detail', 'no inventory batch supplied'));
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.farmer_documents d
      WHERE d.inventory_batch_id = p_inventory_batch_id
        AND d.document_type = 'coa'
        AND d.review_status = 'accepted'
        AND coalesce(d.heavy_metals_status, 'not_tested') <> 'fail'
        AND coalesce(d.pesticides_status,   'not_tested') <> 'fail'
        AND coalesce(d.microbial_status,    'not_tested') <> 'fail'
        AND coalesce(d.mycotoxins_status,   'not_tested') <> 'fail'
    ) INTO v_batch_ok;

    -- A FAILED contaminant result anywhere on the batch blocks it, even if some
    -- other COA on the same batch is clean. Two COAs disagreeing is a reason to
    -- stop, not a reason to pick the favourable one.
    IF v_batch_ok AND EXISTS (
      SELECT 1 FROM public.farmer_documents d
      WHERE d.inventory_batch_id = p_inventory_batch_id
        AND d.document_type = 'coa'
        AND 'fail' IN (d.heavy_metals_status, d.pesticides_status,
                       d.microbial_status, d.mycotoxins_status)
    ) THEN
      v_batch_ok := false;
      v_detail := 'a COA on this batch records a FAILED contaminant result';
    ELSIF NOT v_batch_ok THEN
      v_detail := 'no accepted COA free of failed contaminant results';
    ELSE
      v_detail := 'accepted COA with no failed contaminant result';
    END IF;

    IF v_batch_ok THEN
      v_conditions := v_conditions || jsonb_build_object('batch_releasable',
        jsonb_build_object('pass', true, 'detail', v_detail));
    ELSE
      v_reasons := array_append(v_reasons, 'Batch not releasable: ' || v_detail);
      v_conditions := v_conditions || jsonb_build_object('batch_releasable',
        jsonb_build_object('pass', false, 'detail', v_detail));
    END IF;
  END IF;

  -- ── 7. Screening ─────────────────────────────────────────────────────────
  IF public.screening_is_clear(p_buyer_organisation_id, p_as_of) THEN
    v_conditions := v_conditions || jsonb_build_object('screening_clear',
      jsonb_build_object('pass', true, 'detail', 'current denied-party screening is clear'));
  ELSE
    v_reasons := array_append(v_reasons,
      'Denied-party screening for the buyer is absent, stale or not clear.');
    v_conditions := v_conditions || jsonb_build_object('screening_clear',
      jsonb_build_object('pass', false, 'detail', 'no in-date clear screening on file'));
  END IF;

  -- ── Verdict ──────────────────────────────────────────────────────────────
  v_outcome := CASE WHEN coalesce(array_length(v_reasons, 1), 0) = 0 THEN 'pass' ELSE 'blocked' END;

  INSERT INTO public.export_eligibility_evaluations
    (consignment_ref, buyer_organisation_id, exporter_organisation_id, inventory_batch_id,
     regime, destination_country, quantity_kg, evaluated_as_of, evaluated_by,
     outcome, conditions, blocking_reasons, ruleset_id, permit_id)
  VALUES
    (p_consignment_ref, p_buyer_organisation_id, p_exporter_organisation_id, p_inventory_batch_id,
     p_regime, p_destination_country, p_quantity_kg, p_as_of, v_actor,
     v_outcome, v_conditions, v_reasons, v_ruleset.id, v_permit.id)
  RETURNING id INTO v_eval_id;

  INSERT INTO public.compliance_audit_log
    (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'admin' END,
    v_actor, 'export_eligibility_evaluated', 'export_evaluation', v_eval_id::text,
    NULL, v_conditions,
    CASE WHEN v_outcome = 'blocked' THEN array_to_string(v_reasons, ' | ') ELSE NULL END);

  RETURN jsonb_build_object(
    'evaluation_id',    v_eval_id,
    'outcome',          v_outcome,
    'evaluated_as_of',  p_as_of,
    'conditions',       v_conditions,
    'blocking_reasons', to_jsonb(v_reasons));
END
$$;

REVOKE EXECUTE ON FUNCTION public.evaluate_export_eligibility(text, uuid, uuid, text, char, numeric, uuid, date)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.evaluate_export_eligibility(text, uuid, uuid, text, char, numeric, uuid, date)
  TO authenticated, service_role;

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
    'screening_recorded'
  ));

-- -----------------------------------------------------------------------------
-- 7. Row level security
--
-- All three tables are DDP-internal. An evaluation names both the buyer and the
-- exporter in the same row, so exposing it to either side would breach the
-- double-blind rule in the most direct way possible.
-- -----------------------------------------------------------------------------
ALTER TABLE public.screening_checks                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_eligibility_evaluations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_gate_overrides           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS screening_checks_admin ON public.screening_checks;
CREATE POLICY screening_checks_admin ON public.screening_checks
  FOR ALL TO authenticated
  USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS evaluations_admin_select ON public.export_eligibility_evaluations;
CREATE POLICY evaluations_admin_select ON public.export_eligibility_evaluations
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS evaluations_admin_insert ON public.export_eligibility_evaluations;
CREATE POLICY evaluations_admin_insert ON public.export_eligibility_evaluations
  FOR INSERT TO authenticated
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS overrides_admin ON public.export_gate_overrides;
CREATE POLICY overrides_admin ON public.export_gate_overrides
  FOR ALL TO authenticated
  USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.screening_checks               FROM PUBLIC, anon;
REVOKE ALL ON public.export_eligibility_evaluations FROM PUBLIC, anon;
REVOKE ALL ON public.export_gate_overrides          FROM PUBLIC, anon;
REVOKE ALL ON public.export_gate_overrides_pending_review FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.screening_checks TO authenticated, service_role;
-- Insert-only on the evaluation log; the trigger blocks the rest, and the
-- privilege is withheld so the trigger is not the only line of defence.
GRANT SELECT, INSERT ON public.export_eligibility_evaluations TO authenticated, service_role;
-- UPDATE is granted so a reviewer can stamp an override; the guard trigger
-- restricts that to the review columns only.
GRANT SELECT, INSERT, UPDATE ON public.export_gate_overrides TO authenticated, service_role;
GRANT SELECT ON public.export_gate_overrides_pending_review TO authenticated, service_role;

COMMIT;
