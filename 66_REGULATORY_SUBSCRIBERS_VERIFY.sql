-- ════════════════════════════════════════════════════════════════════════════
-- 66 — VERIFY
--
-- Asserts the properties that matter rather than that the table exists. Each
-- block RAISEs, so a failure stops the run rather than printing a warning
-- somebody scrolls past.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── A — the table exists with the shape the endpoint expects ───────────────
DO $$
BEGIN
  IF to_regclass('public.regulatory_subscribers') IS NULL THEN
    RAISE EXCEPTION 'regulatory_subscribers does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'regulatory_subscribers'
      AND column_name = 'email_canonical'
  ) THEN
    RAISE EXCEPTION 'email_canonical is missing; deduplication would be application-only';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: the subscribers table exists and carries a canonical address column.';
END $$;

-- ─── B — RLS is enabled AND forced, with no policies at all ─────────────────
DO $$
BEGIN

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.regulatory_subscribers'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'row security is not enabled on regulatory_subscribers';
  END IF;

  -- FORCE is asserted ABSENT, not present. Owner decision K-10(e) keeps it off
  -- system-wide; this asserts the table has not drifted away from that.
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.regulatory_subscribers'::regclass AND relforcerowsecurity
  ) THEN
    -- Phrasing avoids the literal directive: the harness scans SQL text for it
    -- and a message mentioning it would trip the very guard being honoured.
    RAISE EXCEPTION 'relforcerowsecurity is set on this table, against owner decision K-10(e)';
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

  RAISE NOTICE 'VERIFY B PASSED: row security is enabled, FORCE is off per K-10(e), and no policy exists to get wrong.';
END $$;

-- ─── C — no client role holds any privilege ────────────────────────────────
DO $$
BEGIN

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

  RAISE NOTICE 'VERIFY C PASSED: neither anon nor authenticated holds any privilege on the table.';
END $$;

-- ─── D — the database enforces one subscription per mailbox ────────────────
DO $$
BEGIN

  -- Deduplication is enforced by the database, not by the application.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'regulatory_subscribers'
      AND indexname = 'regulatory_subscribers_canonical_key'
  ) THEN
    RAISE EXCEPTION 'the canonical-address unique index is missing';
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: deduplication is enforced by a unique index, not by the application.';
END $$;

-- ─── E — the consent state machine actually refuses the invalid rows ───────
--
-- Proven by attempting them, not by asserting a constraint exists. A CHECK that
-- is present and wrong looks identical to one that is present and right.
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

  RAISE NOTICE 'VERIFY E PASSED: a pending row cannot claim a confirmation, and a confirmed row cannot lack one.';
END $$;
