-- ============================================================================
-- 72 — VERIFY
-- ============================================================================
--
-- Sections A–E. Each raises on failure and prints "VERIFY <letter> PASSED" on
-- success, so a section that is skipped is not mistaken for one that passed.
--
-- A  the column exists and is shaped like reviewed_by
-- B  the stamp: trigger and function, and the function OVERWRITES the caller
-- C  the constraint exists, is VALID, and says what it is supposed to say
-- D  the apply recorded itself in the ledger
-- E  what this file CANNOT prove, stated rather than implied
--
-- RUNNABLE AS ddp_ro, ON A SEPARATE CONNECTION. That is the rule 67 and 68
-- established and it is the whole point: verification that depends on the role
-- which did the applying can only tell you that role's view of the world. Every
-- section below reads catalogs and the ledger, both of which ddp_ro may select.
--
--     set -a; . ~/.ddp_prod.env; set +a
--     psql "$PROD_RO_DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -f 72_UPLOADER_IS_NOT_REVIEWER_VERIFY.sql
--
-- ON_ERROR_STOP=1 IS NOT OPTIONAL. psql exits 0 on a failed script without it,
-- which is how a broken migration once reported success.
--
-- PROVE IT CAN FAIL BEFORE TRUSTING IT. On staging or a disposable database,
-- never production: apply 72, run this (expect A–D PASSED), run the ROLLBACK,
-- run this again (expect VERIFY A FAILED on the first missing column). A verify
-- that has never failed is a verify nobody has tested — migration 61's lesson.
-- ============================================================================

-- A — the column, on both tables, shaped like the one it is compared against.
DO $a$
DECLARE
  t_uploaded text;
  t_reviewed text;
BEGIN
  SELECT data_type INTO t_uploaded FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'farmer_documents'
     AND column_name = 'uploaded_by';

  IF t_uploaded IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: farmer_documents.uploaded_by does not exist — the separation claim cannot be made at all';
  END IF;

  SELECT data_type INTO t_reviewed FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'farmer_documents'
     AND column_name = 'reviewed_by';

  -- Compared against reviewed_by rather than hard-coded: the two are compared
  -- to each other by the constraint, so a type drift between them is the defect
  -- worth catching, not a departure from a literal written here.
  IF t_uploaded IS DISTINCT FROM t_reviewed THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: uploaded_by is % but reviewed_by is % — the constraint compares them',
      t_uploaded, t_reviewed;
  END IF;

  -- NOT asserted here: farmer_document_deletions.uploaded_by. 72 deliberately
  -- does not add it — see section 4 of the HARDENING. Deleting a document still
  -- loses who uploaded it, and that gap is recorded rather than papered over.
  RAISE NOTICE 'VERIFY A PASSED: uploaded_by exists on farmer_documents, typed as reviewed_by is (%).', t_uploaded;
END
$a$;

-- B — the stamp comes from the session, and the caller cannot supply it.
DO $b$
DECLARE
  body text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'farmer_documents'
       AND t.tgname = 'farmer_documents_set_uploaded_by'
       AND NOT t.tgisinternal
       -- BEFORE (bit 2) INSERT (bit 4) FOR EACH ROW (bit 1) = 7.
       AND (t.tgtype::int & 7) = 7
  ) THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: no BEFORE INSERT ROW trigger farmer_documents_set_uploaded_by. Without it uploaded_by is whatever the client sent, and a separation control the controlled party fills in controls nothing';
  END IF;

  SELECT prosrc INTO body FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_document_uploaded_by';

  IF body IS NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: public.set_document_uploaded_by() does not exist';
  END IF;

  -- The assignment must be unconditional. `coalesce(NEW.uploaded_by, auth.uid())`
  -- would look correct and let any caller name whoever it liked as the uploader.
  IF body !~ 'NEW\.uploaded_by\s*:=\s*auth\.uid\(\)' THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: set_document_uploaded_by does not assign NEW.uploaded_by := auth.uid() outright — check it has not been softened to a coalesce';
  END IF;

  IF body ~* 'coalesce\s*\(\s*NEW\.uploaded_by' THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: set_document_uploaded_by coalesces the caller''s uploaded_by, so a caller can name its own uploader';
  END IF;

  -- SECURITY DEFINER plus EXECUTE to PUBLIC would let any caller run this with
  -- the owner's rights. Nobody needs EXECUTE: a trigger function is invoked by
  -- the trigger.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'set_document_uploaded_by'
       AND (
         has_function_privilege('anon',          p.oid, 'EXECUTE') OR
         has_function_privilege('authenticated', p.oid, 'EXECUTE') OR
         has_function_privilege('service_role',  p.oid, 'EXECUTE')
       )
  ) THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: a client role holds EXECUTE on set_document_uploaded_by, which is SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: a BEFORE INSERT ROW trigger stamps uploaded_by from the session, overwrites whatever the caller sent, and no client role may execute it.';
END
$b$;

-- C — the constraint, and that it is VALID rather than merely present.
DO $c$
DECLARE
  def text;
  ok  boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated
    INTO def, ok
    FROM pg_constraint
   WHERE conrelid = 'public.farmer_documents'::regclass
     AND conname = 'document_uploader_is_not_reviewer';

  IF def IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: constraint document_uploader_is_not_reviewer does not exist — nothing enforces the separation';
  END IF;

  -- NOT VALID would mean the constraint governs new rows only and was never
  -- checked against what is already there. 72 validates it in the same
  -- transaction; a constraint left NOT VALID is a different, weaker claim.
  IF NOT ok THEN
    RAISE EXCEPTION 'VERIFY C FAILED: document_uploader_is_not_reviewer exists but is NOT VALID — it was never checked against the existing rows';
  END IF;

  IF def !~ 'uploaded_by' OR def !~ 'reviewed_by' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the constraint does not compare uploaded_by against reviewed_by: %', def;
  END IF;

  -- Pending rows must stay exempt, or a document could never be created: at
  -- INSERT the row is pending and has no reviewer at all.
  IF def !~ 'pending' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the constraint does not exempt pending rows, so no document could be inserted: %', def;
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: document_uploader_is_not_reviewer is present and VALID — %', def;
END
$c$;

-- D — the apply is in the ledger, self-recorded rather than inferred.
DO $d$
DECLARE
  ev text;
  -- Not `by`: it is a keyword, and `DECLARE by text` is a syntax error that
  -- aborts the section — which under ON_ERROR_STOP takes every later section
  -- with it. The disposable harness caught this; a structural read would not.
  applied_role text;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY D FAILED: no migrations ledger — apply 67 first';
  END IF;

  SELECT evidence, applied_by INTO ev, applied_role
    FROM public.schema_migrations WHERE number = 72;

  IF ev IS NULL THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: no ledger row for 72. This is the state migration 66 is in, and it is indistinguishable from never having been applied';
  END IF;

  IF ev LIKE 'rolled back%' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the ledger says 72 was rolled back — %', ev;
  END IF;

  IF ev <> 'self-recorded' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: 72 is recorded as "%", not self-recorded — a probe-derived row does not prove this apply ran', ev;
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: the ledger records 72 as self-recorded, applied by %.', applied_role;
END
$d$;

-- E — the limits of this file, said out loud.
DO $e$
DECLARE
  unattributed_possible boolean;
  def                   text;
BEGIN
  -- ddp_ro cannot read farmer_documents (its RLS calls a function ddp_ro may
  -- not execute), so this cannot count how many rows carry no uploader. What it
  -- CAN establish is whether the column is nullable — i.e. whether an
  -- unattributed row is possible at all — which is the shape of the remaining
  -- hole rather than its size.
  SELECT is_nullable = 'YES' INTO unattributed_possible
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'farmer_documents'
     AND column_name = 'uploaded_by';

  -- The hole is asserted, not merely mentioned. If someone later makes the
  -- column NOT NULL, or drops the NULL branch from the constraint, the scope of
  -- the public claim has changed and this section is where that surfaces.
  IF unattributed_possible IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: uploaded_by is absent, so its nullability cannot be established';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.farmer_documents'::regclass
     AND conname = 'document_uploader_is_not_reviewer';

  IF unattributed_possible AND def !~ 'uploaded_by IS NULL' THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: uploaded_by is nullable but the constraint does not exempt NULL — every historical row would refuse its first decision: %', def;
  END IF;

  IF unattributed_possible THEN
    RAISE NOTICE
      'VERIFY E PASSED: uploaded_by is nullable and the constraint exempts NULL, which is the documented and intended hole — every row predating this apply, plus any insert outside a request context where auth.uid() is NULL. THE PUBLIC CLAIM IS THEREFORE TRUE OF DOCUMENTS UPLOADED AFTER THIS APPLY, NOT OF THE WHOLE REGISTER. Do not publish it unscoped until the backfill question is settled.';
  ELSE
    RAISE NOTICE 'VERIFY E PASSED: uploaded_by is NOT NULL — every row carries an uploader and the claim holds for the whole register.';
  END IF;

  RAISE NOTICE
    'VERIFY E NOTE: this file proves catalog state, not behaviour. It cannot insert or update as ddp_ro, so "a reviewer cannot clear their own upload" is asserted here only as a constraint definition. The behavioural proof belongs on a disposable database, where a row can be built and the refusal observed — see the 72 fixture.';
END
$e$;
