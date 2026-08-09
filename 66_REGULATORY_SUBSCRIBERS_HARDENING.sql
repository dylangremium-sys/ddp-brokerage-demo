-- ════════════════════════════════════════════════════════════════════════════
-- 66 — Regulatory update subscribers
--
-- WRITTEN, NOT APPLIED. This migration is committed so it can be reviewed
-- before it touches a database. Nothing in the application depends on the table
-- existing yet: the endpoint fails closed, and the form is not rendered until
-- the subscription flow is switched on.
--
-- WHY A TABLE AT ALL, AND WHY THIS SHAPE
--   Regulatory updates already have a channel that needs no personal data: the
--   RSS feed. This is for readers who want the update to arrive rather than to
--   be fetched, which means holding an email address, which means consent.
--
--   The consent model is DOUBLE OPT-IN. An address is stored `pending` and
--   nothing is ever sent to it except one confirmation message; only a click on
--   the link in that message moves it to `confirmed`. Germany is the largest
--   target market and applies the strictest reading of consent for commercial
--   email in the EU — single opt-in is the practice that generates complaints
--   there, and an unconfirmed address is a liability rather than an asset.
--
-- WHAT IS DELIBERATELY NOT STORED
--   No name, no company, no role, no country, no IP address, no user agent.
--   A subscription needs an address and evidence of consent; everything else is
--   data that would have to be justified, protected, disclosed on request and
--   deleted on request. The cheapest way to hold personal data safely is to
--   hold less of it.
--
--   The confirmation IP is hashed, never stored raw — see the column comment.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.regulatory_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Shape-checked only. Real validation is the confirmation arriving.
  email TEXT NOT NULL
    CHECK (length(email) BETWEEN 5 AND 254
           AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- The canonical form the application deduplicates on: lower-cased, and for
  -- gmail-style providers dots and +tags removed. Held separately from `email`
  -- so the address a person typed is what any message is addressed to, while
  -- two spellings of one mailbox cannot become two subscriptions.
  email_canonical TEXT NOT NULL
    CHECK (length(email_canonical) BETWEEN 5 AND 254),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),

  -- Opaque, single-purpose, and rotated on every state change so a link that
  -- has been used, forwarded or logged cannot be replayed.
  confirm_token TEXT NOT NULL
    CHECK (length(confirm_token) BETWEEN 32 AND 128),

  unsubscribe_token TEXT NOT NULL
    CHECK (length(unsubscribe_token) BETWEEN 32 AND 128),

  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,

  -- EVIDENCE OF CONSENT, which is the point of double opt-in. A salted hash of
  -- the address that clicked confirm — enough to show a distinct party acted,
  -- never enough to identify or re-identify them, and useless if the table
  -- leaks because the salt lives in the environment and not in the database.
  confirmed_ip_hash TEXT
    CHECK (confirmed_ip_hash IS NULL OR length(confirmed_ip_hash) = 64),

  -- The wording consented to, so a later change to the sign-up copy cannot
  -- retroactively alter what a subscriber agreed to.
  consent_text TEXT NOT NULL
    CHECK (length(consent_text) BETWEEN 10 AND 500),

  -- A confirmed subscription cannot pretend it was never confirmed, and an
  -- unconfirmed one cannot claim a confirmation timestamp.
  CONSTRAINT regulatory_subscribers_status_timestamps CHECK (
    (status = 'pending'      AND confirmed_at IS NULL) OR
    (status = 'confirmed'    AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL) OR
    (status = 'unsubscribed' AND unsubscribed_at IS NOT NULL)
  )
);

-- One subscription per mailbox, however it was spelled.
CREATE UNIQUE INDEX IF NOT EXISTS regulatory_subscribers_canonical_key
  ON public.regulatory_subscribers (email_canonical);

-- Tokens are looked up on every confirm and unsubscribe click.
CREATE UNIQUE INDEX IF NOT EXISTS regulatory_subscribers_confirm_token_key
  ON public.regulatory_subscribers (confirm_token);
CREATE UNIQUE INDEX IF NOT EXISTS regulatory_subscribers_unsubscribe_token_key
  ON public.regulatory_subscribers (unsubscribe_token);

COMMENT ON TABLE public.regulatory_subscribers IS
  'Double opt-in subscribers to the regulatory updates feed. Written by the '
  'public endpoint under the service role only; no client role may read or '
  'write it. Holds an address and evidence of consent, and nothing else.';

COMMENT ON COLUMN public.regulatory_subscribers.confirmed_ip_hash IS
  'sha256(ip || PUBLIC_INTAKE_IP_SALT). Never the raw address. Sufficient to '
  'evidence that a distinct party confirmed; insufficient to identify them.';

-- ─── RLS: nothing reaches this table except the service role ────────────────
--
-- No policies are created. With RLS enabled and no policy, every client role —
-- anon and authenticated alike — is denied, and only the service role used by
-- the serverless endpoint can read or write. That is stricter than a policy
-- that happens to evaluate false, because there is no predicate to get wrong.
ALTER TABLE public.regulatory_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regulatory_subscribers FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.regulatory_subscribers FROM anon, authenticated;

COMMIT;
