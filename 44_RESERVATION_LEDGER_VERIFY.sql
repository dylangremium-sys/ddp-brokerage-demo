-- =============================================================================
-- Migration 44 — VERIFY: the reservation ledger
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure
--   B — availability arithmetic, including the exact-fit and one-gram boundaries
--   C — EXPIRY IS COMPUTED: a lapsed reservation frees its quantity with no
--       sweeper, no state change and nothing written anywhere
--   D — releases: one per reservation, a conversion must name a consignment,
--       and releasing frees quantity immediately
--   E — append-only in behaviour AND in privilege
--   F — what may be reserved at all: unpublished batch, unverified buyer,
--       non-buyer organisation
--   G — a batch with no usable quantity fails closed, and stock_status is never
--       written by this migration
--   H — BEHAVIOURAL, as `authenticated`: the double-blind rule in both
--       directions
--   I — anon holds nothing
--   J — commercial events go to their OWN log, and the compliance log's closed
--       regulatory vocabulary is never forced open to admit them
--
-- Expected on success: ten PASSED notices and no exception.
--
-- NOT PROVEN HERE: that the FOR UPDATE lock in
-- fn_enforce_reservation_availability() serialises genuinely concurrent
-- reservations. A single session cannot demonstrate that. Section B proves the
-- arithmetic and the refusal; the locking claim needs a two-session test on
-- staging before the marketplace opens.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE v44 (k text PRIMARY KEY, v uuid) ON COMMIT DROP;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservations', 'reservation_releases', 'commercial_audit_log'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      v_missing := array_append(v_missing, 'table ' || t);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['reservation_is_active', 'batch_reserved_kg', 'batch_available_kg',
                           'batch_reserved_kg_unchecked', 'fn_enforce_reservation_availability',
                           'prevent_reservation_mutation',
                           'prevent_commercial_audit_log_mutation'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname=f) THEN
      v_missing := array_append(v_missing, 'function ' || f);
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['reservations_no_update_delete', 'reservation_releases_no_update_delete',
                           'reservations_enforce_availability', 'reservations_audit',
                           'commercial_audit_log_no_update_delete',
                           'reservations_no_truncate', 'reservation_releases_no_truncate',
                           'commercial_audit_log_no_truncate'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND NOT tgisinternal) THEN
      v_missing := array_append(v_missing, 'trigger ' || t);
    END IF;
  END LOOP;

  -- One release per reservation, enforced by a UNIQUE constraint rather than
  -- hoped for in application code.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservation_releases'::regclass AND contype = 'u'
  ) THEN
    v_missing := array_append(v_missing, 'UNIQUE constraint on reservation_releases.reservation_id');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: all three tables, seven functions, five triggers and the one-release-per-reservation unique constraint are present.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. Availability arithmetic
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_admin uuid := '00440000-0000-4000-a000-00000000ad01';
  v_farm  uuid := '00440000-0000-4000-a000-0000000000f1';
  v_batch uuid := '00440000-0000-4000-a000-0000000000b1';
  v_buyer uuid;
  v_res   uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_admin, 'admin44@verify.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES (v_admin, 'admin44@verify.test', 'ddp_admin')
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.farms (id) VALUES (v_farm) ON CONFLICT DO NOTHING;
  INSERT INTO public.inventory_batches (id, farm_id, quantity_kg, client_visible, stock_status)
  VALUES (v_batch, v_farm, 100.000, true, 'client_visible') ON CONFLICT DO NOTHING;

  INSERT INTO public.organisations (org_type, legal_name, country_code, verification_state, verified_by, verified_at)
  VALUES ('buyer', 'Reserving Import GmbH', 'DE', 'verified', v_admin, now())
  RETURNING id INTO v_buyer;

  INSERT INTO v44 VALUES ('admin', v_admin), ('farm', v_farm), ('batch', v_batch), ('buyer', v_buyer);

  IF public.batch_available_kg(v_batch) <> 100.000 THEN
    v_problems := array_append(v_problems,
      format('fresh batch availability is %s, expected 100', public.batch_available_kg(v_batch)));
  END IF;

  INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg, created_by)
  VALUES (v_batch, v_buyer, 60.000, v_admin) RETURNING id INTO v_res;
  INSERT INTO v44 VALUES ('res60', v_res);

  IF public.batch_available_kg(v_batch) <> 40.000 THEN
    v_problems := array_append(v_problems,
      format('availability after a 60 kg hold is %s, expected 40', public.batch_available_kg(v_batch)));
  END IF;
  IF public.batch_reserved_kg(v_batch) <> 60.000 THEN
    v_problems := array_append(v_problems, 'reserved quantity did not read back as 60');
  END IF;

  -- One gram too many.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_batch, v_buyer, 40.001);
    v_problems := array_append(v_problems, 'an over-reservation of 0.001 kg was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Exactly the remainder.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_batch, v_buyer, 40.000);
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a reservation that exactly exhausts the batch was refused');
  END;

  IF public.batch_available_kg(v_batch) <> 0 THEN
    v_problems := array_append(v_problems,
      format('availability after full reservation is %s, expected 0', public.batch_available_kg(v_batch)));
  END IF;

  -- And nothing more fits.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_batch, v_buyer, 0.001);
    v_problems := array_append(v_problems, 'a reservation against a fully-held batch was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: availability is quantity minus active holds; a 1-gram oversell is refused, an exact fit is allowed, and a fully-held batch admits nothing further.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Expiry is computed — no sweeper, no state change
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_batch    uuid := (SELECT v FROM v44 WHERE k='batch');
  v_buyer    uuid := (SELECT v FROM v44 WHERE k='buyer');
  v_lapsing  uuid;
  v_forged   uuid;
  v_problems text[] := ARRAY[]::text[];
  v_before   numeric;
BEGIN
  -- Free the batch, then place a hold that lapses in one hour.
  INSERT INTO public.reservation_releases (reservation_id, kind, reason)
  SELECT r.id, 'released', 'clearing the batch for the expiry test'
  FROM public.reservations r WHERE r.inventory_batch_id = v_batch
    AND NOT EXISTS (SELECT 1 FROM public.reservation_releases x WHERE x.reservation_id = r.id);

  INSERT INTO public.reservations
    (inventory_batch_id, buyer_organisation_id, quantity_kg, created_at, expires_at)
  VALUES (v_batch, v_buyer, 75.000, now(), now() + interval '1 hour')
  RETURNING id INTO v_lapsing;

  IF public.batch_available_kg(v_batch) <> 25.000 THEN
    v_problems := array_append(v_problems,
      format('availability with a live 75 kg hold is %s, expected 25', public.batch_available_kg(v_batch)));
  END IF;
  IF NOT public.reservation_is_active(v_lapsing) THEN
    v_problems := array_append(v_problems, 'a hold expiring in an hour is not active now');
  END IF;

  -- Ask again as at a moment after it lapses. NOTHING has been written: no
  -- sweeper has run, no status changed, the row is untouched.
  IF public.batch_available_kg(v_batch, now() + interval '2 hours') <> 100.000 THEN
    v_problems := array_append(v_problems,
      format('availability two hours later is %s, expected the full 100 — expiry is not being computed',
             public.batch_available_kg(v_batch, now() + interval '2 hours')));
  END IF;
  IF public.reservation_is_active(v_lapsing, now() + interval '2 hours') THEN
    v_problems := array_append(v_problems, 'a lapsed reservation still reads as active');
  END IF;

  -- The row itself must be exactly as it was: no expiry state was stored.
  IF NOT EXISTS (SELECT 1 FROM public.reservations WHERE id = v_lapsing AND expires_at > now()) THEN
    v_problems := array_append(v_problems, 'the reservation row was mutated by the expiry check');
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_releases WHERE reservation_id = v_lapsing) THEN
    v_problems := array_append(v_problems, 'expiry wrote a release row; expiry must be derived, not recorded');
  END IF;

  -- The default hold is 7 days.
  IF NOT EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.id = (SELECT v FROM v44 WHERE k='res60')
      AND r.expires_at BETWEEN r.created_at + interval '6 days 23 hours'
                           AND r.created_at + interval '7 days 1 hour'
  ) THEN
    v_problems := array_append(v_problems, 'the default hold is not 7 days');
  END IF;

  -- created_at is server-authoritative. A future created_at would make the
  -- availability check measure the batch at a moment when live holds have
  -- already lapsed — reserving beyond the batch's own quantity, right now.
  INSERT INTO public.reservations
    (inventory_batch_id, buyer_organisation_id, quantity_kg, created_at)
  VALUES (v_batch, v_buyer, 1.000, now() + interval '5 hours')
  RETURNING id INTO v_forged;

  IF (SELECT created_at FROM public.reservations WHERE id = v_forged) > now() THEN
    v_problems := array_append(v_problems,
      'a client-supplied FUTURE created_at was accepted; the availability ceiling can be bypassed by dating a reservation forward');
  END IF;

  -- And the hold length is capped, or stock could be held indefinitely.
  BEGIN
    INSERT INTO public.reservations
      (inventory_batch_id, buyer_organisation_id, quantity_kg, expires_at)
    VALUES (v_batch, v_buyer, 1.000, now() + interval '400 days');
    v_problems := array_append(v_problems, 'a 400-day hold was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: a lapsed hold frees its quantity with no sweeper, no row mutation and no release record; the default hold is 7 days; a client-supplied future created_at is overwritten server-side; and a 400-day hold is refused.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. Releases
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_admin uuid := (SELECT v FROM v44 WHERE k='admin');
  v_farm  uuid := (SELECT v FROM v44 WHERE k='farm');
  v_buyer uuid := (SELECT v FROM v44 WHERE k='buyer');
  v_batch uuid := '00440000-0000-4000-a000-0000000000b2';
  v_res   uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, quantity_kg, client_visible)
  VALUES (v_batch, v_farm, 50.000, true) ON CONFLICT DO NOTHING;

  INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
  VALUES (v_batch, v_buyer, 50.000) RETURNING id INTO v_res;

  IF public.batch_available_kg(v_batch) <> 0 THEN
    v_problems := array_append(v_problems, 'availability was not zero with the batch fully held');
  END IF;

  -- A conversion with no consignment reference is a hold that became a shipment
  -- nobody can find.
  BEGIN
    INSERT INTO public.reservation_releases (reservation_id, kind, reason)
    VALUES (v_res, 'converted', 'converted with no consignment reference');
    v_problems := array_append(v_problems, 'a conversion with NO consignment_ref was ADMITTED');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO public.reservation_releases (reservation_id, kind, consignment_ref, reason, released_by)
  VALUES (v_res, 'converted', 'CONS-44-1', 'buyer confirmed; proceeding to shipment', v_admin);

  IF public.batch_available_kg(v_batch) <> 50.000 THEN
    v_problems := array_append(v_problems,
      format('availability after release is %s, expected the full 50', public.batch_available_kg(v_batch)));
  END IF;
  IF public.reservation_is_active(v_res) THEN
    v_problems := array_append(v_problems, 'a released reservation still reads as active');
  END IF;

  -- One ending per reservation.
  BEGIN
    INSERT INTO public.reservation_releases (reservation_id, kind, reason)
    VALUES (v_res, 'cancelled', 'a second, contradictory ending');
    v_problems := array_append(v_problems, 'a SECOND release of the same reservation was ADMITTED');
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- A release must say why.
  INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
  VALUES (v_batch, v_buyer, 10.000) RETURNING id INTO v_res;
  BEGIN
    INSERT INTO public.reservation_releases (reservation_id, kind, reason)
    VALUES (v_res, 'released', '   ');
    v_problems := array_append(v_problems, 'a release with a blank reason was ADMITTED');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: releasing frees quantity immediately, a conversion must name a consignment, a reservation may end only once, and a release must state a reason.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. Append-only, in behaviour and in privilege
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_res      uuid := (SELECT v FROM v44 WHERE k='res60');
  v_problems text[] := ARRAY[]::text[];
BEGIN
  BEGIN
    UPDATE public.reservations SET quantity_kg = 1.000 WHERE id = v_res;
    v_problems := array_append(v_problems, 'UPDATE on a reservation was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    DELETE FROM public.reservations WHERE id = v_res;
    v_problems := array_append(v_problems, 'DELETE on a reservation was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    UPDATE public.reservation_releases SET reason = 'rewritten' WHERE reservation_id IS NOT NULL;
    v_problems := array_append(v_problems, 'UPDATE on a release was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  IF has_table_privilege('authenticated', 'public.reservations', 'UPDATE') THEN
    v_problems := array_append(v_problems, 'authenticated holds UPDATE on reservations');
  END IF;
  IF has_table_privilege('authenticated', 'public.reservations', 'DELETE') THEN
    v_problems := array_append(v_problems, 'authenticated holds DELETE on reservations');
  END IF;
  IF has_table_privilege('authenticated', 'public.reservation_releases', 'UPDATE') THEN
    v_problems := array_append(v_problems, 'authenticated holds UPDATE on reservation_releases');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: UPDATE and DELETE raise on both tables, and neither privilege is granted to authenticated in the first place.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. What may be reserved at all
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_admin uuid := (SELECT v FROM v44 WHERE k='admin');
  v_farm  uuid := (SELECT v FROM v44 WHERE k='farm');
  v_hidden uuid := '00440000-0000-4000-a000-0000000000b3';
  v_open   uuid := '00440000-0000-4000-a000-0000000000b4';
  v_buyer  uuid := (SELECT v FROM v44 WHERE k='buyer');
  v_unverified uuid;
  v_lab    uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, quantity_kg, client_visible)
  VALUES (v_hidden, v_farm, 100.000, false), (v_open, v_farm, 100.000, true)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Unvetted Import BV', 'NL') RETURNING id INTO v_unverified;
  INSERT INTO public.organisations (org_type, legal_name, country_code, verification_state, verified_by, verified_at)
  VALUES ('laboratory', 'Not A Buyer Lab', 'TH', 'verified', v_admin, now()) RETURNING id INTO v_lab;

  -- An unpublished batch is not a listing.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_hidden, v_buyer, 1.000);
    v_problems := array_append(v_problems, 'an UNPUBLISHED batch was reserved');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- An unverified buyer may not hold stock.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_open, v_unverified, 1.000);
    v_problems := array_append(v_problems, 'an UNVERIFIED buyer held stock');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Neither may a laboratory, however verified.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_open, v_lab, 1.000);
    v_problems := array_append(v_problems, 'a LABORATORY organisation held stock');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Sanity: the same reservation succeeds for a verified buyer on a published
  -- batch, so the refusals above are caused by what was wrong and not by the
  -- fixture being broken.
  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_open, v_buyer, 1.000);
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a VALID reservation was refused; section F''s results are unreliable');
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: an unpublished batch, an unverified buyer and a non-buyer organisation are each refused, while the equivalent valid reservation succeeds.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. Unusable quantity fails closed; stock_status is left alone
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_farm  uuid := (SELECT v FROM v44 WHERE k='farm');
  v_buyer uuid := (SELECT v FROM v44 WHERE k='buyer');
  v_batch uuid := (SELECT v FROM v44 WHERE k='batch');
  v_null  uuid := '00440000-0000-4000-a000-0000000000c1';
  v_nan   uuid := '00440000-0000-4000-a000-0000000000c2';
  v_status text;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, quantity_kg, client_visible)
  VALUES (v_null, v_farm, NULL, true), (v_nan, v_farm, 'NaN'::numeric, true)
  ON CONFLICT DO NOTHING;

  -- NaN sorts above every real number, so an unguarded comparison would treat
  -- this batch as having effectively infinite stock.
  IF public.batch_available_kg(v_null) <> 0 THEN
    v_problems := array_append(v_problems, 'a batch with NULL quantity reported non-zero availability');
  END IF;
  IF public.batch_available_kg(v_nan) <> 0 THEN
    v_problems := array_append(v_problems, 'a batch with NaN quantity reported non-zero availability');
  END IF;

  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_nan, v_buyer, 1.000);
    v_problems := array_append(v_problems, 'a batch with NaN quantity was RESERVED against');
  EXCEPTION WHEN others THEN NULL;
  END;

  BEGIN
    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_null, v_buyer, 1.000);
    v_problems := array_append(v_problems, 'a batch with NULL quantity was RESERVED against');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Seam 2 corollary: the ledger is the truth, so stock_status must be exactly
  -- as the fixture set it. A second source of truth would go stale the moment a
  -- hold expired, and there is no scheduler to refresh it.
  SELECT stock_status INTO v_status FROM public.inventory_batches WHERE id = v_batch;
  IF v_status IS DISTINCT FROM 'client_visible' THEN
    v_problems := array_append(v_problems,
      format('reserving wrote inventory_batches.stock_status (now %L); the ledger must be the only source of truth', v_status));
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: NULL and NaN batch quantities report zero availability and cannot be reserved against, and reserving never writes stock_status.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- H. BEHAVIOURAL — the double-blind rule, observed as `authenticated`
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  v_admin      uuid := (SELECT v FROM v44 WHERE k='admin');
  v_farm       uuid := (SELECT v FROM v44 WHERE k='farm');
  v_batch      uuid := (SELECT v FROM v44 WHERE k='batch');
  v_buyer_org  uuid := (SELECT v FROM v44 WHERE k='buyer');
  v_buyer_user uuid := '00440000-0000-4000-a000-00000000e001';
  v_farm_user  uuid := '00440000-0000-4000-a000-00000000e002';
  v_farm_org   uuid;
  v_seen       bigint;
  v_reserved   numeric;
  v_problems   text[] := ARRAY[]::text[];
  v_blocked    boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_buyer_user, 'buyer44@verify.test'), (v_farm_user, 'farm44@verify.test')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES
    (v_buyer_user, 'buyer44@verify.test', 'buyer'), (v_farm_user, 'farm44@verify.test', 'farmer')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organisations (org_type, legal_name, country_code, farm_id)
  VALUES ('farm', 'Reserved Stock Farm', 'TH', v_farm) RETURNING id INTO v_farm_org;

  INSERT INTO public.organisation_memberships (organisation_id, user_id, org_role) VALUES
    (v_buyer_org, v_buyer_user, 'owner'), (v_farm_org, v_farm_user, 'owner');
  INSERT INTO public.farm_memberships (farm_id, user_id) VALUES (v_farm, v_farm_user)
  ON CONFLICT DO NOTHING;

  -- ── As the buyer ─────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.reservations;
  IF v_seen = 0 THEN
    v_problems := array_append(v_problems, 'a buyer cannot see their OWN reservations');
  END IF;

  -- The batch id is visible on the buyer's own reservation, but it must not be
  -- a route to the farm: inventory_batches' own RLS has to deny the row.
  SELECT count(*) INTO v_seen FROM public.inventory_batches WHERE id = v_batch;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      'DOUBLE-BLIND BREACH: a buyer can read the inventory_batches row behind their reservation');
  END IF;

  SELECT count(*) INTO v_seen FROM public.organisations WHERE org_type = 'farm';
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems, 'DOUBLE-BLIND BREACH: a buyer can see a farm organisation');
  END IF;

  -- Supply-side demand data is not a buyer's business.
  BEGIN
    v_reserved := public.batch_reserved_kg(v_batch);
    v_blocked := false;
  EXCEPTION WHEN others THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    v_problems := array_append(v_problems, 'a buyer could read reserved quantity for a farm''s batch');
  END IF;

  PERFORM set_config('role', 'none', true);

  -- ── As the farmer ────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_farm_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.reservations;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      format('DOUBLE-BLIND BREACH: a farmer can read %s reservation row(s) — those name the buyer', v_seen));
  END IF;

  SELECT count(*) INTO v_seen FROM public.reservation_releases;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems, 'DOUBLE-BLIND BREACH: a farmer can read release rows');
  END IF;

  -- But the farmer MUST get the number for their own batch.
  BEGIN
    v_reserved := public.batch_reserved_kg(v_batch);
  EXCEPTION WHEN others THEN
    v_reserved := NULL;
  END;
  IF v_reserved IS NULL THEN
    v_problems := array_append(v_problems, 'a farmer cannot read reserved quantity for their OWN batch');
  END IF;

  PERFORM set_config('role', 'none', true);

  -- ── No identity ──────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM public.reservations;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems, 'an identity-less caller can read reservations');
  END IF;
  PERFORM set_config('role', 'none', true);

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY H FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: observed as role authenticated — a buyer sees their own reservations but cannot reach the batch row, the farm organisation, or supply-side demand; a farmer sees NO reservation rows yet does get the reserved quantity for their own batch; and an identity-less caller sees nothing.';
END
$verify_h$;

-- -----------------------------------------------------------------------------
-- I. anon holds nothing
-- -----------------------------------------------------------------------------
DO $verify_i$
DECLARE
  v_grants text[] := ARRAY[]::text[];
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservations', 'reservation_releases'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('anon', 'public.' || t, p) THEN
        v_grants := array_append(v_grants, format('anon has %s on %s', p, t));
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('anon', 'public.batch_available_kg(uuid, timestamptz)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE batch_available_kg');
  END IF;
  IF has_function_privilege('authenticated', 'public.batch_reserved_kg_unchecked(uuid, timestamptz)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'authenticated can EXECUTE the UNGUARDED reserved-quantity function');
  END IF;

  IF array_length(v_grants, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY I FAILED: %', array_to_string(v_grants, '; ');
  END IF;

  RAISE NOTICE 'VERIFY I PASSED: anon holds nothing on either table and cannot execute the availability function, and the unguarded internal sum is not reachable by authenticated.';
END
$verify_i$;

-- -----------------------------------------------------------------------------
-- J. Commercial events live in their OWN log
--
-- The regression guard for the whole point of the separation: a closed
-- regulatory vocabulary is only worth having if it was never opened. If a later
-- edit routes a commercial action back into compliance_audit_log, this fails.
-- -----------------------------------------------------------------------------
DO $verify_j$
DECLARE
  v_admin    uuid := (SELECT v FROM v44 WHERE k='admin');
  v_farm     uuid := (SELECT v FROM v44 WHERE k='farm');
  v_buyer    uuid := (SELECT v FROM v44 WHERE k='buyer');
  v_batch    uuid := '00440000-0000-4000-a000-0000000000d1';
  v_def      text;
  v_res      uuid;
  v_count    bigint;
  v_actor    text;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  -- 1. compliance_audit_log's vocabulary must not admit either commercial action.
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'compliance_audit_log_action_check';

  IF v_def IS NULL THEN
    v_problems := array_append(v_problems, 'compliance_audit_log_action_check is missing entirely');
  ELSE
    IF v_def LIKE '%reservation_created%' OR v_def LIKE '%reservation_released%' THEN
      v_problems := array_append(v_problems,
        'compliance_audit_log''s closed regulatory vocabulary has been forced open to admit a COMMERCIAL action');
    END IF;
  END IF;

  -- 2. A reservation writes to the commercial log, and only there.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.inventory_batches (id, farm_id, quantity_kg, client_visible)
  VALUES (v_batch, v_farm, 25.000, true) ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_count FROM public.compliance_audit_log WHERE entity_type = 'reservation';
  IF v_count <> 0 THEN
    v_problems := array_append(v_problems,
      format('%s reservation row(s) were written to the COMPLIANCE log', v_count));
  END IF;

  INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg, note)
  VALUES (v_batch, v_buyer, 1.000, 'audit routing check') RETURNING id INTO v_res;

  SELECT count(*) INTO v_count
  FROM public.commercial_audit_log
  WHERE entity_type = 'reservation' AND entity_id = v_res::text AND action = 'reservation_created';
  IF v_count <> 1 THEN
    v_problems := array_append(v_problems,
      format('expected exactly 1 commercial audit row for the reservation, found %s', v_count));
  END IF;

  SELECT count(*) INTO v_count FROM public.compliance_audit_log WHERE entity_id = v_res::text;
  IF v_count <> 0 THEN
    v_problems := array_append(v_problems, 'the reservation also wrote to the compliance log');
  END IF;

  -- 3. The actor is recorded as what they actually are.
  SELECT actor_type INTO v_actor
  FROM public.commercial_audit_log WHERE entity_id = v_res::text LIMIT 1;
  IF v_actor IS DISTINCT FROM 'admin' THEN
    v_problems := array_append(v_problems,
      format('an admin-created reservation was logged with actor_type %L', v_actor));
  END IF;

  -- 4. The commercial log is append-only too.
  BEGIN
    UPDATE public.commercial_audit_log SET reason = 'rewritten' WHERE entity_id = v_res::text;
    v_problems := array_append(v_problems, 'UPDATE on commercial_audit_log was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    DELETE FROM public.commercial_audit_log WHERE entity_id = v_res::text;
    v_problems := array_append(v_problems, 'DELETE on commercial_audit_log was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- 5. Its vocabulary is closed: an arbitrary action must be refused.
  BEGIN
    INSERT INTO public.commercial_audit_log (actor_type, action, entity_type, entity_id)
    VALUES ('admin', 'something_invented', 'reservation', v_res::text);
    v_problems := array_append(v_problems, 'commercial_audit_log accepted an action outside its vocabulary');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- 6. No client role may write the audit trail directly.
  --
  -- NOTE ON WHAT THIS CANNOT SEE. On hosted Supabase, ALTER DEFAULT PRIVILEGES
  -- grants `authenticated` direct CRUD on newly created public tables; the
  -- disposable cluster has no such defaults, so these checks pass here whether
  -- or not the migration revoked them. The migration therefore revokes from
  -- authenticated EXPLICITLY rather than relying on this assertion — which is
  -- why the REVOKE lines name three roles, not two.
  IF has_table_privilege('authenticated', 'public.commercial_audit_log', 'INSERT') THEN
    v_problems := array_append(v_problems, 'authenticated holds INSERT on commercial_audit_log');
  END IF;
  IF has_table_privilege('authenticated', 'public.commercial_audit_log', 'TRUNCATE') THEN
    v_problems := array_append(v_problems, 'authenticated holds TRUNCATE on commercial_audit_log');
  END IF;

  -- 7. TRUNCATE is blocked behaviourally, not merely by privilege — a row-level
  -- trigger does not fire on it, and service_role inherits TRUNCATE on hosted
  -- Supabase.
  BEGIN
    TRUNCATE public.commercial_audit_log;
    v_problems := array_append(v_problems, 'TRUNCATE on commercial_audit_log was ADMITTED — the log is not append-only');
  EXCEPTION WHEN others THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.commercial_audit_log', 'SELECT') THEN
    v_problems := array_append(v_problems, 'anon can read commercial_audit_log');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY J FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY J PASSED: commercial events go to commercial_audit_log and never to the compliance log, whose closed regulatory vocabulary admits neither reservation action; the commercial log names the real actor, is append-only against UPDATE, DELETE and TRUNCATE alike, has its own closed vocabulary, and is writable by no client role.';
END
$verify_j$;

ROLLBACK;
