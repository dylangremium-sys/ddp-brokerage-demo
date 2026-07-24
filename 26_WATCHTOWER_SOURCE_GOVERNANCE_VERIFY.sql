-- =============================================================================
-- Migration 26 — VERIFY (Watchtower source governance & tiering)
--
-- Production-safe: one transaction, ends in ROLLBACK, no COMMIT. Behavioural
-- checks that build real fixtures and prove the database refuses what the
-- governance model forbids. A section that cannot build its fixture RAISES.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — governance columns, constraints, helpers and the guard trigger all
-- exist with the required security shape.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing text[] := ARRAY[]::text[];
  c text;
  cols text[] := ARRAY['tier','authority_type','category','monitoring_method','priority'];
  fns  text[] := ARRAY['regulatory_source_tier','source_can_act_as_authority','guard_rule_source_authority'];
  f text;
  insecure text[] := ARRAY[]::text[];
  not_null_missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='regulatory_sources' AND column_name=c)
    THEN missing := missing || ('regulatory_sources.' || c); END IF;
  END LOOP;

  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname=f)
    THEN missing := missing || ('function ' || f); END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='compliance_rules_tier3_authority_guard')
  THEN missing := missing || 'trigger compliance_rules_tier3_authority_guard'; END IF;

  FOREACH c IN ARRAY ARRAY['regulatory_sources_tier_range','regulatory_sources_authority_type_allowed',
                           'regulatory_sources_category_allowed','regulatory_sources_monitoring_method_allowed',
                           'regulatory_sources_priority_range','regulatory_sources_tier1_not_aggregator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=c)
    THEN missing := missing || ('constraint ' || c); END IF;
  END LOOP;

  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(missing, ', ');
  END IF;

  -- Every governance column must be NOT NULL (or a legacy writer could leave a
  -- source unclassified and it might slip past as authority).
  FOREACH c IN ARRAY cols LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='regulatory_sources'
                 AND column_name=c AND is_nullable='YES')
    THEN not_null_missing := not_null_missing || c; END IF;
  END LOOP;
  IF array_length(not_null_missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: governance columns still nullable: %',
      array_to_string(not_null_missing, ', ');
  END IF;

  SELECT array_agg(p.proname::text) INTO insecure
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(fns)
    AND (p.prosecdef=false OR p.proconfig IS NULL
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'));
  IF insecure IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: not SECURITY DEFINER with search_path: %',
      array_to_string(insecure, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: governance columns/constraints/helpers/trigger present and secure.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- VERIFY B — allowed-value + range + cross-field constraints are enforced.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  refused int := 0;
BEGIN
  -- B1: out-of-range tier.
  BEGIN
    INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier)
    VALUES ('V26 bad tier','TH','government_regulator','https://v26bt.example.gov',4);
    RAISE EXCEPTION 'VERIFY B FAILED: tier 4 accepted';
  EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

  -- B2: bad authority_type.
  BEGIN
    INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,authority_type)
    VALUES ('V26 bad auth','TH','government_regulator','https://v26ba.example.gov','wizard');
    RAISE EXCEPTION 'VERIFY B FAILED: bogus authority_type accepted';
  EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

  -- B3: bad category.
  BEGIN
    INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,category)
    VALUES ('V26 bad cat','TH','government_regulator','https://v26bc.example.gov','sportsball');
    RAISE EXCEPTION 'VERIFY B FAILED: bogus category accepted';
  EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

  -- B4: priority out of range.
  BEGIN
    INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,priority)
    VALUES ('V26 bad prio','TH','government_regulator','https://v26bp.example.gov',0);
    RAISE EXCEPTION 'VERIFY B FAILED: priority 0 accepted';
  EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

  -- B5: contradictory Tier 1 + aggregator.
  BEGIN
    INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier,authority_type)
    VALUES ('V26 contradiction','TH','government_regulator','https://v26x.example.gov',1,'aggregator');
    RAISE EXCEPTION 'VERIFY B FAILED: Tier 1 aggregator accepted';
  EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

  IF refused <> 5 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: expected 5 refusals, observed %', refused;
  END IF;

  -- A well-formed Tier 1 primary_regulator must be accepted.
  INSERT INTO public.regulatory_sources
    (name,jurisdiction,source_type,url,tier,authority_type,category,monitoring_method,priority)
  VALUES ('V26 good t1','TH','government_regulator','https://v26g.example.gov',
          1,'primary_regulator','export_import','rss',5);

  RAISE NOTICE 'VERIFY B PASSED: allowed-value/range/cross-field constraints enforced (5 refusals).';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- VERIFY C — conservative defaults: a source inserted with no governance fields
-- is the LEAST authoritative shape (Tier 3 signal), never an authority.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  r record;
BEGIN
  INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url)
  VALUES ('V26 defaulting','TH','government_regulator','https://v26d.example.gov')
  RETURNING tier, authority_type, category, monitoring_method, priority INTO r;

  IF r.tier <> 3 OR r.authority_type <> 'aggregator' OR r.category <> 'general'
     OR r.monitoring_method <> 'manual' OR r.priority <> 100 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: default governance was not the conservative Tier-3 shape (got tier=%, auth=%, cat=%, method=%, prio=%)',
      r.tier, r.authority_type, r.category, r.monitoring_method, r.priority;
  END IF;

  IF public.source_can_act_as_authority(
       (SELECT id FROM public.regulatory_sources WHERE name='V26 defaulting')) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a defaulted (Tier 3) source reported that it CAN act as authority';
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: unclassified inserts default to Tier-3 signal and cannot act as authority.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- VERIFY D — the helper predicate: Tier 1/2 can act as authority, Tier 3 cannot.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  t1 uuid; t2 uuid; t3 uuid;
BEGIN
  INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier,authority_type)
  VALUES ('V26 t1','TH','government_regulator','https://v26t1.example.gov',1,'primary_regulator') RETURNING id INTO t1;
  INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier,authority_type)
  VALUES ('V26 t2','TH','legal_database','https://v26t2.example.gov',2,'standards_body') RETURNING id INTO t2;
  INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier,authority_type)
  VALUES ('V26 t3','TH','news_press_release','https://v26t3.example.gov',3,'news_media') RETURNING id INTO t3;

  IF NOT public.source_can_act_as_authority(t1) THEN RAISE EXCEPTION 'VERIFY D FAILED: Tier 1 rejected as authority'; END IF;
  IF NOT public.source_can_act_as_authority(t2) THEN RAISE EXCEPTION 'VERIFY D FAILED: Tier 2 rejected as authority'; END IF;
  IF public.source_can_act_as_authority(t3) THEN RAISE EXCEPTION 'VERIFY D FAILED: Tier 3 accepted as authority'; END IF;
  IF public.source_can_act_as_authority(gen_random_uuid()) THEN RAISE EXCEPTION 'VERIFY D FAILED: unknown source accepted as authority (should fail closed)'; END IF;

  RAISE NOTICE 'VERIFY D PASSED: authority predicate = Tier 1/2 only; unknown fails closed.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- VERIFY E — THE governance boundary: an enforced compliance_rule may not trace
-- to a Tier-3 source, but a Tier-1 basis is accepted, and a Tier-3 draft is fine.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  s_t3 uuid; s_t1 uuid;
  lu_t3 uuid; lu_t1 uuid;
  refused int := 0;
BEGIN
  INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier,authority_type)
  VALUES ('V26 signal src','TH','news_press_release','https://v26sig.example.gov',3,'news_media') RETURNING id INTO s_t3;
  INSERT INTO public.regulatory_sources (name,jurisdiction,source_type,url,tier,authority_type)
  VALUES ('V26 authority src','TH','government_regulator','https://v26auth.example.gov',1,'primary_regulator') RETURNING id INTO s_t1;

  INSERT INTO public.legal_updates (source_id,title,jurisdiction)
  VALUES (s_t3,'V26 signal update','TH') RETURNING id INTO lu_t3;
  INSERT INTO public.legal_updates (source_id,title,jurisdiction)
  VALUES (s_t1,'V26 authority update','TH') RETURNING id INTO lu_t1;

  -- E1: a DRAFT rule tracing to a Tier-3 source is allowed (human-review path).
  INSERT INTO public.compliance_rules
    (rule_code,title,description,entity_type,severity,status,source_legal_update_id)
  VALUES ('V26-DRAFT','draft from signal','d','farm','low','draft',lu_t3);

  -- E2: promoting that rule to an enforced status on a Tier-3 basis is REFUSED.
  BEGIN
    UPDATE public.compliance_rules SET status='approved' WHERE rule_code='V26-DRAFT';
    RAISE EXCEPTION 'VERIFY E FAILED: a Tier-3-sourced rule was allowed to become approved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY E FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  -- E3: inserting an already-enforced rule on a Tier-3 basis is REFUSED too
  -- (the guard fires on INSERT, not only UPDATE).
  BEGIN
    INSERT INTO public.compliance_rules
      (rule_code,title,description,entity_type,severity,status,source_legal_update_id)
    VALUES ('V26-ENFORCED-T3','enforced from signal','d','farm','high','active',lu_t3);
    RAISE EXCEPTION 'VERIFY E FAILED: an active rule from a Tier-3 source was inserted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY E FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  IF refused <> 2 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: expected 2 refusals, observed %', refused;
  END IF;

  -- E4: the SAME enforced status is accepted when the basis is a Tier-1 source.
  INSERT INTO public.compliance_rules
    (rule_code,title,description,entity_type,severity,status,source_legal_update_id)
  VALUES ('V26-ENFORCED-T1','enforced from authority','d','farm','high','active',lu_t1);

  -- E5: re-pointing the blocked draft at a Tier-1 basis unblocks enforcement.
  UPDATE public.compliance_rules
  SET source_legal_update_id = lu_t1, status = 'approved'
  WHERE rule_code = 'V26-DRAFT';

  IF (SELECT status FROM public.compliance_rules WHERE rule_code='V26-DRAFT') <> 'approved' THEN
    RAISE EXCEPTION 'VERIFY E FAILED: re-pointing to a Tier-1 basis did not permit approval';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: Tier-3 cannot source an enforced rule; Tier-1 can; drafts unaffected.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- VERIFY F — a rule with NO traced source is out of scope for this guard (it is
-- not silently blocked; its authority basis is established elsewhere).
-- -----------------------------------------------------------------------------
DO $verify_f$
BEGIN
  INSERT INTO public.compliance_rules
    (rule_code,title,description,entity_type,severity,status,source_legal_update_id)
  VALUES ('V26-MANUAL','manually authored','d','buyer','medium','active',NULL);

  IF (SELECT status FROM public.compliance_rules WHERE rule_code='V26-MANUAL') <> 'active' THEN
    RAISE EXCEPTION 'VERIFY F FAILED: a source-less enforced rule was blocked by the tier guard';
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: source-less enforced rules are out of scope for the tier guard.';
END
$verify_f$;

DO $done$
BEGIN
  RAISE NOTICE '=== MIGRATION 26 VERIFY: ALL SECTIONS PASSED (A-F). Rolling back all fixtures. ===';
END
$done$;

ROLLBACK;
