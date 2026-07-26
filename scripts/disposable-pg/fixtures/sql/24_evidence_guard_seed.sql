-- Destructive-guard seed for the 24_evidence fixture.
--
-- Creates exactly ONE live evidence request so the migration-24 ROLLBACK guard
-- has audit data to protect. This is HARNESS TEST DATA, not migration SQL: it
-- mirrors the migration's own VERIFY C1 "control" insert (a correctly scoped
-- farm-level request) rather than duplicating any migration DDL. After this seed
-- the guard must REFUSE a rollback without the explicit opt-in, and SUCCEED with
-- it — exactly the property text tests cannot prove.
DO $seed$
DECLARE
  actor     uuid;
  farm_a    uuid;
  profile_a uuid;
  req_id    uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: no auth.users row available to act as creator';
  END IF;

  INSERT INTO public.farms (id, created_by)
    VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_a;
  INSERT INTO public.farm_profiles (id, farm_id)
    VALUES (gen_random_uuid(), farm_a) RETURNING id INTO profile_a;

  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_a, 'farm_profile', profile_a, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;

  IF req_id IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: control insert produced no row (guard test would be vacuous)';
  END IF;

  RAISE NOTICE 'guard seed: 1 live evidence request created (id=%).', req_id;
END
$seed$;
