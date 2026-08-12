-- 67_MIGRATIONS_LEDGER_HARDENING.sql
--
-- WHAT THIS CLOSES.
--
-- On 2026-08-11 migration 66 (now 68) was reported applied to production three times.
-- Each time production was unchanged: no table, no trigger, no function, in any
-- schema. No error was seen by the person applying it. The only reason this was
-- caught is that someone happened to hold a read-only credential and knew the
-- names of the objects to probe for.
--
-- That is the actual defect. Not the SQL, which applied cleanly to staging
-- three times — the fact that "did it apply?" was a question answered by a
-- human recollection of a dashboard, and could only be checked by someone who
-- already knew what to look for.
--
-- The Supabase SQL editor runs the SELECTED text when a selection exists, so a
-- long file, a stray click and a scroll produce a green "success" for a fragment
-- of a migration. Nothing about that is visible afterwards.
--
-- THE FIX IS ONE RULE: every migration's LAST statement records itself here,
-- inside its own transaction. That makes the failure impossible to hide:
--
--   · the transaction rolls back            -> no row
--   · only part of the file was executed    -> the insert is never reached, no row
--   · it went to the wrong database         -> the row lands THERE, and this one
--                                              still shows nothing
--
-- "What is on this database" becomes one query that returns the same answer for
-- everyone who asks it.
--
-- READABLE BY THE READ-ONLY ROLE, DELIBERATELY. The verification that failed
-- failed because it depended on the person who had just done the applying. This
-- table holds migration numbers and names — nothing sensitive — so it is
-- readable by anyone who can reach the database at all, and an auditor can
-- confirm the state without asking the operator.
--
-- THIS FILE NEARLY SHIPPED UNDER A STOLEN NUMBER, WHICH IS WORTH RECORDING.
-- It was written as migration 62 on the reasoning that 62 was "a genuine gap,
-- free since numbering began". It was not: `feat/rule-condition-evaluator`
-- claimed 62 on 2026-08-07, and `feat/regulatory-subscribe` claimed 66 — the
-- number its companion migration was using — on 2026-08-09. Both were found by
-- CI's AUDIT-001 collision check, which had been failing on the first run of the
-- branch and which nobody had read.
--
-- So a ledger written to stop a migration being applied under a false identity
-- was itself about to be applied under one. The rule caught its own author, and
-- the same check that caught it is the reason the numbers here are 67 and 68.
--
-- The lesson is not "check the numbers". It is that `main` and the local
-- worktrees are not the claim space: every number from 3 to 66 is claimed on
-- some unmerged branch. Only an all-refs query sees that, and the answer has to
-- arrive somewhere a person is already looking.

BEGIN;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  number      integer PRIMARY KEY,
  name        text NOT NULL,

  -- NULL means this ledger did not witness the apply. Backfilled rows leave it
  -- null rather than inventing a plausible timestamp: a fabricated time in an
  -- audit table is worse than an absent one, and standing rule 5 says absent is
  -- absent.
  applied_at  timestamptz,
  applied_by  text,
  database    text NOT NULL DEFAULT current_database(),

  -- How this row knows what it claims. Two values in practice:
  --   'self-recorded'  — written by the migration itself as its final statement
  --   'backfilled …'   — inferred on 2026-08-12 from an object that exists
  -- A backfilled row is a WEAKER claim than a self-recorded one and must not be
  -- read as equivalent. It says "the thing this migration creates is present",
  -- not "this migration ran here, then, by that person".
  evidence    text NOT NULL,

  CONSTRAINT schema_migrations_evidence_stated
    CHECK (btrim(evidence) <> ''),

  -- A self-recorded row knows when and by whom. A backfilled one knows neither.
  -- Enforcing the pairing stops a future edit quietly upgrading a guess.
  CONSTRAINT schema_migrations_self_recorded_is_witnessed
    CHECK (
      evidence <> 'self-recorded'
      OR (applied_at IS NOT NULL AND applied_by IS NOT NULL)
    )
);

COMMENT ON TABLE public.schema_migrations IS
  'What has been applied to THIS database. Every migration records itself as its '
  'final statement, inside its own transaction, so a partial or misdirected apply '
  'leaves no row. Readable by any role that can reach the database, on purpose: '
  'verification must not depend on the person who did the applying.';

COMMENT ON COLUMN public.schema_migrations.evidence IS
  'self-recorded = written by the migration itself. backfilled = inferred from an '
  'object that exists. The second is a weaker claim and applied_at/applied_by are '
  'null for it.';

-- Append-only in the directions that matter. A number may be corrected (a name
-- typo), but a record of an apply must not be deleted, and the table must not be
-- emptied — an audit trail that can be cleared is not one.
CREATE OR REPLACE FUNCTION public.refuse_schema_migration_removal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'public.schema_migrations records what was applied; rows are not removable.'
    USING ERRCODE = 'check_violation';
END;
$$;


-- Trigger functions are invoked by the trigger, never by a caller, so nobody
-- holds EXECUTE. Stated explicitly rather than left to the default, because the
-- PostgreSQL default is EXECUTE to PUBLIC.
-- acl-no-grant: refuse_schema_migration_removal
REVOKE EXECUTE ON FUNCTION public.refuse_schema_migration_removal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_schema_migration_removal() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refuse_schema_migration_removal() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refuse_schema_migration_removal() FROM service_role;

DROP TRIGGER IF EXISTS schema_migrations_no_delete ON public.schema_migrations;
CREATE TRIGGER schema_migrations_no_delete
  BEFORE DELETE ON public.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION public.refuse_schema_migration_removal();

DROP TRIGGER IF EXISTS schema_migrations_no_truncate ON public.schema_migrations;
CREATE TRIGGER schema_migrations_no_truncate
  BEFORE TRUNCATE ON public.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_schema_migration_removal();

-- Universally readable, writable by nobody through the API. Migrations run as a
-- privileged role and are unaffected by these grants.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "schema_migrations: readable by all" ON public.schema_migrations;
CREATE POLICY "schema_migrations: readable by all"
  ON public.schema_migrations
  FOR SELECT
  USING (true);

REVOKE ALL ON public.schema_migrations FROM anon;
GRANT SELECT ON public.schema_migrations TO authenticated;
DO $grant$
BEGIN
  -- The read-only auditing role is the whole point; it may not exist on every
  -- database (staging, a disposable CI instance), so its absence is not fatal.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddp_ro') THEN
    EXECUTE 'GRANT SELECT ON public.schema_migrations TO ddp_ro';
  ELSE
    RAISE NOTICE 'Role ddp_ro does not exist here; skipping its grant.';
  END IF;
END
$grant$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill — by PROBE, never by assertion.
-- ─────────────────────────────────────────────────────────────────────────────
-- Each row below is inserted only if the object that migration creates actually
-- exists on THIS database. Nothing is claimed about history: applied_at and
-- applied_by stay null, and `evidence` names the object that was found.
--
-- This is deliberately incomplete. Only migrations with an unambiguous, probeable
-- artefact are listed; the rest are absent from the ledger rather than guessed
-- at, and absence here means "unknown", not "not applied". Forward from 67,
-- every migration records itself and the ledger becomes exact.
INSERT INTO public.schema_migrations (number, name, evidence)
SELECT 63, 'STATUS_HISTORY_APPEND_ONLY',
       'backfilled 2026-08-12: a status_history append-only trigger exists'
WHERE EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE '%status_history%')
ON CONFLICT (number) DO NOTHING;

INSERT INTO public.schema_migrations (number, name, evidence)
SELECT 64, 'DOCUMENT_REVIEW_ATTRIBUTION',
       'backfilled 2026-08-12: trigger farmer_documents_set_reviewer exists'
WHERE EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'farmer_documents_set_reviewer')
ON CONFLICT (number) DO NOTHING;

INSERT INTO public.schema_migrations (number, name, evidence)
SELECT 65, 'DOCUMENT_REVIEW_CLARIFICATION',
       'backfilled 2026-08-12: table farmer_document_reviews exists'
WHERE to_regclass('public.farmer_document_reviews') IS NOT NULL
ON CONFLICT (number) DO NOTHING;

INSERT INTO public.schema_migrations (number, name, evidence)
SELECT 68, 'EVIDENCE_DECISION_GATE',
       'backfilled 2026-08-12: table farmer_document_opens exists'
WHERE to_regclass('public.farmer_document_opens') IS NOT NULL
ON CONFLICT (number) DO NOTHING;

-- This migration records itself, by the rule it exists to establish.
INSERT INTO public.schema_migrations (number, name, applied_at, applied_by, evidence)
VALUES (67, 'MIGRATIONS_LEDGER', now(), current_user, 'self-recorded')
ON CONFLICT (number) DO NOTHING;

COMMIT;
