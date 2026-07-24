-- Post-provision identity + ownership verification (READ-ONLY, fail-closed).
--
-- Run AFTER you have recreated the clean user set in the Supabase dashboard
-- (1 admin / 2 farmers / 1 pending) and created a farm + owner membership per
-- farmer. Asserts the identity layer is exactly as intended; RAISEs (non-zero
-- exit) on the first violation so a green run is real evidence.
--
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify_staging_identity.sql
--
-- NOTE: this checks STRUCTURE (counts, ownership, referential integrity). The
-- RUNTIME tenant-isolation proof (farmer A cannot read farmer B) is a separate
-- concern, proven by `npm run security:staging` — not by this script.

DO $$
DECLARE
  -- Expected pilot identity set — edit here if the target changes.
  exp_admin   int := 1;
  exp_farmer  int := 2;
  exp_pending int := 1;

  n_admin   int;
  n_farmer  int;
  n_pending int;
  n_prof    int;
  n_auth    int;
  bad       int;
  offender  text;
BEGIN
  -- 1) Role counts exactly match the target set.
  SELECT count(*) FILTER (WHERE role='ddp_admin'),
         count(*) FILTER (WHERE role='farmer'),
         count(*) FILTER (WHERE role='pending'),
         count(*)
    INTO n_admin, n_farmer, n_pending, n_prof
    FROM public.profiles;

  IF n_admin <> exp_admin OR n_farmer <> exp_farmer OR n_pending <> exp_pending THEN
    RAISE EXCEPTION 'Identity set mismatch: admin=% (want %), farmer=% (want %), pending=% (want %)',
      n_admin, exp_admin, n_farmer, exp_farmer, n_pending, exp_pending;
  END IF;
  IF n_prof <> (exp_admin + exp_farmer + exp_pending) THEN
    RAISE EXCEPTION 'Unexpected profile role present: total profiles=% but roles sum to %',
      n_prof, (exp_admin + exp_farmer + exp_pending);
  END IF;

  -- 2) Profiles <-> auth.users are 1:1 (no orphan profile, no auth user missing a profile).
  SELECT count(*) INTO bad
    FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);
  IF bad <> 0 THEN RAISE EXCEPTION '% profile row(s) have no matching auth.users', bad; END IF;

  SELECT count(*) INTO n_auth FROM auth.users;
  IF n_auth <> n_prof THEN
    RAISE EXCEPTION 'auth.users (%) and profiles (%) counts differ — a user without a profile row exists', n_auth, n_prof;
  END IF;

  -- 3) Every farmer owns >= 1 farm (owner membership).
  SELECT string_agg(p.email, ', ') INTO offender
    FROM public.profiles p
   WHERE p.role = 'farmer'
     AND NOT EXISTS (
       SELECT 1 FROM public.farm_memberships m
        WHERE m.user_id = p.id AND m.role = 'owner');
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'Farmer(s) with no owned farm: %', offender;
  END IF;

  -- 4) Ownership sanity: every owner membership belongs to a farmer, and every
  --    farm has at most one owner (no shared/co-owned farm = no cross-tenant leak).
  SELECT count(*) INTO bad
    FROM public.farm_memberships m
    JOIN public.profiles p ON p.id = m.user_id
   WHERE m.role = 'owner' AND p.role <> 'farmer';
  IF bad <> 0 THEN RAISE EXCEPTION '% owner membership(s) held by a non-farmer role', bad; END IF;

  SELECT count(*) INTO bad FROM (
    SELECT farm_id FROM public.farm_memberships WHERE role='owner'
    GROUP BY farm_id HAVING count(DISTINCT user_id) > 1
  ) x;
  IF bad <> 0 THEN RAISE EXCEPTION '% farm(s) have more than one owner (cross-tenant ownership leak)', bad; END IF;

  -- 5) Referential integrity of memberships (defensive; FKs should already hold).
  SELECT count(*) INTO bad
    FROM public.farm_memberships m
   WHERE NOT EXISTS (SELECT 1 FROM public.farms f WHERE f.id = m.farm_id)
      OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.user_id);
  IF bad <> 0 THEN RAISE EXCEPTION '% membership row(s) reference a missing farm or user', bad; END IF;

  -- 6) Pending and admin users own no farms (they are not tenants).
  SELECT count(*) INTO bad
    FROM public.farm_memberships m
    JOIN public.profiles p ON p.id = m.user_id
   WHERE p.role IN ('pending','ddp_admin');
  IF bad <> 0 THEN RAISE EXCEPTION '% membership(s) held by a pending/admin user (should be none)', bad; END IF;

  RAISE NOTICE 'IDENTITY VERIFICATION PASSED: % admin / % farmer / % pending; every farmer owns >=1 farm; no cross-tenant ownership; profiles<->auth.users 1:1.',
    n_admin, n_farmer, n_pending;
END $$;
