-- ════════════════════════════════════════════════════════════════════════════
-- 66 — VERIFY
--
-- Asserts the properties that matter rather than that the table exists. Each
-- block RAISEs, so a failure stops the run rather than printing a warning
-- somebody scrolls past.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.regulatory_subscribers') IS NULL THEN
    RAISE EXCEPTION 'regulatory_subscribers does not exist';
  END IF;

  -- RLS enabled AND forced. Forced matters: without it the table owner bypasses
  -- row security, and the owner is who migrations run as.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.regulatory_subscribers'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled and forced on regulatory_subscribers';
  END IF;

  -- No policies at all is the intent: with RLS on and no policy, every client
  -- role is denied and only the service role reaches the table. A policy
  -- appearing here means somebody granted access that was never designed for.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'regulatory_subscribers'
  ) THEN
    RAISE EXCEPTION 'regulatory_subscribers has policies; it is meant to have none';
  END IF;

  -- anon and authenticated must hold no privilege whatsoever.
  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'regulatory_subscribers'
      AND grantee IN ('anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'anon or authenticated holds a grant on regulatory_subscribers';
  END IF;

  -- Deduplication is enforced by the database, not by the application.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'regulatory_subscribers'
      AND indexname = 'regulatory_subscribers_canonical_key'
  ) THEN
    RAISE EXCEPTION 'the canonical-address unique index is missing';
  END IF;
END $$;

-- The state machine must reject an unconfirmed row that claims a confirmation
-- time, and a confirmed row that has none. Proven by rollback, not asserted.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.regulatory_subscribers
      (email, email_canonical, status, confirm_token, unsubscribe_token, consent_text, confirmed_at)
    VALUES
      ('x@example.com', 'x@example.com', 'pending', repeat('a', 43), repeat('b', 43),
       'I agree to receive regulatory updates.', now());
    RAISE EXCEPTION 'a pending row was allowed to carry a confirmation timestamp';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- expected
  END;

  BEGIN
    INSERT INTO public.regulatory_subscribers
      (email, email_canonical, status, confirm_token, unsubscribe_token, consent_text)
    VALUES
      ('y@example.com', 'y@example.com', 'confirmed', repeat('c', 43), repeat('d', 43),
       'I agree to receive regulatory updates.');
    RAISE EXCEPTION 'a confirmed row was allowed with no confirmation timestamp';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- expected
  END;
END $$;
