-- Destructive-guard seed for the 17_procurement_decisions fixture.
--
-- Migration 17's guard refuses to drop procurement_decisions while any decision
-- exists, because that table is the append-only record of who authorised each
-- buyer-pack release — and, per the guard's own message, the trail migration 23
-- reads to authorise future issuance. A guard that has never been shown a row
-- cannot be shown to refuse.
--
-- `decided_by` is NOT NULL with DEFAULT auth.uid(). On a disposable cluster there
-- is no authenticated session, so auth.uid() is NULL and relying on the default
-- would fail the NOT NULL rather than test the guard. The actor is therefore
-- resolved explicitly from a real profiles row, whose id the column also
-- references.
DO $seed$
DECLARE
  actor   uuid;
  dec_id  uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: no auth.users row available to act as decider';
  END IF;

  -- The substrate ships auth.users rows but no profiles rows: profiles is
  -- populated by handle_new_user(), which fires on INSERT to auth.users and so
  -- never ran for rows the bootstrap created directly. The FK therefore has to
  -- be satisfied here. ON CONFLICT DO NOTHING because a later substrate change
  -- adding profiles rows must not turn this seed into a duplicate-key failure.
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (actor, 'fixture17@example.test', 'Fixture Decider', 'ddp_admin')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by)
  VALUES ('fixture-batch-17', 'progress',
          'Fixture decision recorded so migration 17 rollback guard has data to refuse over.',
          actor)
  RETURNING id INTO dec_id;

  IF dec_id IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: insert produced no row (guard test would be vacuous)';
  END IF;

  RAISE NOTICE 'guard seed: 1 procurement decision created (id=%).', dec_id;
END
$seed$;
