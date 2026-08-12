-- ============================================================================
-- 69 — A DOCUMENT MAY BE DELETED. ITS DELETION MAY NOT GO UNRECORDED.
-- ============================================================================
--
-- WHAT WAS OPEN. Migration 68 gated every way a document could be DECIDED on,
-- and 68's own trigger covers INSERT and UPDATE. Nothing covered DELETE.
-- Production shows `n_tup_del = 2` on farmer_documents: two documents have
-- already been removed, and there is no record anywhere of what they were.
--
-- WHAT WAS ALREADY SAFE, so that this migration is not credited with more than
-- it does. All four foreign keys into farmer_documents are ON DELETE RESTRICT
-- (farmer_document_reviews, farmer_document_opens, document_field_extractions,
-- evidence_request_attachments). A document that has been reviewed, opened,
-- extracted from, or attached to an evidence request therefore CANNOT be
-- deleted — the constraint refuses it. No RLS policy grants DELETE to a farmer.
--
-- So the exposure is narrow and real: an ADMIN can delete an UNDECIDED,
-- NEVER-OPENED document, and its digest goes with it, leaving nothing that says
-- it ever arrived.
--
-- WHY THIS DOES NOT SIMPLY REFUSE. Deleting is sometimes correct: a file
-- uploaded against the wrong farm, or one carrying personal data that should
-- never have been sent. A register that cannot erase anything is not more
-- honest than one that can — it just moves the problem to somebody's inbox.
-- What must never happen is erasure WITHOUT A TRACE. So a deletion is allowed,
-- and is itself made a permanent record: who, when, of what, and why.
--
-- THE REASON ARRIVES BY SESSION SETTING, and that is deliberate. A DELETE
-- statement has nowhere to carry one, so the deleter must set it in the same
-- transaction:
--
--     BEGIN;
--     SET LOCAL ddp.deletion_reason = 'Uploaded against the wrong farm by …';
--     DELETE FROM public.farmer_documents WHERE id = '…';
--     COMMIT;
--
-- Without it the deletion is refused. This is the same rule the decision gate
-- applies to every other consequential act on this table: it names a person and
-- it states a reason.
--
-- Companion files: 69_DOCUMENT_DELETION_RECORD_ROLLBACK.sql, and
-- 69_DOCUMENT_DELETION_RECORD_VERIFY.sql which proves each refusal behaviourally.
-- ============================================================================

BEGIN;

-- ── The record that outlives the document ───────────────────────────────────
--
-- NO FOREIGN KEY to farmer_documents, on purpose: this row exists precisely
-- because that one does not any more. The id is kept as a plain uuid so a
-- deleted document can still be recognised in an audit trail, a storage bucket
-- listing, or a backup taken before the deletion.
CREATE TABLE IF NOT EXISTS public.farmer_document_deletions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  farmer_document_id        uuid        NOT NULL,
  farm_id                   uuid,

  -- Copied from the row as it stood, so the record is legible without joining
  -- to anything that may itself change later.
  document_type             text,
  file_name                 text,
  file_url                  text,
  sha256_hex                character(64),
  review_status_at_deletion text,
  uploaded_at               timestamptz,

  deleted_at                timestamptz NOT NULL DEFAULT now(),
  deleted_by                uuid        NOT NULL,
  reason                    text        NOT NULL,

  CONSTRAINT farmer_document_deletions_reason_is_substantive
    CHECK (length(btrim(reason)) > 9 AND btrim(reason) !~ '^(.)\1*$')
);

COMMENT ON TABLE public.farmer_document_deletions IS
  'Append-only. One row per document removed from the register: who removed it, '
  'when, what it was, and why. Written by a trigger on farmer_documents, not by '
  'the application — so it cannot be skipped by deleting through another route.';

COMMENT ON COLUMN public.farmer_document_deletions.sha256_hex IS
  'The digest the document had when it was deleted. Retaining it is the point: '
  'a file recovered from a backup can be matched against this, and one that '
  'cannot be matched is not the file that was removed.';

COMMENT ON COLUMN public.farmer_document_deletions.farmer_document_id IS
  'Deliberately NOT a foreign key — the referenced row no longer exists.';

CREATE INDEX IF NOT EXISTS farmer_document_deletions_doc_idx
  ON public.farmer_document_deletions (farmer_document_id);
CREATE INDEX IF NOT EXISTS farmer_document_deletions_farm_at_idx
  ON public.farmer_document_deletions (farm_id, deleted_at DESC);

-- ── The record is append-only ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refuse_document_deletion_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'farmer_document_deletions is append-only; a deletion record cannot be altered or removed.'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refuse_document_deletion_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_document_deletion_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refuse_document_deletion_mutation() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refuse_document_deletion_mutation() FROM service_role;

DROP TRIGGER IF EXISTS farmer_document_deletions_no_update_delete ON public.farmer_document_deletions;
CREATE TRIGGER farmer_document_deletions_no_update_delete
  BEFORE UPDATE OR DELETE ON public.farmer_document_deletions
  FOR EACH ROW EXECUTE FUNCTION public.refuse_document_deletion_mutation();

DROP TRIGGER IF EXISTS farmer_document_deletions_no_truncate ON public.farmer_document_deletions;
CREATE TRIGGER farmer_document_deletions_no_truncate
  BEFORE TRUNCATE ON public.farmer_document_deletions
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_document_deletion_mutation();

ALTER TABLE public.farmer_document_deletions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farmer_document_deletions: admin read" ON public.farmer_document_deletions;
CREATE POLICY "farmer_document_deletions: admin read"
  ON public.farmer_document_deletions
  FOR SELECT
  USING (public.is_ddp_admin());

REVOKE ALL ON public.farmer_document_deletions FROM anon;
GRANT SELECT ON public.farmer_document_deletions TO authenticated;
DO $grant$
BEGIN
  -- The read-only auditing role must be able to see what was removed; that is
  -- the entire purpose of keeping the record.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddp_ro') THEN
    EXECUTE 'GRANT SELECT ON public.farmer_document_deletions TO ddp_ro';
  ELSE
    RAISE NOTICE 'Role ddp_ro does not exist here; skipping its grant.';
  END IF;
END
$grant$;

-- ── The gate itself ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  actor  uuid := auth.uid();
  reason text := nullif(btrim(coalesce(current_setting('ddp.deletion_reason', true), '')), '');
BEGIN
  -- A deletion names a person, for the same reason a decision does: a register
  -- entry that says only "this was removed" is not a record, it is a rumour.
  IF actor IS NULL THEN
    RAISE EXCEPTION
      'A document cannot be deleted without an authenticated session. Delete it as the person accountable for the deletion.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The reason cannot ride on the DELETE statement, so it is taken from the
  -- transaction. Same floor as every other reason on this table.
  IF NOT public.evidence_reason_is_substantive(reason) THEN
    RAISE EXCEPTION
      'A deletion needs a stated reason. Set it in the same transaction: SET LOCAL ddp.deletion_reason = ''why this document is being removed'';'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The digest is read through to_jsonb rather than as OLD.sha256_hex, because
  -- that column arrived in a later migration than farmer_documents itself and
  -- is not present on every cluster this corpus has to apply cleanly to.
  -- Naming it directly makes the TRIGGER — not merely a test — raise
  -- "record old has no field sha256_hex" and take the whole DELETE down with
  -- it, on any database that predates the column. Caught by the disposable-PG
  -- harness, which runs against exactly such a cluster; it would have applied
  -- perfectly against production and been a live landmine anywhere else.
  --
  -- A NULL digest is a legal outcome and is recorded as one: "the digest as it
  -- stood" includes "there was none", which this product reports rather than
  -- hides. Same rule as set_review_digest() in 68.
  INSERT INTO public.farmer_document_deletions (
    farmer_document_id, farm_id, document_type, file_name, file_url,
    sha256_hex, review_status_at_deletion, uploaded_at, deleted_by, reason
  ) VALUES (
    OLD.id, OLD.farm_id, OLD.document_type, OLD.file_name, OLD.file_url,
    to_jsonb(OLD)->>'sha256_hex', OLD.review_status, OLD.uploaded_at, actor, reason
  );

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.record_document_deletion() IS
  'Writes the permanent record of a deletion before allowing it, and refuses the '
  'deletion outright when there is no named actor or no stated reason.';

REVOKE EXECUTE ON FUNCTION public.record_document_deletion() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_document_deletion() FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_document_deletion() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.record_document_deletion() FROM service_role;

DROP TRIGGER IF EXISTS farmer_documents_record_deletion ON public.farmer_documents;
CREATE TRIGGER farmer_documents_record_deletion
  BEFORE DELETE ON public.farmer_documents
  FOR EACH ROW EXECUTE FUNCTION public.record_document_deletion();

-- TRUNCATE BYPASSES ROW TRIGGERS ENTIRELY. Without this, every protection above
-- is defeated by one statement that removes every document and writes no record
-- at all. A statement-level trigger is the only thing that sees it.
CREATE OR REPLACE FUNCTION public.refuse_document_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'farmer_documents cannot be truncated. TRUNCATE bypasses the per-row deletion record; remove documents one at a time so each removal is recorded.'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refuse_document_truncate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_document_truncate() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refuse_document_truncate() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refuse_document_truncate() FROM service_role;

DROP TRIGGER IF EXISTS farmer_documents_no_truncate ON public.farmer_documents;
CREATE TRIGGER farmer_documents_no_truncate
  BEFORE TRUNCATE ON public.farmer_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_document_truncate();

-- ── This migration records itself, as its final act ─────────────────────────
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Apply 67 (the migrations ledger) before this migration.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.schema_migrations (number, name, applied_at, applied_by, evidence)
  VALUES (69, 'DOCUMENT_DELETION_RECORD', now(), current_user, 'self-recorded')
  ON CONFLICT (number) DO UPDATE
    SET applied_at = excluded.applied_at,
        applied_by = excluded.applied_by,
        evidence   = 'self-recorded'
    WHERE public.schema_migrations.evidence LIKE 'backfilled%';
END
$ledger$;

COMMIT;
