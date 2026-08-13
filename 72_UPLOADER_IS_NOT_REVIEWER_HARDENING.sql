-- ============================================================================
-- 72 — THE PERSON WHO UPLOADS A DOCUMENT MAY NOT BE THE PERSON WHO CLEARS IT.
-- ============================================================================
--
-- WHY THIS EXISTS. The handoff's Governance page (§11) claimed, in public, that
-- "uploader and reviewer can never be the same person — enforced in the
-- database, not the interface". Measured against production on 2026-08-13 that
-- was false, and not merely unenforced: `farmer_documents` records `uploaded_at`
-- and has NO `uploaded_by` COLUMN AT ALL. The comparison could not be made. No
-- function referenced both an uploader and a reviewer; no CHECK encoded it.
--
-- The claim was therefore NOT published — the page ships narrower copy that the
-- schema does support. This migration is what would make the stronger claim
-- true. The copy change belongs in a separate PR, merged only once this is
-- applied and verified in production; publishing it first republishes a false
-- statement on the page whose whole purpose is to be relied upon.
--
-- WHAT IT DOES
--   1. Adds `uploaded_by uuid` — nullable, mirroring how `reviewed_by` is held.
--   2. Stamps it from the SESSION on INSERT, never from the caller.
--   3. Refuses a decision recorded by the uploader, as a CHECK.
--
-- WHY THE SESSION AND NOT THE CALLER. `recordCoaDocument` in src/lib/db.ts
-- inserts through PostgREST from the browser. A client-supplied uploader is a
-- value the client chooses, and a separation-of-duties control whose input the
-- controlled party supplies controls nothing. The trigger OVERWRITES whatever
-- arrives, which is exactly what fn_farmer_documents_set_reviewer already does
-- for `reviewed_by`. The application needs no change and must NOT start sending
-- the column.
--
-- WHY A CHECK RATHER THAN A CHANGE TO THE DECISION GATE. Modifying
-- enforce_evidence_decision_gate would mean replacing a live function on the
-- table that carries the evidence chain. An earlier draft of 68 replaced a
-- function, broke staging, and was caught only by the harness catalog hash. A
-- CHECK adds a constraint and touches no existing function, so the blast radius
-- on the decision path is zero.
--
-- WHY THE CHECK SEES THE RIGHT VALUE. `set_reviewer` is a BEFORE UPDATE ROW
-- trigger that assigns `NEW.reviewed_by := auth.uid()`. BEFORE-row triggers run
-- to completion before constraints are evaluated, so by the time this CHECK is
-- tested `reviewed_by` already holds the DECIDING session, not whatever the
-- caller sent. The constraint therefore compares the uploader against the person
-- actually taking the decision.
--
-- WHAT THIS DOES NOT DO, so it is not credited with more than it achieves:
--
--   * IT DOES NOT ATTRIBUTE HISTORICAL ROWS. Every row that exists before this
--     applies has `uploaded_by IS NULL`, and nothing in `farmer_documents`
--     records who uploaded them. They may still be cleared by anyone. Whether
--     they can be backfilled at all depends on `storage.objects.owner`, which
--     `ddp_ro` may not read — the probe is in the owner package accompanying
--     this migration. UNTIL THAT IS SETTLED THE PUBLIC CLAIM IS TRUE ONLY OF
--     DOCUMENTS UPLOADED AFTER THIS APPLY DATE, and the copy must say so or say
--     nothing.
--
--   * IT TOLERATES A NULL UPLOADER rather than refusing the INSERT. `auth.uid()`
--     is NULL outside a request context — psql, a maintenance script, and
--     scripts/redblue-65-document-review.sql, which seeds documents as
--     superuser. Refusing would break those. The cost is that the NULL branch is
--     a hole a privileged path could drive through, which is why it is named
--     here rather than left for someone to find. Tightening it to a refusal is
--     a one-line change to the trigger and is the owner's call.
--
-- ROLLBACK: 72_UPLOADER_IS_NOT_REVIEWER_ROLLBACK.sql
-- VERIFY:   72_UPLOADER_IS_NOT_REVIEWER_VERIFY.sql — runnable as ddp_ro on a
--           separate connection, so verification never depends on the role that
--           applied the change.
-- ============================================================================

BEGIN;

-- ── 1. The column ───────────────────────────────────────────────────────────
-- Nullable, exactly as `reviewed_by` is. A NOT NULL here would require a
-- backfill value for every historical row, and inventing one would be a
-- fabricated attribution on the chain-of-custody table.
ALTER TABLE public.farmer_documents
  ADD COLUMN IF NOT EXISTS uploaded_by uuid;

COMMENT ON COLUMN public.farmer_documents.uploaded_by IS
  'The session that inserted this document, stamped by farmer_documents_set_uploaded_by. '
  'NULL for rows predating migration 72 and for inserts outside a request '
  'context. Compared against reviewed_by by document_uploader_is_not_reviewer.';

-- ── 2. Stamp it from the session ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_document_uploaded_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $fn$
BEGIN
  -- Overwrite, never coalesce. A caller that sends its own uploader is either
  -- mistaken or forging one, and both are answered the same way.
  NEW.uploaded_by := auth.uid();
  RETURN NEW;
END;
$fn$;

-- Trigger functions are invoked by the trigger, never by a caller, so nobody
-- holds EXECUTE. Stated explicitly rather than left to the default, because the
-- PostgreSQL default is EXECUTE to PUBLIC — and this one is SECURITY DEFINER,
-- so a caller holding EXECUTE could run it with the owner's rights.
-- acl-no-grant: set_document_uploaded_by
REVOKE EXECUTE ON FUNCTION public.set_document_uploaded_by() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_document_uploaded_by() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_document_uploaded_by() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.set_document_uploaded_by() FROM service_role;

DROP TRIGGER IF EXISTS farmer_documents_set_uploaded_by ON public.farmer_documents;
CREATE TRIGGER farmer_documents_set_uploaded_by
  BEFORE INSERT ON public.farmer_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_document_uploaded_by();

-- ── 3. The separation ───────────────────────────────────────────────────────
-- Mirrors review_decision_requires_reviewer in shape: pending rows are exempt
-- because a pending row has no decision to attribute.
--
-- NOT VALID, deliberately. Existing rows all carry uploaded_by IS NULL and so
-- would satisfy this anyway, but NOT VALID keeps the ALTER from taking a full
-- table scan under an ACCESS EXCLUSIVE lock on the evidence register. VALIDATE
-- runs separately, below, where it takes only a SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE public.farmer_documents
  ADD CONSTRAINT document_uploader_is_not_reviewer
  CHECK (
    review_status = 'pending'
    OR uploaded_by IS NULL
    OR uploaded_by <> reviewed_by
  ) NOT VALID;

ALTER TABLE public.farmer_documents
  VALIDATE CONSTRAINT document_uploader_is_not_reviewer;

-- ── 4. THE DELETION RECORD DOES NOT CARRY THE UPLOADER, AND THAT IS A GAP ───
-- An earlier draft of this migration added `uploaded_by` to
-- farmer_document_deletions. It was removed before this shipped, because the
-- column would never have been written: `record_document_deletion` is migration
-- 69's function and its INSERT names its columns explicitly, so a new column on
-- the table is simply skipped. The result would have been a column that exists,
-- reads NULL forever, and a VERIFY section asserting its presence — false
-- assurance, which is worse than the gap it pretended to close.
--
-- Populating it means REPLACING 69's function, which is precisely the move this
-- migration refuses elsewhere and which a rollback would then have to restore
-- byte-for-byte. That is its own migration, deliberately scoped, with 69's body
-- captured first. Recorded here so it is a known gap rather than a discovery:
-- DELETING A DOCUMENT STILL LOSES WHO UPLOADED IT.

-- ── 5. Record the apply, in the ledger 67 created ───────────────────────────
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Apply 67 (the migrations ledger) before this migration.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.schema_migrations (number, name, applied_at, applied_by, evidence)
  VALUES (72, 'UPLOADER_IS_NOT_REVIEWER', now(), current_user, 'self-recorded')
  ON CONFLICT (number) DO UPDATE
    SET applied_at = excluded.applied_at,
        applied_by = excluded.applied_by,
        evidence   = 'self-recorded'
    WHERE public.schema_migrations.evidence LIKE 'backfilled%';
END
$ledger$;

COMMIT;
