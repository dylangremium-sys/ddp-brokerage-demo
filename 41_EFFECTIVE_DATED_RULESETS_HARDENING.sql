-- =============================================================================
-- 41_EFFECTIVE_DATED_RULESETS_HARDENING.sql
--
-- Rules as versioned, effective-dated data (plan §3 and D6).
--
-- Depends on migration 9 (public.compliance_rules).
--
-- THE PROBLEM THIS SOLVES
-- public.compliance_rules already has a jurisdiction, a severity, an is_blocking
-- flag and a full approval lifecycle. What it has no concept of is TIME. A rule
-- is either active or it is not, right now — so the platform can answer "is this
-- shipment compliant today?" but cannot answer "was this shipment compliant when
-- it left?", which is the only question anyone asks after the fact.
--
-- Thai cannabis regulation changed materially three times in four years. Two
-- ministerial regulations took effect in April 2026. A consignment that shipped
-- in March 2026 must be judged against March's rules, and if the platform
-- re-evaluates it against today's it will manufacture violations that never
-- happened — or, worse, clear ones that did.
--
-- WHAT IT ADDS
--   1. compliance_rules.effective_from / effective_to, backfilled.
--   2. public.destination_rulesets — per destination market and regime, the
--      requirements that a consignment must satisfy, versioned and dated.
--   3. public.compliance_rules_in_force(date) and
--      public.destination_ruleset_in_force(country, regime, date) — the only
--      supported way to ask what applied on a given day.
--
-- THE BACKFILL IS AN ASSUMPTION, AND IT IS RECORDED AS ONE
-- Existing rules get effective_from = created_at::date, i.e. "this rule applied
-- from the day it was entered". That is true for a rule captured as it was
-- published and FALSE for one transcribed later from an older instrument — for
-- those the real effective date is earlier than the row's creation date, and the
-- platform will under-apply the rule to historic shipments. Every backfilled row
-- is marked with effective_from_is_estimated = true so the wrong ones can be
-- found and corrected rather than silently trusted. New rows default to false.
--
-- NO OVERLAPPING RULESETS, ENFORCED TWO WAYS
-- Two destination rulesets for the same market and regime covering the same day
-- would make "the ruleset in force" ambiguous, and an ambiguous gate is a gate
-- that returns whichever row the planner happened to pick. Prevented by:
--   • a partial UNIQUE index allowing at most one OPEN-ENDED ruleset per
--     (country, regime) — race-free, because it is an index; and
--   • a trigger rejecting any overlap among closed ranges — which is NOT
--     race-free on its own and is documented as such below.
--
--   • Rollback: 41_EFFECTIVE_DATED_RULESETS_ROLLBACK.sql
--   • Verify:   41_EFFECTIVE_DATED_RULESETS_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.compliance_rules') IS NULL THEN
    RAISE EXCEPTION
      'Migration 41 requires migration 9: public.compliance_rules does not exist.';
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Effective dating on compliance_rules
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_rules
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS effective_from_is_estimated boolean NOT NULL DEFAULT false;

-- Backfill, then tighten. Doing it in this order means the NOT NULL can be
-- added without a table rewrite failing on pre-existing rows.
UPDATE public.compliance_rules
   SET effective_from = created_at::date,
       effective_from_is_estimated = true
 WHERE effective_from IS NULL;

ALTER TABLE public.compliance_rules
  ALTER COLUMN effective_from SET NOT NULL,
  ALTER COLUMN effective_from SET DEFAULT current_date;

ALTER TABLE public.compliance_rules
  DROP CONSTRAINT IF EXISTS compliance_rules_effective_range_valid;
ALTER TABLE public.compliance_rules
  ADD CONSTRAINT compliance_rules_effective_range_valid
  CHECK (effective_to IS NULL OR effective_to > effective_from);

COMMENT ON COLUMN public.compliance_rules.effective_from_is_estimated IS
  'TRUE means effective_from was inferred by migration 41 from created_at, not '
  'read off the legal instrument. Estimated dates under-apply a rule to historic '
  'shipments when the rule was transcribed later than it took effect. Correct '
  'these against the source and set the flag false.';

-- -----------------------------------------------------------------------------
-- 2. Destination rulesets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.destination_rulesets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  country_code           char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  regime                 text NOT NULL CHECK (regime IN ('controlled_herb', 'narcotic_cat5')),

  version                integer NOT NULL CHECK (version >= 1),

  effective_from         date NOT NULL,
  -- NULL means "still in force". Exactly one such row may exist per
  -- (country, regime) — see the partial unique index below.
  effective_to           date,

  -- Does this market require the buyer to hold an import permit? Defaults TRUE
  -- because assuming a permit is NOT required is the failure that ships product
  -- into a market that needed one.
  requires_import_permit boolean NOT NULL DEFAULT true,

  -- Analytes the COA must cover for this market. An empty array means "no
  -- analyte requirement recorded", which the gate treats as unresolved rather
  -- than as satisfied.
  required_analytes      text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Market THC ceiling as a percentage, where one applies.
  -- The upper bound is not decoration: numeric NaN sorts above every real
  -- number, so a lower-bound-only CHECK would admit it and poison every
  -- comparison against it into false.
  max_thc_pct            numeric(6,3) CHECK (max_thc_pct IS NULL
                                             OR (max_thc_pct >= 0 AND max_thc_pct <= 100)),

  -- The legal instrument this encodes. A ruleset with no citation cannot be
  -- reviewed by counsel, and counsel is the only party who can confirm it.
  source_reference       text NOT NULL CHECK (length(btrim(source_reference)) > 0),
  notes                  text,

  recorded_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT destination_rulesets_range_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),

  UNIQUE (country_code, regime, version)
);

CREATE INDEX IF NOT EXISTS idx_destination_rulesets_lookup
  ON public.destination_rulesets (country_code, regime, effective_from DESC);

-- At most one open-ended ruleset per market and regime. This is an INDEX, so it
-- holds under concurrency; two sessions cannot both insert a current ruleset.
CREATE UNIQUE INDEX IF NOT EXISTS uq_destination_rulesets_one_current
  ON public.destination_rulesets (country_code, regime)
  WHERE effective_to IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Overlap rejection for closed ranges
--
-- HONEST LIMITATION. Unlike the index above, this trigger is NOT race-free: two
-- concurrent inserts of overlapping CLOSED ranges can each fail to see the
-- other. Closing that properly needs an EXCLUDE constraint over a daterange,
-- which needs the btree_gist extension — a Supabase extension-management step
-- that has to be decided and applied deliberately rather than smuggled into a
-- migration. Historic ruleset edits are rare, manual and admin-only, so the
-- residual risk is small and stated here rather than hidden. If ruleset editing
-- ever becomes automated, replace this with an EXCLUDE constraint.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_reject_overlapping_destination_ruleset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conflict uuid;
BEGIN
  SELECT r.id INTO v_conflict
  FROM public.destination_rulesets r
  WHERE r.country_code = NEW.country_code
    AND r.regime = NEW.regime
    AND r.id IS DISTINCT FROM NEW.id
    AND daterange(r.effective_from, r.effective_to, '[)')
        && daterange(NEW.effective_from, NEW.effective_to, '[)')
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'destination ruleset for %/% overlaps existing ruleset %. Close the earlier ruleset '
      '(set its effective_to) before opening a new one — two rulesets covering the same day '
      'make "the ruleset in force" ambiguous.',
      NEW.country_code, NEW.regime, v_conflict;
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_reject_overlapping_destination_ruleset() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_reject_overlapping_destination_ruleset() TO service_role;

DROP TRIGGER IF EXISTS destination_rulesets_no_overlap ON public.destination_rulesets;
CREATE TRIGGER destination_rulesets_no_overlap
  BEFORE INSERT OR UPDATE ON public.destination_rulesets
  FOR EACH ROW EXECUTE FUNCTION public.fn_reject_overlapping_destination_ruleset();

-- -----------------------------------------------------------------------------
-- 4. Point-in-time resolution
--
-- These are the ONLY supported way to ask what applied on a given day. Querying
-- the tables directly and filtering by status alone reintroduces exactly the
-- present-tense bug this migration exists to remove.
-- -----------------------------------------------------------------------------
-- WHICH QUESTION IS THIS? "What applied on <date>?" — a HISTORICAL question.
--
-- `status` is present-tense state; the effective window is the historical fact.
-- Mixing them silently rewrites the past: filtering on `status = 'active'` means
-- that the moment a rule is paused or retired it vanishes from every historical
-- query too, and a shipment that left in March would be re-judged as though
-- March's rule had never existed. That defeats the entire point of this
-- migration, so the two are separated here.
--
-- Statuses that mean the rule NEVER reached force ('draft', 'suggested',
-- 'approved' — approved but never activated — and 'rejected') are excluded, and
-- must be, or a rule that was only ever a proposal would be applied to history.
-- The three that mean it DID reach force ('active', 'paused', 'retired') are
-- all admitted, because a rule that was in force in March was in force in March
-- whatever has happened to it since.
--
-- CONSEQUENCE FOR OPERATORS: to stop a rule applying from a given date, set
-- `effective_to`. Changing `status` alone stops it being enforced TODAY (see
-- compliance_rules_currently_enforced below) but does not, and must not, edit
-- what was true in the past.
CREATE OR REPLACE FUNCTION public.compliance_rules_in_force(p_as_of date DEFAULT current_date)
RETURNS SETOF public.compliance_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.compliance_rules r
  WHERE r.status IN ('active', 'paused', 'retired')
    AND r.effective_from <= p_as_of
    AND (r.effective_to IS NULL OR r.effective_to > p_as_of)
$$;

-- WHICH QUESTION IS THIS? "What must be enforced right now?" — the PRESENT-tense
-- question, and a different one. Here `status` is exactly the right filter: a
-- paused rule is paused, and should not block a shipment today even though its
-- effective window is still open.
--
-- Two functions rather than one flag, because a single function serving both
-- questions is a function whose callers cannot tell which one they asked.
CREATE OR REPLACE FUNCTION public.compliance_rules_currently_enforced()
RETURNS SETOF public.compliance_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.compliance_rules r
  WHERE r.status = 'active'
    AND r.effective_from <= current_date
    AND (r.effective_to IS NULL OR r.effective_to > current_date)
$$;

-- Returns the single ruleset in force, or no row at all.
--
-- NO ROW IS A MEANINGFUL ANSWER AND MUST NOT BE READ AS "NO REQUIREMENTS". A
-- market with no ruleset on file is a market nobody has researched, and the
-- export gate is required to treat it as unresolved and refuse. That decision
-- belongs to the caller; this function's job is to be honest that it found
-- nothing.
CREATE OR REPLACE FUNCTION public.destination_ruleset_in_force(
  p_country_code char(2),
  p_regime       text,
  p_as_of        date DEFAULT current_date)
RETURNS SETOF public.destination_rulesets
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.destination_rulesets d
  WHERE d.country_code = p_country_code
    AND d.regime = p_regime
    AND d.effective_from <= p_as_of
    AND (d.effective_to IS NULL OR d.effective_to > p_as_of)
  ORDER BY d.effective_from DESC
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.compliance_rules_in_force(date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compliance_rules_in_force(date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.compliance_rules_currently_enforced() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compliance_rules_currently_enforced() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.destination_ruleset_in_force(char, text, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.destination_ruleset_in_force(char, text, date) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Row level security
--
-- Destination rulesets are reference data, not counterparty data: they describe
-- a market, name no party, and leak nothing about who is trading. Any signed-in
-- user may read them; only DDP admins may write. anon gets nothing.
-- -----------------------------------------------------------------------------
ALTER TABLE public.destination_rulesets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS destination_rulesets_select ON public.destination_rulesets;
CREATE POLICY destination_rulesets_select ON public.destination_rulesets
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS destination_rulesets_write ON public.destination_rulesets;
CREATE POLICY destination_rulesets_write ON public.destination_rulesets
  FOR ALL TO authenticated
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

REVOKE ALL ON public.destination_rulesets FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.destination_rulesets TO authenticated, service_role;

COMMIT;
