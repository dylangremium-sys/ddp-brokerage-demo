-- ===========================================================================
-- 36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql
-- ---------------------------------------------------------------------------
-- Moves the public supplier-intake write off the browser→Supabase path and
-- behind a rate-limited server function, closing audit finding R5.
--
-- STATUS — BY ENVIRONMENT (never state "applied" without naming the environment):
--   • Repository : committed, awaiting review.
--   • STAGING    : NOT applied. NOT run.
--   • PRODUCTION : NOT applied. NOT run. NOT deployed. A production change freeze
--                  is active (docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md); this
--                  migration is NOT part of any authorised break-glass change.
--
-- *** ORDERING PRECONDITION — READ THIS FIRST ***
-- ------------------------------------------------------------------------
-- This migration REVOKES the anon INSERT that the public form currently relies
-- on. Applying it before /api/public/access-request is deployed AND configured
-- takes the supplier intake form offline.
--
-- Required order, no exceptions:
--   1. Deploy the application carrying api/public/access-request.ts.
--   2. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel Production.
--      As of 2026-07-28 SUPABASE_SERVICE_ROLE_KEY is NOT set (audit R1) — the
--      same missing variable that has /api/admin/provision-farmer returning 500.
--   3. Confirm the endpoint accepts a submission end to end.
--   4. Only then apply this migration.
-- See docs/runbooks/P1_SET_SUPABASE_SERVICE_ROLE_KEY.md.
--
-- WHY (audit finding R5)
-- ----------------------
-- `farmer_access_requests: public submit` is the ONLY anon-satisfiable write
-- policy in production (measured across all 72 policies, 2026-07-28). `anon`
-- holds table-level INSERT, and the publishable key is by design in the public
-- JS bundle. Any party can insert unlimited rows: per-row size is bounded by the
-- column CHECKs (~2.5 KB), the row count is not.
--
-- Migration 34's own note says "rate limiting belongs at the edge"
-- (34_...:26). That mitigation is UNREACHABLE as designed: the write goes
-- browser → Supabase directly and never traverses Vercel, so no Vercel WAF rule,
-- and no edge middleware, can see it. The only way to make edge rate limiting
-- real is to move the write onto a path that goes through Vercel — which is what
-- this migration and its companion function do.
--
-- OPTION (a) WAS CHOSEN, and why
-- ------------------------------
-- (a) route submission through a Vercel Function, then revoke the anon INSERT.
-- (b) keep the direct path and add a Supabase-side throttle.
--
-- (b) cannot be made to work honestly here. A Supabase-side throttle would have
-- to be enforced in a trigger or policy, and the only per-caller identity
-- available on an anon insert is... nothing. There is no session, no user id, and
-- the client IP is not exposed to Postgres through PostgREST. A throttle keyed on
-- a client-supplied value is a throttle the client can defeat by changing that
-- value. (b) can only bound TOTAL insert rate, which converts an abuse problem
-- into a denial-of-service one: a flooder would lock out every legitimate
-- supplier. So (a).
--
-- WHAT
--   • public.public_intake_attempts — the throttle ledger the server function
--     reads and writes. Holds a SALTED HASH of the client IP, never the IP.
--   • Revokes INSERT on public.farmer_access_requests from anon AND authenticated.
--   • Replaces the anon/authenticated INSERT policy with a service_role one.
--
-- WHAT IS DELIBERATELY NOT DONE
--   • No DELETE policy is added to farmer_access_requests. Migration 34's
--     "deliberately NO delete policy" stands: an enquiry is a record of who asked
--     for access. Spam is dispositioned with status='declined'/'duplicate'
--     through the existing `admin triage` UPDATE policy, which this migration
--     leaves exactly as it is.
--   • The `admin read` and `admin triage` policies are untouched.
--   • The stamp trigger is untouched.
--
-- PRIVACY
--   • public_intake_attempts stores sha256(ip || ':' || salt), never the address.
--     The salt is a server-only environment value. This is pseudonymisation for
--     abuse control, not a secrecy claim: anyone holding both the salt and a
--     candidate IP can confirm a match. That is the accepted, documented bound.
--   • Rows are purgeable — see the retention note on the table.
--
-- SAFETY
--   • The revoke is the only privilege reduction, and it is reversible
--     (36_..._ROLLBACK.sql restores migration 34's exact policy and grant).
--   • Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS).
--
-- MIGRATION NUMBER
-- ----------------
-- 36. See docs/MIGRATION_NUMBER_REGISTER.md — 27/28 are claimed by PRs #44/#73
-- and 31/32/33 by the local branch feature/coa-source-bound-watchtower-review.
-- 35 is this remediation's atomic status transition.
--
-- Verify:   36_FARMER_ACCESS_REQUEST_INTAKE_VERIFY.sql
-- Rollback: 36_FARMER_ACCESS_REQUEST_INTAKE_ROLLBACK.sql
-- ===========================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.farmer_access_requests') IS NULL THEN
    RAISE EXCEPTION 'migration 36 precondition failed: public.farmer_access_requests is missing (apply migration 34 first)';
  END IF;
END
$precondition$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. The throttle ledger.
--
-- One row per accepted submission attempt. The server function counts rows in
-- the window before deciding, then appends. Deliberately append-only in shape:
-- there is nothing to update.
--
-- RETENTION: rows older than the longest window are dead weight. They carry no
-- reference to the request they throttled and can be deleted freely:
--   DELETE FROM public.public_intake_attempts WHERE occurred_at < now() - interval '7 days';
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.public_intake_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- sha256(client_ip || ':' || salt), hex. NEVER the address itself. Length-capped
  -- because this is written from a public-facing path.
  bucket_key   TEXT NOT NULL CHECK (length(bucket_key) BETWEEN 16 AND 128),

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only query shape the throttle runs: "attempts for this bucket since T".
CREATE INDEX IF NOT EXISTS idx_public_intake_attempts_bucket
  ON public.public_intake_attempts (bucket_key, occurred_at DESC);
-- ...and the retention sweep above.
CREATE INDEX IF NOT EXISTS idx_public_intake_attempts_occurred
  ON public.public_intake_attempts (occurred_at);

ALTER TABLE public.public_intake_attempts ENABLE ROW LEVEL SECURITY;

-- Supabase's baseline ALTER DEFAULT PRIVILEGES grants client roles CRUD on new
-- public tables. Revoke explicitly: a throttle a client can read is a throttle a
-- client can plan around, and one a client can write is no throttle at all.
REVOKE ALL ON public.public_intake_attempts FROM anon;
REVOKE ALL ON public.public_intake_attempts FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.public_intake_attempts TO service_role;

-- service_role holds BYPASSRLS, so this policy is not what admits it. It exists
-- so the table is not RLS-enabled-with-no-policy — a shape that reads as an
-- oversight, and which the close-of-freeze sweep counts (freeze §4 G2.1) — and
-- so the intended reachability is stated in the catalog rather than implied.
DROP POLICY IF EXISTS "public_intake_attempts: service role only" ON public.public_intake_attempts;
CREATE POLICY "public_intake_attempts: service role only" ON public.public_intake_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.public_intake_attempts IS
  'Rate-limit ledger for the public supplier intake (migration 36, audit R5). '
  'bucket_key is a salted sha256 of the client IP, never the address. Written only '
  'by /api/public/access-request via service_role. Rows older than the longest '
  'throttle window may be deleted at any time.';

-- ---------------------------------------------------------------------------
-- 2. Close the direct browser → Supabase write path.
--
-- Both halves are required. Dropping the policy alone leaves the table-level
-- INSERT grant in place (harmless today, but it re-opens the moment any other
-- permissive INSERT policy is added); revoking the grant alone leaves a policy
-- that reads as though anon submission is still intended.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "farmer_access_requests: public submit" ON public.farmer_access_requests;

CREATE POLICY "farmer_access_requests: server submit" ON public.farmer_access_requests
  FOR INSERT TO service_role
  WITH CHECK (
    -- Unchanged from migration 34: a submission may only create a NEW,
    -- unreviewed request. It cannot arrive pre-approved and cannot name a
    -- reviewer. The server function is trusted to rate-limit, not to grade.
    status = 'new'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note = ''
  );

REVOKE INSERT ON public.farmer_access_requests FROM anon;
REVOKE INSERT ON public.farmer_access_requests FROM authenticated;

-- NOTE: SELECT/UPDATE/DELETE table grants on farmer_access_requests are left
-- exactly as Supabase's baseline set them. They are not what authorises access —
-- the `admin read` and `admin triage` policies are, and both are untouched.
-- Narrowing them here would be scope creep into migrations 14/15's territory.

COMMIT;
