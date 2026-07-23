-- =============================================================================
-- Migration 24 — Evidence Request & Resolution Workflow (database phase)
--
-- Implements the binding contract "DDP EVIDENCE REQUEST & RESOLUTION WORKFLOW —
-- BINDING IMPLEMENTATION CONTRACT v1.0" sections 4, 5, 6, 8 and 12.
--
-- Scope of THIS file (public schema only):
--   1. Canonical value helpers (statuses, priorities, categories, target matrix)
--   2. Tables: evidence_requests, evidence_request_responses,
--              evidence_request_attachments, evidence_request_history
--   3. Constraints, indexes and integrity triggers
--   4. Authorization helper can_operationally_access_farm(uuid)
--   5. Atomic SECURITY DEFINER transition RPCs
--   6. Direct-DML denial + RLS
--
-- Storage bucket and storage.objects policies are DELIBERATELY NOT in this file.
-- They live in 24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql because CREATE POLICY
-- on storage.objects requires ownership of that table (supabase_storage_admin),
-- which the role that applies public-schema migrations does not hold. Keeping
-- them separate means a storage-privilege problem cannot roll back this entire
-- migration. Both files are part of the migration source; apply the storage
-- companion with a role holding that membership.
--
-- Verify:   24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql
-- Rollback: 24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql
-- Storage:  24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql
--
-- Preconditions:
--   * public.is_ddp_admin()                  (migration 3 / AUTH_RLS_SCHEMA)
--   * public.has_farm_membership(uuid)       (migration 3 / AUTH_RLS_SCHEMA)
--   * public.has_operational_farmer_access() (migration 22)
--   * public.profiles, farms, farm_profiles, farm_memberships,
--     inventory_batches, farmer_documents, documents
--
-- Contract note (§8.1 + owner decision): "active membership" for the MVP means
-- an applicable row currently exists in farm_memberships. Revocation is row
-- deletion. No inactive-membership state is introduced by this migration.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions — fail loudly and atomically before creating anything.
-- -----------------------------------------------------------------------------
DO $precondition$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_ddp_admin'
  ) THEN missing := missing || 'public.is_ddp_admin()'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_farm_membership'
  ) THEN missing := missing || 'public.has_farm_membership(uuid)'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_operational_farmer_access'
  ) THEN missing := missing || 'public.has_operational_farmer_access()'; END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 24 precondition failed: missing required object(s): %. '
      'Apply the migrations that create them before migration 24.',
      array_to_string(missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Canonical value helpers (contract §4).
--    IMMUTABLE so they can be used inside CHECK constraints.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evidence_request_statuses()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY[
  'open','farmer_submitted','clarification_requested','resolved','rejected','cancelled'
]::text[] $$;

CREATE OR REPLACE FUNCTION public.evidence_request_terminal_statuses()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY['resolved','rejected','cancelled']::text[] $$;

CREATE OR REPLACE FUNCTION public.evidence_request_priorities()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY['low','normal','high','urgent']::text[] $$;

CREATE OR REPLACE FUNCTION public.evidence_request_categories()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY[
  'farm_identity','farm_license','gacp_evidence','gmp_evidence',
  'export_supporting_document','responsible_contact','coa','batch_identity',
  'inventory_quantity_evidence','inventory_photo','inventory_video',
  'storage_evidence','chain_of_custody','other'
]::text[] $$;

-- Category-to-target matrix (contract §4.5). Authoritative in the database;
-- the client may duplicate it for usability but is never authoritative.
CREATE OR REPLACE FUNCTION public.evidence_category_allows_target(
  p_category text, p_target_type text
)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_category IN ('farm_identity','farm_license','gacp_evidence',
                        'gmp_evidence','responsible_contact')
      THEN p_target_type = 'farm_profile'
    WHEN p_category IN ('coa','batch_identity','inventory_quantity_evidence',
                        'inventory_photo','inventory_video')
      THEN p_target_type = 'inventory_batch'
    WHEN p_category IN ('export_supporting_document','storage_evidence',
                        'chain_of_custody','other')
      THEN p_target_type IN ('farm_profile','inventory_batch')
    ELSE false
  END
$$;

-- Allowed MIME types per category (contract §7.3).
--
-- SCOPE OF THE GUARANTEE. For UPLOADED request evidence ('request_upload') both
-- MIME and extension are validated — see evidence_filename_extension_allowed()
-- below, which reservation and finalization both enforce. MIME is never inferred
-- from the filename extension alone: the declared MIME selects which extensions
-- are permitted, not the reverse.
--
-- LINKED EXISTING documents are deliberately NOT extension-validated. Their name
-- comes from public.farmer_documents.file_name / public.documents.file_name,
-- which are nullable and carry no guaranteed extension, and their MIME is
-- classified authoritatively from document_type via evidence_document_mime()
-- rather than declared by the caller. Requiring an extension there would reject
-- valid pre-existing rows on the basis of data the source tables never promised.
-- The MIME/category check still applies to them.
CREATE OR REPLACE FUNCTION public.evidence_mime_allowed(p_category text, p_mime text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_mime IS NULL THEN false
    WHEN p_category = 'coa'             THEN p_mime = 'application/pdf'
    WHEN p_category = 'inventory_photo' THEN p_mime IN ('image/jpeg','image/png','image/webp')
    WHEN p_category = 'inventory_video' THEN p_mime = 'video/mp4'
    ELSE p_mime IN ('application/pdf','image/jpeg','image/png','image/webp')
  END
$$;

-- Maximum individual size per category (contract §7.3).
CREATE OR REPLACE FUNCTION public.evidence_max_size_bytes(p_category text, p_mime text)
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_category = 'inventory_video' AND p_mime = 'video/mp4' THEN 104857600::bigint  -- 100 MB
    ELSE 20971520::bigint                                                                -- 20 MB
  END
$$;

-- Existing farmer/inventory document rows carry `document_type` but no MIME
-- column. This is an explicit classification of the source document type, not a
-- measurement — see the size_bytes note on evidence_request_attachments.
-- Filename extension allow-list, paired with the MIME allow-list above.
--
-- The comment on evidence_mime_allowed() promised that "both MIME and extension
-- are validated". Only the MIME half was implemented: reservation accepted any
-- p_original_filename provided the declared MIME and size passed, and
-- finalization repeated only those checks — so `payload.exe` declared as
-- application/pdf was reserved and finalized, and the extension was written into
-- both the canonical object path and original_filename. This closes that half.
--
-- The rule is CONJUNCTIVE: the category must permit the MIME (checked here via
-- evidence_mime_allowed, so the two can never drift apart) AND the filename's
-- FINAL extension must be one this MIME permits. MIME is never inferred from the
-- extension — the declared MIME selects the permitted extensions, not the other
-- way round.
--
-- Only the last suffix counts, so `report.pdf.exe` is rejected for a PDF while
-- `report.exe.pdf` is accepted: what a consumer dispatches on is the final
-- extension. Validation runs against the ORIGINAL logical filename, before path
-- sanitization, so character replacement can never turn a forbidden extension
-- into a permitted one.
CREATE OR REPLACE FUNCTION public.evidence_filename_extension_allowed(
  p_category text, p_mime text, p_filename text
)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_filename IS NULL              THEN false
    WHEN btrim(p_filename) = ''          THEN false
    -- A path is not a filename. Rejected outright rather than trimmed, so a
    -- traversal attempt can never be silently reinterpreted as a valid name.
    WHEN p_filename ~ '[/\\]'            THEN false
    -- Requires a final ASCII alphanumeric suffix: no extension, a trailing dot,
    -- and non-ASCII suffixes are all rejected deterministically.
    WHEN p_filename !~ '\.[A-Za-z0-9]+$' THEN false
    -- Category/MIME consistency is part of this predicate, not an assumption.
    WHEN NOT public.evidence_mime_allowed(p_category, p_mime) THEN false
    ELSE lower(regexp_replace(p_filename, '^.*\.', '')) = ANY (
      CASE p_mime
        WHEN 'application/pdf' THEN ARRAY['pdf']
        WHEN 'image/jpeg'      THEN ARRAY['jpg','jpeg']
        WHEN 'image/png'       THEN ARRAY['png']
        WHEN 'image/webp'      THEN ARRAY['webp']
        WHEN 'video/mp4'       THEN ARRAY['mp4']
        ELSE ARRAY[]::text[]
      END)
  END
$$;

CREATE OR REPLACE FUNCTION public.evidence_document_mime(p_document_type text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_document_type = 'photo' THEN 'image/jpeg' ELSE 'application/pdf' END
$$;

-- -----------------------------------------------------------------------------
-- 2. Canonical authorization helper (contract §8.1).
--    True ONLY when: profile role is 'farmer' AND has_operational_farmer_access()
--    AND the caller holds an active membership for the target farm.
--    No policy may grant access merely because the caller is `authenticated`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_operationally_access_farm(target_farm_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    target_farm_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'farmer'
    )
    AND public.has_operational_farmer_access()
    AND EXISTS (
      SELECT 1 FROM public.farm_memberships
      WHERE farm_id = target_farm_id AND user_id = auth.uid()
    );
$$;

REVOKE EXECUTE ON FUNCTION public.can_operationally_access_farm(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_operationally_access_farm(uuid) FROM anon;
-- Keep EXECUTE for authenticated: the storage and table RLS policies invoke it
-- in the caller's context. service_role bypasses RLS and never evaluates those
-- policies, so it gets no direct EXECUTE (§8.6 [v1.3]).
REVOKE EXECUTE ON FUNCTION public.can_operationally_access_farm(uuid) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.can_operationally_access_farm(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Tables (contract §6.2 – §6.5).
-- -----------------------------------------------------------------------------

-- 3.1 evidence_requests
CREATE TABLE IF NOT EXISTS public.evidence_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             uuid NOT NULL REFERENCES public.farms(id) ON DELETE RESTRICT,
  target_type         text NOT NULL,
  farm_profile_id     uuid REFERENCES public.farm_profiles(id) ON DELETE RESTRICT,
  inventory_batch_id  uuid REFERENCES public.inventory_batches(id) ON DELETE RESTRICT,
  category            text NOT NULL,
  title               varchar(140) NOT NULL,
  explanation         text NOT NULL,
  priority            text NOT NULL DEFAULT 'normal',
  due_date            date,
  status              text NOT NULL DEFAULT 'open',
  revision            integer NOT NULL DEFAULT 1,
  created_by_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  closed_by_user_id   uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,

  CONSTRAINT evidence_requests_target_type_check
    CHECK (target_type IN ('farm_profile','inventory_batch')),
  CONSTRAINT evidence_requests_status_check
    CHECK (status = ANY (public.evidence_request_statuses())),
  CONSTRAINT evidence_requests_priority_check
    CHECK (priority = ANY (public.evidence_request_priorities())),
  CONSTRAINT evidence_requests_category_check
    CHECK (category = ANY (public.evidence_request_categories())),
  CONSTRAINT evidence_requests_revision_positive_check
    CHECK (revision > 0),
  -- Exactly one target (contract §6.2 "Target constraint").
  CONSTRAINT evidence_requests_exactly_one_target_check CHECK (
    (target_type = 'farm_profile'
       AND farm_profile_id IS NOT NULL AND inventory_batch_id IS NULL)
    OR
    (target_type = 'inventory_batch'
       AND inventory_batch_id IS NOT NULL AND farm_profile_id IS NULL)
  ),
  CONSTRAINT evidence_requests_category_target_check
    CHECK (public.evidence_category_allows_target(category, target_type)),
  CONSTRAINT evidence_requests_title_length_check
    CHECK (char_length(btrim(title)) BETWEEN 3 AND 140),
  CONSTRAINT evidence_requests_explanation_length_check
    CHECK (char_length(btrim(explanation)) BETWEEN 20 AND 4000),
  -- due_date is a calendar date and must not precede the creation date.
  CONSTRAINT evidence_requests_due_date_not_before_creation_check
    CHECK (due_date IS NULL OR due_date >= (created_at AT TIME ZONE 'UTC')::date),
  -- closed_at/closed_by are set if and only if the status is terminal.
  CONSTRAINT evidence_requests_terminal_closure_check CHECK (
    (status = ANY (public.evidence_request_terminal_statuses())
       AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL)
    OR
    (NOT (status = ANY (public.evidence_request_terminal_statuses()))
       AND closed_at IS NULL AND closed_by_user_id IS NULL)
  )
);

-- 3.2 evidence_request_responses
CREATE TABLE IF NOT EXISTS public.evidence_request_responses (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id              uuid NOT NULL
                            REFERENCES public.evidence_requests(id) ON DELETE RESTRICT,
  response_number         integer NOT NULL,
  state                   text NOT NULL,
  response_text           text,
  supersedes_response_id  uuid
                            REFERENCES public.evidence_request_responses(id) ON DELETE RESTRICT,
  -- IMMUTABLE PROVENANCE (contract §6.3, §4.8 [v1.1]): the user who originally
  -- created this response. Never rewritten — not by handoff, not by any RPC, not
  -- by direct DML.
  created_by_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- MUTABLE EDIT AUTHORITY (contract §4.8 [v1.1]): the farmer currently permitted
  -- to edit the single draft. Initialised = created_by_user_id; changes ONLY
  -- through claim_evidence_response_draft() while state='draft'; frozen at
  -- submission. This is what resolves the abandoned-draft deadlock without a
  -- second draft and without rewriting provenance.
  draft_owner_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  submitted_at            timestamptz,

  CONSTRAINT evidence_responses_state_check
    CHECK (state IN ('draft','submitted')),
  CONSTRAINT evidence_responses_number_positive_check
    CHECK (response_number > 0),
  CONSTRAINT evidence_responses_text_length_check
    CHECK (response_text IS NULL OR char_length(response_text) <= 4000),
  -- submitted_at is null for draft and non-null for submitted (contract §6.3).
  CONSTRAINT evidence_responses_submitted_at_state_check CHECK (
    (state = 'draft'     AND submitted_at IS NULL)
    OR
    (state = 'submitted' AND submitted_at IS NOT NULL)
  ),
  CONSTRAINT evidence_responses_no_self_supersede_check
    CHECK (supersedes_response_id IS NULL OR supersedes_response_id <> id),
  CONSTRAINT evidence_responses_unique_number
    UNIQUE (request_id, response_number)
);

-- Only one draft may exist per request (contract §6.3).
CREATE UNIQUE INDEX IF NOT EXISTS evidence_responses_one_draft_per_request_idx
  ON public.evidence_request_responses (request_id)
  WHERE state = 'draft';

-- 3.3 evidence_request_attachments
CREATE TABLE IF NOT EXISTS public.evidence_request_attachments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id             uuid NOT NULL
                           REFERENCES public.evidence_requests(id) ON DELETE RESTRICT,
  response_id            uuid NOT NULL
                           REFERENCES public.evidence_request_responses(id) ON DELETE RESTRICT,
  origin                 text NOT NULL,
  farmer_document_id     uuid REFERENCES public.farmer_documents(id) ON DELETE RESTRICT,
  inventory_document_id  uuid REFERENCES public.documents(id) ON DELETE RESTRICT,
  storage_bucket         text,
  storage_object_path    text,
  upload_state           text,
  original_filename      text NOT NULL,
  mime_type              text NOT NULL,
  -- CONTRACT DEVIATION (documented, deliberate): contract §6.4 specifies
  -- size_bytes NOT NULL. It is NOT NULL for 'request_upload', where the size is
  -- measured at finalization. For linked EXISTING documents it is nullable,
  -- because public.farmer_documents and public.documents carry no size column —
  -- inventing a byte count for a row we never measured would be fabricated data.
  -- The 150 MB aggregate limit therefore counts uploaded bytes only.
  size_bytes             bigint,
  sha256_hex             char(64),
  created_by_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  finalized_at           timestamptz,
  -- Two-stage controlled removal (contract §6.4 "Removal deletes the
  -- request-specific storage object and database row through one controlled
  -- operation"). A Supabase Storage object MUST be deleted through the Storage
  -- API — deleting from storage.objects in SQL removes only the metadata row and
  -- orphans the actual file. The database therefore cannot delete the object
  -- itself; it authorizes the deletion, the client performs it through the
  -- Storage API, and the same RPC then completes the removal once it can prove
  -- the object is gone. This column marks that authorization window. It is NOT a
  -- third upload_state: the contract allows only pending_upload and ready.
  removal_requested_at   timestamptz,

  CONSTRAINT evidence_attachments_origin_check
    CHECK (origin IN ('request_upload','existing_farm_document','existing_inventory_document')),
  CONSTRAINT evidence_attachments_upload_state_check
    CHECK (upload_state IS NULL OR upload_state IN ('pending_upload','ready')),
  CONSTRAINT evidence_attachments_size_positive_check
    CHECK (size_bytes IS NULL OR size_bytes > 0),
  -- An uploaded attachment must always carry a measured, positive size.
  CONSTRAINT evidence_attachments_upload_size_required_check
    CHECK (origin <> 'request_upload' OR size_bytes IS NOT NULL),
  CONSTRAINT evidence_attachments_sha256_hex_format_check
    CHECK (sha256_hex IS NULL OR sha256_hex ~ '^[0-9a-f]{64}$'),
  -- Origin discriminator (contract §6.4 "Required origin constraint").
  CONSTRAINT evidence_attachments_origin_shape_check CHECK (
    (origin = 'request_upload'
       AND storage_bucket IS NOT NULL AND storage_object_path IS NOT NULL
       AND upload_state IS NOT NULL
       AND farmer_document_id IS NULL AND inventory_document_id IS NULL)
    OR
    (origin = 'existing_farm_document'
       AND farmer_document_id IS NOT NULL
       AND inventory_document_id IS NULL
       AND storage_bucket IS NULL AND storage_object_path IS NULL
       AND upload_state IS NULL)
    OR
    (origin = 'existing_inventory_document'
       AND inventory_document_id IS NOT NULL
       AND farmer_document_id IS NULL
       AND storage_bucket IS NULL AND storage_object_path IS NULL
       AND upload_state IS NULL)
  ),
  -- A ready upload must carry its digest and finalization timestamp.
  CONSTRAINT evidence_attachments_ready_requires_digest_check CHECK (
    origin <> 'request_upload'
    OR upload_state <> 'ready'
    OR (sha256_hex IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT evidence_attachments_pending_has_no_finalization_check CHECK (
    origin <> 'request_upload'
    OR upload_state <> 'pending_upload'
    OR (sha256_hex IS NULL AND finalized_at IS NULL)
  ),
  CONSTRAINT evidence_attachments_storage_path_unique
    UNIQUE (storage_bucket, storage_object_path)
);

-- 3.4 evidence_request_history (append-only)
CREATE TABLE IF NOT EXISTS public.evidence_request_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid NOT NULL
                     REFERENCES public.evidence_requests(id) ON DELETE RESTRICT,
  previous_status  text,
  next_status      text NOT NULL,
  actor_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role       text NOT NULL,
  event_type       text NOT NULL,
  response_id      uuid REFERENCES public.evidence_request_responses(id) ON DELETE RESTRICT,
  -- ON DELETE SET NULL (approved contract interpretation, contract §6.4 vs §12.4):
  -- a draft attachment must remain removable before submission, but its history
  -- event must survive permanently. Deleting the attachment therefore nulls only
  -- this pointer; event_type, actor, timestamp, request/response linkage,
  -- ordering and metadata are all preserved. The append-only trigger below
  -- permits exactly this one transition and nothing else.
  attachment_id    uuid REFERENCES public.evidence_request_attachments(id) ON DELETE SET NULL,
  note             text,
  event_data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evidence_history_actor_role_check
    CHECK (actor_role IN ('ddp_admin','farmer')),
  CONSTRAINT evidence_history_event_type_check
    CHECK (event_type IN (
      'request_created','response_submitted','clarification_requested',
      'request_resolved','response_rejected','request_cancelled',
      'attachment_uploaded','existing_document_linked',
      'draft_ownership_transferred')),   -- [v1.1]
  CONSTRAINT evidence_history_next_status_check
    CHECK (next_status = ANY (public.evidence_request_statuses())),
  CONSTRAINT evidence_history_previous_status_check
    CHECK (previous_status IS NULL OR previous_status = ANY (public.evidence_request_statuses())),
  -- previous_status may be null ONLY for the creation event (contract §6.5).
  CONSTRAINT evidence_history_previous_status_only_null_on_create_check CHECK (
    (event_type = 'request_created' AND previous_status IS NULL)
    OR (event_type <> 'request_created' AND previous_status IS NOT NULL)
  ),
  -- Terminal and clarification events require a note (contract §6.5 / §12.2).
  CONSTRAINT evidence_history_note_required_check CHECK (
    event_type NOT IN ('clarification_requested','request_resolved',
                       'response_rejected','request_cancelled')
    OR (note IS NOT NULL AND char_length(btrim(note)) BETWEEN 10 AND 2000)
  )
);

-- -----------------------------------------------------------------------------
-- 4. Indexes (contract §6.2 "Required indexes").
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS evidence_requests_farm_status_created_idx
  ON public.evidence_requests (farm_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_requests_status_priority_due_created_idx
  ON public.evidence_requests (status, priority, due_date, created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_requests_active_idx
  ON public.evidence_requests (status, created_at DESC)
  WHERE status IN ('open','farmer_submitted','clarification_requested');
CREATE INDEX IF NOT EXISTS evidence_requests_farm_profile_idx
  ON public.evidence_requests (farm_profile_id)
  WHERE farm_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_requests_inventory_batch_idx
  ON public.evidence_requests (inventory_batch_id)
  WHERE inventory_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_requests_creator_created_idx
  ON public.evidence_requests (created_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS evidence_responses_request_number_idx
  ON public.evidence_request_responses (request_id, response_number DESC);
CREATE INDEX IF NOT EXISTS evidence_attachments_request_idx
  ON public.evidence_request_attachments (request_id);
CREATE INDEX IF NOT EXISTS evidence_attachments_response_idx
  ON public.evidence_request_attachments (response_id);
-- Deterministic history ordering (contract §12 "deterministic ordering").
CREATE INDEX IF NOT EXISTS evidence_history_request_created_id_idx
  ON public.evidence_request_history (request_id, created_at, id);

-- -----------------------------------------------------------------------------
-- 5. Integrity triggers.
-- -----------------------------------------------------------------------------

-- 5.1 Target scope validation: farm_id must be DERIVED from the target, never
--     caller-chosen (contract §6.2 "Scope validation", §19.7).
CREATE OR REPLACE FUNCTION public.fn_evidence_request_validate_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  resolved_farm_id uuid;
BEGIN
  IF NEW.target_type = 'farm_profile' THEN
    SELECT fp.farm_id INTO resolved_farm_id
    FROM public.farm_profiles fp WHERE fp.id = NEW.farm_profile_id;
    IF resolved_farm_id IS NULL THEN
      RAISE EXCEPTION 'evidence request scope: farm profile % does not resolve to a farm',
        NEW.farm_profile_id USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    SELECT ib.farm_id INTO resolved_farm_id
    FROM public.inventory_batches ib WHERE ib.id = NEW.inventory_batch_id;
    IF resolved_farm_id IS NULL THEN
      -- inventory_batches.farm_id is ON DELETE SET NULL, so an orphaned batch is
      -- possible. An orphan can never be scoped safely: reject it at creation.
      RAISE EXCEPTION 'evidence request scope: inventory batch % does not resolve to a farm',
        NEW.inventory_batch_id USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF NEW.farm_id IS DISTINCT FROM resolved_farm_id THEN
    RAISE EXCEPTION
      'evidence request scope: farm_id % does not own the selected target (expected %)',
      NEW.farm_id, resolved_farm_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_request_validate_scope ON public.evidence_requests;
CREATE TRIGGER trg_evidence_request_validate_scope
  BEFORE INSERT ON public.evidence_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_request_validate_scope();

-- 5.2 Immutability of request core fields (contract §6.2 "Mutability").
CREATE OR REPLACE FUNCTION public.fn_evidence_request_protect_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.farm_id IS DISTINCT FROM OLD.farm_id
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.farm_profile_id IS DISTINCT FROM OLD.farm_profile_id
     OR NEW.inventory_batch_id IS DISTINCT FROM OLD.inventory_batch_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.explanation IS DISTINCT FROM OLD.explanation
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'evidence request %: target, category, title, explanation, priority, due date '
      'and creator are immutable after creation', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_request_protect_immutable ON public.evidence_requests;
CREATE TRIGGER trg_evidence_request_protect_immutable
  BEFORE UPDATE ON public.evidence_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_request_protect_immutable();

-- 5.3 Submitted responses are fully immutable and undeletable (contract §6.3).
CREATE OR REPLACE FUNCTION public.fn_evidence_response_protect_submitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'submitted' THEN
      RAISE EXCEPTION 'evidence response %: a submitted response cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state = 'submitted' THEN
    RAISE EXCEPTION 'evidence response %: a submitted response is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.response_number IS DISTINCT FROM OLD.response_number
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'evidence response %: request, number, author and creation time are immutable',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- draft_owner_user_id (edit authority, contract §4.8 [v1.1]) may change ONLY
  -- in isolation: a legitimate handoff touches this column and updated_at and
  -- nothing else, on a still-draft row. Bundling an ownership flip into any
  -- other edit — or changing it at submission — is rejected. Direct DML is
  -- already revoked from every client role and service_role, so only the
  -- SECURITY DEFINER handoff RPC can reach this path at all.
  IF NEW.draft_owner_user_id IS DISTINCT FROM OLD.draft_owner_user_id THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.state <> 'draft'
       OR NEW.response_text          IS DISTINCT FROM OLD.response_text
       OR NEW.supersedes_response_id IS DISTINCT FROM OLD.supersedes_response_id
       OR NEW.submitted_at           IS DISTINCT FROM OLD.submitted_at
    THEN
      RAISE EXCEPTION 'evidence response %: draft ownership may change only via handoff on a draft row',
        OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A draft may only ever move forward to submitted.
  IF NEW.state = 'draft' AND OLD.state = 'draft' THEN
    RETURN NEW;
  ELSIF NEW.state = 'submitted' AND OLD.state = 'draft' THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'evidence response %: invalid state change % -> %',
      OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_response_protect_submitted ON public.evidence_request_responses;
CREATE TRIGGER trg_evidence_response_protect_submitted
  BEFORE UPDATE OR DELETE ON public.evidence_request_responses
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_response_protect_submitted();

-- 5.4 Attachment integrity: same-request coupling, same-farm ownership,
--     batch coupling for COA, and immutability once the response is submitted
--     (contract §6.4 "Required integrity rules" / "Mutability and deletion").
CREATE OR REPLACE FUNCTION public.fn_evidence_attachment_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  req            public.evidence_requests%ROWTYPE;
  resp           public.evidence_request_responses%ROWTYPE;
  doc_farm_id    uuid;
  doc_batch_id   uuid;
  doc_doctype    text;
  doc_label      text;
  ready_count    integer;
  ready_bytes    bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO resp FROM public.evidence_request_responses WHERE id = OLD.response_id;
    IF resp.state = 'submitted' THEN
      RAISE EXCEPTION 'evidence attachment %: a submitted attachment cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO resp FROM public.evidence_request_responses WHERE id = NEW.response_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence attachment: response % not found', NEW.response_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND resp.state = 'submitted' THEN
    RAISE EXCEPTION 'evidence attachment %: attachments of a submitted response are immutable',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- removal_requested_at is IMMUTABLE ONCE SET (contract §7.8 [v1.2]): a tombstone
  -- is irreversible. NULL -> timestamp is the one allowed transition (the removal
  -- RPC). timestamp -> NULL, or timestamp -> a different timestamp, is denied, so
  -- no path can resurrect a tombstoned upload as active evidence.
  IF TG_OP = 'UPDATE'
     AND OLD.removal_requested_at IS NOT NULL
     AND NEW.removal_requested_at IS DISTINCT FROM OLD.removal_requested_at THEN
    RAISE EXCEPTION 'evidence attachment %: removal_requested_at is immutable once set',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- The attachment's request must equal the response's request.
  IF NEW.request_id IS DISTINCT FROM resp.request_id THEN
    RAISE EXCEPTION
      'evidence attachment: request_id % does not match the response request %',
      NEW.request_id, resp.request_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO req FROM public.evidence_requests WHERE id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence attachment: request % not found', NEW.request_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Linked existing documents must belong to the SAME farm as the request, and
  -- a COA must come from the TARGETED batch. Both source tables carry
  -- inventory_batch_id (farmer_documents ON DELETE SET NULL, documents ON DELETE
  -- CASCADE), so the batch check applies to BOTH linked origins — resolving the
  -- ownership pair once and validating it once prevents the batch rule from
  -- silently applying to only one of them.
  IF NEW.origin IN ('existing_farm_document','existing_inventory_document') THEN
    IF NEW.origin = 'existing_farm_document' THEN
      SELECT fd.farm_id, fd.inventory_batch_id, fd.document_type INTO doc_farm_id, doc_batch_id, doc_doctype
      FROM public.farmer_documents fd WHERE fd.id = NEW.farmer_document_id;
      doc_label := 'farmer document ' || COALESCE(NEW.farmer_document_id::text, 'null');
    ELSE
      SELECT d.farm_id, d.inventory_batch_id, d.document_type INTO doc_farm_id, doc_batch_id, doc_doctype
      FROM public.documents d WHERE d.id = NEW.inventory_document_id;
      doc_label := 'document ' || COALESCE(NEW.inventory_document_id::text, 'null');
    END IF;

    IF doc_farm_id IS DISTINCT FROM req.farm_id THEN
      RAISE EXCEPTION
        'evidence attachment: % does not belong to farm %',
        doc_label, req.farm_id USING ERRCODE = 'check_violation';
    END IF;

    -- A COA must come from the targeted batch (contract §6.4). IS DISTINCT FROM
    -- also rejects a NULL doc_batch_id against a non-null target, so an
    -- unbatched document can never satisfy a batch-targeted COA request.
    IF req.category = 'coa'
       AND doc_batch_id IS DISTINCT FROM req.inventory_batch_id THEN
      RAISE EXCEPTION
        'evidence attachment: COA % does not belong to the targeted batch %',
        doc_label, COALESCE(req.inventory_batch_id::text, 'null')
        USING ERRCODE = 'check_violation';
    END IF;

    -- A CoA request must be answered with a CoA document. Without this a
    -- same-batch 'licence'/'other' document (both PDF-shaped) would satisfy a
    -- CoA request, because MIME class alone cannot tell them apart. Enforced
    -- here in the validate trigger (defense in depth for any insert path) as
    -- well as in link_existing_evidence_document() for the client RPC path.
    IF req.category = 'coa' AND doc_doctype IS DISTINCT FROM 'coa' THEN
      RAISE EXCEPTION
        'evidence attachment: COA request requires a coa document, but % is %',
        doc_label, COALESCE(doc_doctype, 'null')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Per-response ready limits: max 10 attachments, max 150 MB aggregate.
  SELECT count(*), COALESCE(sum(a.size_bytes), 0)
    INTO ready_count, ready_bytes
  FROM public.evidence_request_attachments a
  WHERE a.response_id = NEW.response_id
    AND a.id <> NEW.id
    -- Tombstones (removal_requested_at set) are logically removed and must not
    -- count toward the 10-attachment / 150 MB limits (contract §7.8 [v1.2]).
    AND a.removal_requested_at IS NULL
    AND (a.origin <> 'request_upload' OR a.upload_state = 'ready');

  IF NEW.origin <> 'request_upload' OR NEW.upload_state = 'ready' THEN
    ready_count := ready_count + 1;
    -- Linked existing documents contribute no measured bytes (see size_bytes note).
    ready_bytes := ready_bytes + COALESCE(NEW.size_bytes, 0);
  END IF;

  IF ready_count > 10 THEN
    RAISE EXCEPTION 'evidence attachment: response % exceeds the 10 ready attachment limit',
      NEW.response_id USING ERRCODE = 'check_violation';
  END IF;
  IF ready_bytes > 157286400 THEN  -- 150 MB
    RAISE EXCEPTION
      'evidence attachment: response % exceeds the 150 MB aggregate attachment limit',
      NEW.response_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_attachment_validate ON public.evidence_request_attachments;
CREATE TRIGGER trg_evidence_attachment_validate
  BEFORE INSERT OR UPDATE OR DELETE ON public.evidence_request_attachments
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_attachment_validate();

-- 5.5 History is append-only for EVERY role (contract §6.5, §12.4).
-- History is append-only. The ONE permitted mutation is the referential action
-- from evidence_request_attachments ON DELETE SET NULL, which clears
-- attachment_id when a controlled draft removal deletes the referenced row.
-- A referential action runs as an internal UPDATE and therefore fires this
-- trigger, so it must be recognised explicitly — otherwise draft removal would
-- fail with the append-only error instead of the old foreign-key error.
--
-- The exemption is deliberately as narrow as SQL allows:
--   * attachment_id moves from NOT NULL to NULL,
--   * EVERY other column is byte-identical, AND
--   * the referenced attachment row NO LONGER EXISTS.
--
-- That last condition is what separates a genuine FK cleanup from a manual audit
-- edit. Under ON DELETE SET NULL the parent row is deleted BEFORE the referential
-- action updates the child, so during real cleanup the attachment is already
-- gone. A hand-written `UPDATE evidence_request_history SET attachment_id = NULL`
-- performed while the attachment still exists therefore fails — including from a
-- privileged or service role, since the test is a property of the data, not of
-- the caller. No current_user check, auth.role check, session variable, GUC,
-- role allowlist or SECURITY DEFINER bypass flag is used or needed.
CREATE OR REPLACE FUNCTION public.fn_evidence_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.attachment_id IS NOT NULL
     AND NEW.attachment_id IS NULL
     AND NEW.id              IS NOT DISTINCT FROM OLD.id
     AND NEW.request_id      IS NOT DISTINCT FROM OLD.request_id
     AND NEW.previous_status IS NOT DISTINCT FROM OLD.previous_status
     AND NEW.next_status     IS NOT DISTINCT FROM OLD.next_status
     AND NEW.actor_user_id   IS NOT DISTINCT FROM OLD.actor_user_id
     AND NEW.actor_role      IS NOT DISTINCT FROM OLD.actor_role
     AND NEW.event_type      IS NOT DISTINCT FROM OLD.event_type
     AND NEW.response_id     IS NOT DISTINCT FROM OLD.response_id
     AND NEW.note            IS NOT DISTINCT FROM OLD.note
     AND NEW.event_data      IS NOT DISTINCT FROM OLD.event_data
     AND NEW.created_at      IS NOT DISTINCT FROM OLD.created_at
     -- Proof this is FK cleanup and not a manual edit: the attachment is gone.
     AND NOT EXISTS (
       SELECT 1 FROM public.evidence_request_attachments
       WHERE id = OLD.attachment_id
     )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'evidence_request_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_history_append_only ON public.evidence_request_history;
CREATE TRIGGER trg_evidence_history_append_only
  BEFORE UPDATE OR DELETE ON public.evidence_request_history
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_history_append_only();

-- 5.6 Blanket deletion prohibition for requests (contract §6.6).
CREATE OR REPLACE FUNCTION public.fn_evidence_request_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'evidence requests cannot be deleted (contract §6.6)'
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS trg_evidence_request_no_delete ON public.evidence_requests;
CREATE TRIGGER trg_evidence_request_no_delete
  BEFORE DELETE ON public.evidence_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_evidence_request_no_delete();

-- -----------------------------------------------------------------------------
-- 6. Internal helpers used by the RPCs.
-- -----------------------------------------------------------------------------

-- Caller's role, read from the database (never from JWT metadata).
CREATE OR REPLACE FUNCTION public.evidence_actor_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$ SELECT role FROM public.profiles WHERE id = auth.uid() $$;

-- Stable JSON representation returned by every transition RPC.
CREATE OR REPLACE FUNCTION public.evidence_request_as_json(p_request_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT to_jsonb(r) FROM (
    SELECT
      er.id, er.farm_id, er.target_type, er.farm_profile_id, er.inventory_batch_id,
      er.category, er.title, er.explanation, er.priority, er.due_date,
      er.status, er.revision, er.created_by_user_id, er.closed_by_user_id,
      er.created_at, er.updated_at, er.status_changed_at, er.closed_at
    FROM public.evidence_requests er WHERE er.id = p_request_id
  ) r
$$;

-- Locks the request, enforces visibility, and returns the row.
-- Contract §8.4: an unauthorized id must be indistinguishable from a missing id.
CREATE OR REPLACE FUNCTION public.evidence_lock_visible_request(
  p_request_id uuid, p_require_admin boolean
)
RETURNS public.evidence_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req  public.evidence_requests%ROWTYPE;
  is_admin boolean := public.is_ddp_admin();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- NON-DISCLOSURE (contract §8.4): an unauthorized caller must not be able to
  -- distinguish a real request id from a fabricated one. A non-admin calling an
  -- admin-only RPC is therefore refused with NOT_FOUND *before* the row is read,
  -- so neither the error code nor row-lock contention can act as an existence
  -- oracle. Legitimate administrator authorization is unaffected.
  IF p_require_admin AND NOT is_admin THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- The visibility predicate is part of the LOCKING SELECT, not a check applied
  -- afterwards. A row the caller may not see never matches, so it is never
  -- locked: an unauthorized farmer cannot block on, or contend with, another
  -- farm's row. Without this, a real-but-unauthorized id and a fabricated id
  -- were distinguishable by lock contention even though both raise NOT_FOUND.
  SELECT * INTO req FROM public.evidence_requests
  WHERE id = p_request_id
    AND (is_admin OR public.can_operationally_access_farm(farm_id))
  FOR UPDATE;

  -- Identical outcome for: nonexistent id, real id on another farm, and a
  -- fabricated id. Nothing distinguishes them (contract §8.4).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN req;
END
$$;

-- Applies a status transition and writes its history event atomically.
CREATE OR REPLACE FUNCTION public.evidence_apply_transition(
  p_request_id     uuid,
  p_expected_rev   integer,
  p_next_status    text,
  p_event_type     text,
  p_actor_role     text,
  p_note           text,
  p_response_id    uuid,
  p_attachment_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req        public.evidence_requests%ROWTYPE;
  is_terminal boolean;
BEGIN
  SELECT * INTO req FROM public.evidence_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF req.revision IS DISTINCT FROM p_expected_rev THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;

  is_terminal := p_next_status = ANY (public.evidence_request_terminal_statuses());

  UPDATE public.evidence_requests
  SET status            = p_next_status,
      revision          = revision + 1,
      updated_at        = now(),
      status_changed_at = now(),
      closed_at         = CASE WHEN is_terminal THEN now() ELSE NULL END,
      closed_by_user_id = CASE WHEN is_terminal THEN auth.uid() ELSE NULL END
  WHERE id = p_request_id;

  INSERT INTO public.evidence_request_history (
    request_id, previous_status, next_status, actor_user_id, actor_role,
    event_type, response_id, attachment_id, note
  ) VALUES (
    p_request_id, req.status, p_next_status, auth.uid(), p_actor_role,
    p_event_type, p_response_id, p_attachment_id, p_note
  );

  RETURN public.evidence_request_as_json(p_request_id);
END
$$;

-- -----------------------------------------------------------------------------
-- 7. Atomic transition RPCs (contract §6.7). All SECURITY DEFINER, all with an
--    explicit search_path, all locking the request row, all revision-checked,
--    all writing history in the same transaction.
-- -----------------------------------------------------------------------------

-- 7.1 create_evidence_request — administrator only.
CREATE OR REPLACE FUNCTION public.create_evidence_request(
  p_target_type  text,
  p_target_id    uuid,
  p_category     text,
  p_title        text,
  p_explanation  text,
  p_priority     text DEFAULT 'normal',
  p_due_date     date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  resolved_farm_id uuid;
  new_id           uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_target_type NOT IN ('farm_profile','inventory_batch') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: target_type' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.evidence_category_allows_target(p_category, p_target_type) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: category is not valid for this target type'
      USING ERRCODE = 'check_violation';
  END IF;

  -- farm_id is DERIVED from the target; it is never caller-supplied.
  IF p_target_type = 'farm_profile' THEN
    SELECT farm_id INTO resolved_farm_id FROM public.farm_profiles WHERE id = p_target_id;
  ELSE
    SELECT farm_id INTO resolved_farm_id FROM public.inventory_batches WHERE id = p_target_id;
  END IF;

  IF resolved_farm_id IS NULL THEN
    RAISE EXCEPTION 'TARGET_UNAVAILABLE' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.evidence_requests (
    farm_id, target_type,
    farm_profile_id, inventory_batch_id,
    category, title, explanation, priority, due_date,
    created_by_user_id
  ) VALUES (
    resolved_farm_id, p_target_type,
    CASE WHEN p_target_type = 'farm_profile'    THEN p_target_id END,
    CASE WHEN p_target_type = 'inventory_batch' THEN p_target_id END,
    p_category, p_title, p_explanation, COALESCE(p_priority,'normal'), p_due_date,
    auth.uid()
  ) RETURNING id INTO new_id;

  INSERT INTO public.evidence_request_history (
    request_id, previous_status, next_status, actor_user_id, actor_role, event_type
  ) VALUES (
    new_id, NULL, 'open', auth.uid(), 'ddp_admin', 'request_created'
  );

  RETURN public.evidence_request_as_json(new_id);
END
$$;

-- 7.2 get_or_create_evidence_response_draft — authorized farmer only.
CREATE OR REPLACE FUNCTION public.get_or_create_evidence_response_draft(
  p_request_id uuid, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req         public.evidence_requests%ROWTYPE;
  draft_id    uuid;
  next_number integer;
  prior_id    uuid;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO draft_id FROM public.evidence_request_responses
  WHERE request_id = p_request_id AND state = 'draft';

  IF draft_id IS NULL THEN
    SELECT COALESCE(max(response_number), 0) + 1 INTO next_number
    FROM public.evidence_request_responses WHERE request_id = p_request_id;

    SELECT id INTO prior_id FROM public.evidence_request_responses
    WHERE request_id = p_request_id AND state = 'submitted'
    ORDER BY response_number DESC LIMIT 1;

    INSERT INTO public.evidence_request_responses (
      request_id, response_number, state, supersedes_response_id, created_by_user_id, draft_owner_user_id
    ) VALUES (
      p_request_id, next_number, 'draft', prior_id, auth.uid(), auth.uid()
    ) RETURNING id INTO draft_id;
  END IF;

  RETURN (SELECT to_jsonb(r) FROM (
    SELECT id, request_id, response_number, state, response_text,
           supersedes_response_id, created_by_user_id, draft_owner_user_id,
           created_at, updated_at, submitted_at
    FROM public.evidence_request_responses WHERE id = draft_id
  ) r);
END
$$;

-- 7.3 save_evidence_response_draft — draft author only.
CREATE OR REPLACE FUNCTION public.save_evidence_response_draft(
  p_request_id uuid, p_response_id uuid, p_response_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req  public.evidence_requests%ROWTYPE;
  resp public.evidence_request_responses%ROWTYPE;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF resp.state <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;
  -- Authorship cannot be forged: only the draft's author may edit it.
  IF resp.draft_owner_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.evidence_request_responses
  SET response_text = p_response_text, updated_at = now()
  WHERE id = p_response_id;

  RETURN (SELECT to_jsonb(r) FROM (
    SELECT id, request_id, response_number, state, response_text,
           supersedes_response_id, created_by_user_id, created_at, updated_at, submitted_at
    FROM public.evidence_request_responses WHERE id = p_response_id
  ) r);
END
$$;

-- 7.4 submit_evidence_response — authorized farmer; open|clarification_requested
--     -> farmer_submitted. Refuses pending uploads and empty submissions.
CREATE OR REPLACE FUNCTION public.submit_evidence_response(
  p_request_id uuid, p_response_id uuid, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req           public.evidence_requests%ROWTYPE;
  resp          public.evidence_request_responses%ROWTYPE;
  pending_count integer;
  ready_count   integer;
  latest_sub_id uuid;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF resp.state <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;
  IF resp.draft_owner_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ACTIVE attachments only. A tombstone (removal_requested_at IS NOT NULL) is
  -- logically removed from the draft (contract §7.8 [v1.2]): it neither blocks
  -- submission as a pending upload nor counts as ready evidence. It is retained
  -- solely for cleanup authority, so it must be invisible to submission logic.
  SELECT count(*) FILTER (WHERE origin = 'request_upload' AND upload_state = 'pending_upload'
                                AND removal_requested_at IS NULL),
         count(*) FILTER (WHERE (origin <> 'request_upload' OR upload_state = 'ready')
                                AND removal_requested_at IS NULL)
    INTO pending_count, ready_count
  FROM public.evidence_request_attachments WHERE response_id = p_response_id;

  IF pending_count > 0 THEN
    RAISE EXCEPTION 'UPLOAD_NOT_READY' USING ERRCODE = 'check_violation';
  END IF;

  -- NOTE: the previous "fail closed while any attachment is mid-removal" blocker
  -- is gone. With durable tombstones that condition would be permanent — a
  -- response could never be submitted after any removal. It is unnecessary:
  -- tombstones are excluded from ready_count above, so they can never become
  -- submitted evidence, and a late object on a tombstoned path is residue, not
  -- evidence.
  IF COALESCE(btrim(resp.response_text), '') = '' AND ready_count = 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a response requires text or at least one ready attachment'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A resubmission must supersede the immediately preceding submitted response.
  SELECT id INTO latest_sub_id FROM public.evidence_request_responses
  WHERE request_id = p_request_id AND state = 'submitted'
  ORDER BY response_number DESC LIMIT 1;

  IF latest_sub_id IS NOT NULL
     AND resp.supersedes_response_id IS DISTINCT FROM latest_sub_id THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: response must supersede the latest submitted response'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.evidence_request_responses
  SET state = 'submitted', submitted_at = now(), updated_at = now()
  WHERE id = p_response_id;

  RETURN public.evidence_apply_transition(
    p_request_id, p_expected_revision, 'farmer_submitted', 'response_submitted',
    'farmer', NULL, p_response_id, NULL
  );
END
$$;

-- 7.5 request_evidence_clarification — administrator; farmer_submitted ->
--     clarification_requested.
CREATE OR REPLACE FUNCTION public.request_evidence_clarification(
  p_request_id uuid, p_reviewed_response_id uuid, p_reason text, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req           public.evidence_requests%ROWTYPE;
  latest_sub_id uuid;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, true);

  -- CONFLICT ORDERING (contract §5.4): a stale caller must learn that the
  -- request moved on, not that the transition it planned is invalid. Comparing
  -- the revision immediately after the locking read means a request that has
  -- since become terminal returns CONFLICT rather than INVALID_TRANSITION, so
  -- the UI reloads the authoritative state instead of reporting a bad action.
  -- evidence_apply_transition() re-checks the revision as defence in depth.
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;

  IF char_length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: clarification reason must be 10-2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.status <> 'farmer_submitted' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO latest_sub_id FROM public.evidence_request_responses
  WHERE request_id = p_request_id AND state = 'submitted'
  ORDER BY response_number DESC LIMIT 1;

  -- An action may only reference the CURRENT submitted response.
  IF latest_sub_id IS NULL OR p_reviewed_response_id IS DISTINCT FROM latest_sub_id THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: reviewed response must be the current submitted response'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN public.evidence_apply_transition(
    p_request_id, p_expected_revision, 'clarification_requested',
    'clarification_requested', 'ddp_admin', p_reason, p_reviewed_response_id, NULL
  );
END
$$;

-- 7.6 resolve_evidence_request — administrator; farmer_submitted -> resolved.
CREATE OR REPLACE FUNCTION public.resolve_evidence_request(
  p_request_id uuid, p_reviewed_response_id uuid, p_resolution_note text, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req           public.evidence_requests%ROWTYPE;
  latest_sub_id uuid;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, true);

  -- CONFLICT ORDERING (contract §5.4): a stale caller must learn that the
  -- request moved on, not that the transition it planned is invalid. Comparing
  -- the revision immediately after the locking read means a request that has
  -- since become terminal returns CONFLICT rather than INVALID_TRANSITION, so
  -- the UI reloads the authoritative state instead of reporting a bad action.
  -- evidence_apply_transition() re-checks the revision as defence in depth.
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;

  IF char_length(btrim(COALESCE(p_resolution_note,''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: resolution note must be 10-2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.status <> 'farmer_submitted' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO latest_sub_id FROM public.evidence_request_responses
  WHERE request_id = p_request_id AND state = 'submitted'
  ORDER BY response_number DESC LIMIT 1;

  IF latest_sub_id IS NULL OR p_reviewed_response_id IS DISTINCT FROM latest_sub_id THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: reviewed response must be the current submitted response'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN public.evidence_apply_transition(
    p_request_id, p_expected_revision, 'resolved', 'request_resolved',
    'ddp_admin', p_resolution_note, p_reviewed_response_id, NULL
  );
END
$$;

-- 7.7 reject_evidence_response — administrator; farmer_submitted -> rejected.
CREATE OR REPLACE FUNCTION public.reject_evidence_response(
  p_request_id uuid, p_reviewed_response_id uuid, p_rejection_reason text, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req           public.evidence_requests%ROWTYPE;
  latest_sub_id uuid;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, true);

  -- CONFLICT ORDERING (contract §5.4): a stale caller must learn that the
  -- request moved on, not that the transition it planned is invalid. Comparing
  -- the revision immediately after the locking read means a request that has
  -- since become terminal returns CONFLICT rather than INVALID_TRANSITION, so
  -- the UI reloads the authoritative state instead of reporting a bad action.
  -- evidence_apply_transition() re-checks the revision as defence in depth.
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;

  IF char_length(btrim(COALESCE(p_rejection_reason,''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: rejection reason must be 10-2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.status <> 'farmer_submitted' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO latest_sub_id FROM public.evidence_request_responses
  WHERE request_id = p_request_id AND state = 'submitted'
  ORDER BY response_number DESC LIMIT 1;

  IF latest_sub_id IS NULL OR p_reviewed_response_id IS DISTINCT FROM latest_sub_id THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: reviewed response must be the current submitted response'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN public.evidence_apply_transition(
    p_request_id, p_expected_revision, 'rejected', 'response_rejected',
    'ddp_admin', p_rejection_reason, p_reviewed_response_id, NULL
  );
END
$$;

-- 7.8 cancel_evidence_request — administrator; any non-terminal -> cancelled.
CREATE OR REPLACE FUNCTION public.cancel_evidence_request(
  p_request_id uuid, p_cancellation_reason text, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req public.evidence_requests%ROWTYPE;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, true);

  -- CONFLICT ORDERING (contract §5.4): a stale caller must learn that the
  -- request moved on, not that the transition it planned is invalid. Comparing
  -- the revision immediately after the locking read means a request that has
  -- since become terminal returns CONFLICT rather than INVALID_TRANSITION, so
  -- the UI reloads the authoritative state instead of reporting a bad action.
  -- evidence_apply_transition() re-checks the revision as defence in depth.
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;

  IF char_length(btrim(COALESCE(p_cancellation_reason,''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: cancellation reason must be 10-2000 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.status = ANY (public.evidence_request_terminal_statuses()) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  RETURN public.evidence_apply_transition(
    p_request_id, p_expected_revision, 'cancelled', 'request_cancelled',
    'ddp_admin', p_cancellation_reason, NULL, NULL
  );
END
$$;

-- 7.9 reserve_evidence_attachment — creates the pending_upload row with the
--     canonical, server-computed storage path (contract §7.2).
CREATE OR REPLACE FUNCTION public.reserve_evidence_attachment(
  p_request_id uuid, p_response_id uuid,
  p_original_filename text, p_mime_type text, p_size_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req            public.evidence_requests%ROWTYPE;
  resp           public.evidence_request_responses%ROWTYPE;
  new_id         uuid := gen_random_uuid();
  sanitized      text;
  object_path    text;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF resp.state <> 'draft' OR resp.draft_owner_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT public.evidence_mime_allowed(req.category, p_mime_type) THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED' USING ERRCODE = 'check_violation';
  END IF;
  -- Extension is validated against the ORIGINAL filename, before sanitization
  -- and before the canonical path is built — so a forbidden suffix can never be
  -- rewritten into a permitted one, and a rejected reservation creates no
  -- attachment row, no history event and no reserved path.
  IF NOT public.evidence_filename_extension_allowed(req.category, p_mime_type, p_original_filename) THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED' USING ERRCODE = 'check_violation';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0
     OR p_size_bytes > public.evidence_max_size_bytes(req.category, p_mime_type) THEN
    RAISE EXCEPTION 'FILE_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;

  -- The path filename is sanitized and is never trusted as metadata; the
  -- original filename is stored separately (contract §7.2).
  sanitized := regexp_replace(COALESCE(p_original_filename,'file'), '[^A-Za-z0-9._-]', '_', 'g');
  IF char_length(sanitized) = 0 THEN sanitized := 'file'; END IF;
  object_path := req.farm_id || '/' || p_request_id || '/' || p_response_id || '/' || new_id || '/' || sanitized;

  INSERT INTO public.evidence_request_attachments (
    id, request_id, response_id, origin,
    storage_bucket, storage_object_path, upload_state,
    original_filename, mime_type, size_bytes, created_by_user_id
  ) VALUES (
    new_id, p_request_id, p_response_id, 'request_upload',
    'evidence-request-files', object_path, 'pending_upload',
    p_original_filename, p_mime_type, p_size_bytes, auth.uid()
  );

  RETURN (SELECT to_jsonb(a) FROM (
    SELECT id, request_id, response_id, origin, storage_bucket, storage_object_path,
           upload_state, original_filename, mime_type, size_bytes, created_by_user_id, created_at
    FROM public.evidence_request_attachments WHERE id = new_id
  ) a);
END
$$;

-- 7.10 finalize_evidence_attachment — pending_upload -> ready.
CREATE OR REPLACE FUNCTION public.finalize_evidence_attachment(
  p_request_id uuid, p_response_id uuid, p_attachment_id uuid,
  p_sha256_hex text, p_actual_size_bytes bigint, p_actual_mime_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req          public.evidence_requests%ROWTYPE;
  resp         public.evidence_request_responses%ROWTYPE;
  att          public.evidence_request_attachments%ROWTYPE;
  obj_meta     jsonb;
  stored_size  bigint;
  stored_mime  text;
  effective_size bigint;
  effective_mime text;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The request must still be actionable. Without this, an attachment reserved
  -- before an administrator cancelled or closed the request could still be
  -- flipped to ready and append attachment_uploaded history to a terminal
  -- request. Mirrors the guard in reserve/link/save/submit and the storage policy.
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR resp.state <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO att FROM public.evidence_request_attachments
  WHERE id = p_attachment_id AND response_id = p_response_id AND request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF att.created_by_user_id IS DISTINCT FROM auth.uid() THEN  -- [v1.1] provenance-scoped: only the reserving user finalizes
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF att.origin <> 'request_upload' OR att.upload_state <> 'pending_upload' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;
  -- Fail closed once controlled removal has been authorized: the object may
  -- already have been deleted through the Storage API.
  IF att.removal_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: attachment is awaiting controlled removal'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_sha256_hex IS NULL OR p_sha256_hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: sha256_hex' USING ERRCODE = 'check_violation';
  END IF;

  -- INDEPENDENT REVALIDATION of the reservation, from STORED fields only. A row
  -- reserved before this rule existed — or under any earlier defective state —
  -- must not become ready now. The caller supplies no filename here on purpose:
  -- re-deriving it from input would let a caller launder a bad reservation by
  -- presenting a different name at finalization.
  IF NOT public.evidence_mime_allowed(req.category, att.mime_type) THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED: stored MIME is not permitted for category %',
      req.category USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.evidence_filename_extension_allowed(req.category, att.mime_type, att.original_filename) THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED: stored filename extension is not permitted for MIME %',
      att.mime_type USING ERRCODE = 'check_violation';
  END IF;
  -- The canonical path must carry the same final extension as the stored name,
  -- so the object a consumer fetches cannot disagree with what was validated.
  IF lower(regexp_replace(att.storage_object_path, '^.*\.', ''))
     IS DISTINCT FROM lower(regexp_replace(att.original_filename, '^.*\.', '')) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: canonical path extension does not match the stored filename'
      USING ERRCODE = 'check_violation';
  END IF;

  -- OBJECT EXISTENCE (contract §7.4 step 6). The caller-supplied size, MIME and
  -- digest are CLAIMS, never proof that an upload happened. Read the actual
  -- storage.objects row at the reserved bucket/path; if it is absent the upload
  -- did not occur and finalization must fail closed, so a submitted response can
  -- never point at a missing object.
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'STORAGE_ERROR: storage.objects is unavailable'
      USING ERRCODE = 'undefined_table';
  END IF;

  SELECT o.metadata INTO obj_meta
  FROM storage.objects o
  WHERE o.bucket_id = att.storage_bucket
    AND o.name      = att.storage_object_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'STORAGE_ERROR: no uploaded object at the reserved path for attachment %',
      p_attachment_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Storage-recorded metadata is authoritative where present; the caller's
  -- values must agree with it.
  stored_size := NULLIF(obj_meta ->> 'size', '')::bigint;
  stored_mime := NULLIF(obj_meta ->> 'mimetype', '');

  IF stored_size IS NOT NULL
     AND p_actual_size_bytes IS DISTINCT FROM stored_size THEN
    RAISE EXCEPTION
      'STORAGE_ERROR: declared size % does not match the stored object size %',
      p_actual_size_bytes, stored_size USING ERRCODE = 'check_violation';
  END IF;
  IF stored_mime IS NOT NULL
     AND p_actual_mime_type IS DISTINCT FROM stored_mime THEN
    RAISE EXCEPTION
      'STORAGE_ERROR: declared MIME type % does not match the stored object type %',
      p_actual_mime_type, stored_mime USING ERRCODE = 'check_violation';
  END IF;

  effective_size := COALESCE(stored_size, p_actual_size_bytes);
  effective_mime := COALESCE(stored_mime, p_actual_mime_type);

  -- FINAL MIME MUST EQUAL THE RESERVED MIME.
  --
  -- A reservation is a security contract over (category, original filename,
  -- canonical path, MIME, size ceiling). Finalization may PROVE the reservation
  -- correct; it must not silently transform it into a different file type. The
  -- previous code let effective_mime replace att.mime_type whenever both were
  -- individually category-allowed, so on any multi-MIME category a reservation
  -- of photo.jpg / image/jpeg could finalize as application/pdf while the stored
  -- filename and canonical path still ended in .jpg — a row whose MIME and
  -- extension disagree, which is exactly what the extension rule exists to stop.
  --
  -- The authoritative storage MIME remains authoritative EVIDENCE of what was
  -- uploaded; a disagreement with the reservation is a rejection, not a coercion.
  IF effective_mime IS DISTINCT FROM att.mime_type THEN
    RAISE EXCEPTION
      'FILE_TYPE_NOT_ALLOWED: uploaded object MIME % does not match the reserved MIME %',
      effective_mime, att.mime_type USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.evidence_mime_allowed(req.category, effective_mime) THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED' USING ERRCODE = 'check_violation';
  END IF;
  -- Re-run the extension check against the AUTHORITATIVE final MIME, not merely
  -- the reserved one. With the equality guard above these are the same MIME, so
  -- this is belt-and-braces — but it means the extension guarantee is anchored
  -- to effective_mime by construction and cannot silently drift if the equality
  -- rule is ever relaxed.
  IF NOT public.evidence_filename_extension_allowed(req.category, effective_mime, att.original_filename) THEN
    RAISE EXCEPTION
      'FILE_TYPE_NOT_ALLOWED: stored filename extension is not permitted for the final MIME %',
      effective_mime USING ERRCODE = 'check_violation';
  END IF;
  IF effective_size IS NULL OR effective_size <= 0
     OR effective_size > public.evidence_max_size_bytes(req.category, effective_mime) THEN
    RAISE EXCEPTION 'FILE_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.evidence_request_attachments
  SET upload_state = 'ready',
      sha256_hex   = p_sha256_hex,
      size_bytes   = effective_size,
      mime_type    = effective_mime,
      finalized_at = now()
  WHERE id = p_attachment_id;

  INSERT INTO public.evidence_request_history (
    request_id, previous_status, next_status, actor_user_id, actor_role,
    event_type, response_id, attachment_id
  ) VALUES (
    p_request_id, req.status, req.status, auth.uid(), 'farmer',
    'attachment_uploaded', p_response_id, p_attachment_id
  );

  RETURN (SELECT to_jsonb(a) FROM (
    SELECT id, request_id, response_id, origin, storage_bucket, storage_object_path,
           upload_state, original_filename, mime_type, size_bytes, sha256_hex,
           created_by_user_id, created_at, finalized_at
    FROM public.evidence_request_attachments WHERE id = p_attachment_id
  ) a);
END
$$;

-- 7.11 remove_draft_evidence_attachment — draft-only removal.
CREATE OR REPLACE FUNCTION public.remove_draft_evidence_attachment(
  p_request_id uuid, p_response_id uuid, p_attachment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req  public.evidence_requests%ROWTYPE;
  resp public.evidence_request_responses%ROWTYPE;
  att  public.evidence_request_attachments%ROWTYPE;
  object_exists boolean;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- CLEANUP ELIGIBILITY IS DERIVED FROM THE DRAFT RESPONSE, NOT FROM AN
  -- ACTIONABLE PARENT REQUEST.
  --
  -- This previously required req.status IN ('open','clarification_requested').
  -- The storage DELETE policy required the same, so the two were mutually
  -- gating: once an admin cancelled (or resolved/rejected) a request while a
  -- farmer held a reserved or uploaded draft attachment, the farmer could
  -- neither mark the attachment for removal nor delete the object, and the row
  -- and file were stranded until privileged manual cleanup. resolve/reject act
  -- on the SUBMITTED response, so a draft can coexist with every terminal
  -- status — this was reachable from all three, not just cancellation.
  --
  -- A draft attachment is by definition NOT submitted evidence: nothing of
  -- record is destroyed by removing it, and the history event survives via the
  -- FK's ON DELETE SET NULL. So the authorization that matters is the response
  -- being a draft, the caller owning the attachment, and operational access to
  -- the farm — all asserted below. Adding evidence still requires an actionable
  -- request: reserve, link, save, submit and finalize all keep that guard.
  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO att FROM public.evidence_request_attachments
  WHERE id = p_attachment_id AND response_id = p_response_id AND request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  -- The cleanup principal is the (possibly frozen) draft owner. After submission
  -- draft_owner_user_id is frozen (§4.8 [v1.1]); for a pre-existing tombstone it
  -- remains the final authorised cleanup principal (§7.9 [v1.3]).
  IF resp.draft_owner_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- BRANCH A vs BRANCH B (contract §7.9 [v1.3]).
  --   BRANCH B — CONTINUE cleanup of an existing request_upload tombstone. A
  --   tombstone was removed while the response was a draft and is NOT submitted
  --   evidence, so its cleanup authority survives submission and terminal request
  --   states. This branch never mutates the row; it only reports/continues
  --   physical-object cleanup (phase 2 below).
  --   BRANCH A — BEGIN removal (set the marker) or unlink an existing document.
  --   This is the creation boundary: it may START only while the response is a
  --   draft, so a submitted response can never be newly tombstoned.
  IF NOT (att.origin = 'request_upload' AND att.removal_requested_at IS NOT NULL) THEN
    IF resp.state <> 'draft' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Stage 0 — linked existing documents own no request-specific object. Nothing
  -- is stored for this workflow, so the row goes immediately. The source
  -- document is untouched: it was linked, never copied (contract §7.5).
  IF att.origin <> 'request_upload' THEN
    DELETE FROM public.evidence_request_attachments WHERE id = p_attachment_id;
    RETURN jsonb_build_object(
      'result', 'REMOVED',
      'attachment_id', p_attachment_id,
      'storage_bucket', NULL,
      'storage_object_path', NULL
    );
  END IF;

  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'STORAGE_ERROR: storage.objects is unavailable'
      USING ERRCODE = 'undefined_table';
  END IF;

  -- ── PHASE 1 — revoke upload authorization BEFORE trusting any absence ──────
  --
  -- A point-in-time "no object exists" result is NOT evidence that no object
  -- will exist. An upload authorized against this still-insertable row can be
  -- in flight: the Storage INSERT evaluates its policy on its own snapshot, and
  -- FOR UPDATE above does not block it, because a policy subquery is a plain
  -- read that takes no lock. The previous code deleted the row on that absence
  -- result, so the in-flight object could land afterwards with no attachment
  -- row — no DELETE policy could then match it, and the path-prefix SELECT
  -- policy left it readable by farm members. That is the orphan this protocol
  -- exists to prevent.
  --
  -- So the FIRST call never deletes anything. It sets removal_requested_at,
  -- which the storage INSERT policy now treats as "reservation spent", and
  -- returns. Once THAT transaction commits, no new upload can be authorized.
  IF att.removal_requested_at IS NULL THEN
    UPDATE public.evidence_request_attachments
    SET removal_requested_at = now()
    WHERE id = p_attachment_id;

    RETURN jsonb_build_object(
      'result', 'STORAGE_DELETE_REQUIRED',
      'attachment_id', p_attachment_id,
      'storage_bucket', att.storage_bucket,
      'storage_object_path', att.storage_object_path
    );
  END IF;

  -- ── PHASE 2 — the marker is already committed by an earlier transaction ────
  --
  -- DURABLE TOMBSTONE (contract §7.8 [v1.2]). This row is NEVER hard-deleted
  -- once removal_requested_at is set. A point-in-time absence from storage.objects
  -- is NOT proof that no object can arrive: a Storage INSERT whose RLS policy was
  -- evaluated while the marker was still NULL can be in flight (uncommitted, hence
  -- invisible here under READ COMMITTED) and commit AFTER this call. If we deleted
  -- the row on that absence, the late object would have no owning workflow row and
  -- no DELETE-policy path — the exact orphan Codex identified. Keeping the row
  -- permanently guarantees a late-committing object always has an authoritative
  -- tombstone that authorizes controlled Storage deletion. We do NOT claim
  -- atomicity between PostgreSQL and Supabase Storage transactions; the tombstone
  -- is how the workflow stays correct without it.
  SELECT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = att.storage_bucket
      AND o.name      = att.storage_object_path
  ) INTO object_exists;

  IF NOT object_exists THEN
    -- No object is CURRENTLY present, so the attachment is logically removed from
    -- the draft. The row is retained as the tombstone (it is already excluded from
    -- active evidence, counts, size and farmer reads by removal_requested_at). If
    -- a late object arrives, a subsequent call returns STORAGE_DELETE_REQUIRED and
    -- the same tombstone authorizes its deletion. REMOVED means "no object present
    -- now", never "no object can ever arrive".
    RETURN jsonb_build_object(
      'result', 'REMOVED',
      'attachment_id', p_attachment_id,
      'storage_bucket', att.storage_bucket,
      'storage_object_path', att.storage_object_path
    );
  END IF;

  -- The object is present. The tombstone authorizes the client's Storage API
  -- delete; hand back the path. Repeated calls are idempotent and deterministic.
  RETURN jsonb_build_object(
    'result', 'STORAGE_DELETE_REQUIRED',
    'attachment_id', p_attachment_id,
    'storage_bucket', att.storage_bucket,
    'storage_object_path', att.storage_object_path
  );
END
$$;

-- 7.12 link_existing_evidence_document — links, never copies (contract §7.5).
CREATE OR REPLACE FUNCTION public.link_existing_evidence_document(
  p_request_id uuid, p_response_id uuid, p_origin text,
  p_farmer_document_id uuid DEFAULT NULL, p_inventory_document_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req      public.evidence_requests%ROWTYPE;
  resp     public.evidence_request_responses%ROWTYPE;
  new_id   uuid;
  fname    text;
  fdoctype text;
BEGIN
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;
  IF p_origin NOT IN ('existing_farm_document','existing_inventory_document') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: origin' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR resp.state <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;
  IF resp.draft_owner_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Metadata is read from the source row; cross-farm linkage is additionally
  -- rejected by fn_evidence_attachment_validate(). Neither source table carries
  -- a MIME or size column, so mime_type is classified from document_type and
  -- size_bytes is left NULL rather than fabricated.
  IF p_origin = 'existing_farm_document' THEN
    SELECT COALESCE(fd.file_name, 'document'), fd.document_type
      INTO fname, fdoctype
    FROM public.farmer_documents fd WHERE fd.id = p_farmer_document_id;
  ELSE
    SELECT COALESCE(d.file_name, 'document'), d.document_type
      INTO fname, fdoctype
    FROM public.documents d WHERE d.id = p_inventory_document_id;
  END IF;

  IF fname IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- The linked document type must be compatible with the request category.
  IF NOT public.evidence_mime_allowed(req.category, public.evidence_document_mime(fdoctype)) THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED' USING ERRCODE = 'check_violation';
  END IF;

  -- A Certificate of Analysis request must be answered with a CoA document, not
  -- merely any PDF-shaped document. evidence_document_mime() maps every non-photo
  -- source type to application/pdf, so the MIME check above cannot distinguish a
  -- 'coa' source from a 'licence'/'other' one — a same-batch licence would
  -- otherwise satisfy a CoA request. Assert the source's own document_type for
  -- this category. (Other categories keep MIME-class compatibility; they do not
  -- name a single required source type.)
  IF req.category = 'coa' AND fdoctype IS DISTINCT FROM 'coa' THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED: a coa request requires a coa document (source type is %)',
      COALESCE(fdoctype, 'null') USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.evidence_request_attachments (
    request_id, response_id, origin, farmer_document_id, inventory_document_id,
    original_filename, mime_type, size_bytes, created_by_user_id
  ) VALUES (
    p_request_id, p_response_id, p_origin, p_farmer_document_id, p_inventory_document_id,
    fname, public.evidence_document_mime(fdoctype), NULL, auth.uid()
  ) RETURNING id INTO new_id;

  INSERT INTO public.evidence_request_history (
    request_id, previous_status, next_status, actor_user_id, actor_role,
    event_type, response_id, attachment_id
  ) VALUES (
    p_request_id, req.status, req.status, auth.uid(), 'farmer',
    'existing_document_linked', p_response_id, new_id
  );

  RETURN (SELECT to_jsonb(a) FROM (
    SELECT id, request_id, response_id, origin, farmer_document_id, inventory_document_id,
           original_filename, mime_type, size_bytes, created_by_user_id, created_at
    FROM public.evidence_request_attachments WHERE id = new_id
  ) a);
END
$$;

-- 7.13 claim_evidence_response_draft — transfer EDIT AUTHORITY for the single
--      existing draft to the caller (contract §4.8 [v1.1]). It creates NO new
--      response, never rewrites created_by_user_id, never touches attachment
--      creators or history actors. It is the ONLY path that may change
--      draft_owner_user_id.
--
--      Liveness problem it solves: the one draft per request may have been
--      created by a farm member who is no longer operational (membership removed,
--      role changed, access disabled). get_or_create returns that draft, but the
--      mutating RPCs reject anyone but its owner and the one-draft unique index
--      blocks creating another, so the request is stuck. Handoff moves authority
--      over that one draft to a currently-authorised farmer.
--
--      Handoff is NOT theft: it is permitted ONLY when the current owner is no
--      longer operational for the request farm. An active owner's draft cannot be
--      taken. Concurrency is via the request revision (locked, incremented), so
--      simultaneous claims resolve to one winner and stale edits are invalidated.
CREATE OR REPLACE FUNCTION public.claim_evidence_response_draft(
  p_request_id uuid, p_response_id uuid, p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  req         public.evidence_requests%ROWTYPE;
  resp        public.evidence_request_responses%ROWTYPE;
  old_owner   uuid;
  owner_active boolean;
  n           integer;
BEGIN
  -- Visibility + lock first: a non-visible request is NOT_FOUND, so an
  -- unauthorised or cross-farm probe learns nothing (contract §8.4).
  req := public.evidence_lock_visible_request(p_request_id, false);

  IF public.evidence_actor_role() IS DISTINCT FROM 'farmer'
     OR NOT public.can_operationally_access_farm(req.farm_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF req.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;
  -- Terminal requests are never reopened (contract §4.7).
  IF req.status NOT IN ('open','clarification_requested') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  -- Lock the response AFTER the request (documented order: request -> response)
  -- so two concurrent claims cannot both proceed.
  SELECT * INTO resp FROM public.evidence_request_responses
  WHERE id = p_response_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF resp.state <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: only a draft response can be claimed'
      USING ERRCODE = 'check_violation';
  END IF;

  old_owner := resp.draft_owner_user_id;
  IF old_owner = auth.uid() THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: caller already owns this draft'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The current owner must be OPERATIONALLY ABANDONED for this farm. Evaluated by
  -- id (the shared helpers use auth.uid()), mirroring can_operationally_access_farm:
  -- role='farmer' AND active membership on the request farm.
  owner_active := EXISTS (
      SELECT 1 FROM public.profiles WHERE id = old_owner AND role = 'farmer'
    ) AND EXISTS (
      SELECT 1 FROM public.farm_memberships
      WHERE farm_id = req.farm_id AND user_id = old_owner
    );
  IF owner_active THEN
    RAISE EXCEPTION 'CONFLICT: the current draft owner is still operational'
      USING ERRCODE = 'serialization_failure';
  END IF;

  -- Transfer authority. Only draft_owner_user_id + updated_at change; the
  -- protect-submitted trigger enforces that isolation.
  UPDATE public.evidence_request_responses
  SET draft_owner_user_id = auth.uid(), updated_at = now()
  WHERE id = p_response_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: ownership update affected % row(s)', n
      USING ERRCODE = 'check_violation';
  END IF;

  -- Edit authority has materially changed: bump the request revision so stale
  -- clients holding the old ownership state are invalidated on their next write.
  UPDATE public.evidence_requests
  SET revision = revision + 1, updated_at = now()
  WHERE id = p_request_id;

  -- Audit (append-only). Actor is the new owner; previous/new owners in event_data.
  INSERT INTO public.evidence_request_history (
    request_id, previous_status, next_status, actor_user_id, actor_role,
    event_type, response_id, event_data
  ) VALUES (
    p_request_id, req.status, req.status, auth.uid(), 'farmer',
    'draft_ownership_transferred', p_response_id,
    jsonb_build_object('previous_owner_user_id', old_owner,
                       'new_owner_user_id', auth.uid())
  );

  RETURN (SELECT to_jsonb(r) FROM (
    SELECT id, request_id, response_number, state, response_text,
           created_by_user_id, draft_owner_user_id, submitted_at
    FROM public.evidence_request_responses WHERE id = p_response_id
  ) r);
END
$$;

-- -----------------------------------------------------------------------------
-- 8. Direct-DML denial (contract §6.7, §8.2, §8.5).
--    Clients get SELECT only; every mutation must go through the RPCs above.
--    There are deliberately NO INSERT/UPDATE/DELETE policies on these tables, so
--    even a future accidental GRANT cannot open a direct write path.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.evidence_requests             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.evidence_request_responses    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.evidence_request_attachments  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.evidence_request_history      FROM PUBLIC, anon, authenticated;

-- service_role is NOT exempt from "all writes go through the RPCs". Supabase's
-- ALTER DEFAULT PRIVILEGES grants it full DML on every new table in public, so
-- without this revoke it kept INSERT/UPDATE/DELETE here. That left one way to
-- erase an audit pointer despite the append-only trigger: DELETE a draft
-- attachment (the FK's ON DELETE SET NULL legitimately nulls
-- evidence_request_history.attachment_id), then re-INSERT an identical
-- attachment row. Each step passes its own trigger — the exemption checks the
-- row shape and that the attachment is gone, which is true at that instant —
-- yet the end state is a live attachment whose history event no longer names
-- it. Removing direct DML closes that path at the privilege layer rather than
-- trying to make a row-level trigger infer which statement invoked it.
--
-- SELECT is retained: back-office reads stay possible; only writes are funnelled
-- through the SECURITY DEFINER RPCs, which are owned by postgres and therefore
-- unaffected by this revoke.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.evidence_requests            FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.evidence_request_responses   FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.evidence_request_attachments FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.evidence_request_history     FROM service_role;

GRANT SELECT ON public.evidence_requests            TO authenticated;
GRANT SELECT ON public.evidence_request_responses   TO authenticated;
GRANT SELECT ON public.evidence_request_attachments TO authenticated;
GRANT SELECT ON public.evidence_request_history     TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. RLS (contract §8.2). SELECT-only policies; admin sees all, an operational
--    farmer sees only farms they currently hold membership for. Removing the
--    membership row removes access immediately.
-- -----------------------------------------------------------------------------
ALTER TABLE public.evidence_requests            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_request_responses   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_request_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_request_history     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_requests: admin select all" ON public.evidence_requests;
CREATE POLICY "evidence_requests: admin select all"
  ON public.evidence_requests FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "evidence_requests: operational farmer select own farm" ON public.evidence_requests;
CREATE POLICY "evidence_requests: operational farmer select own farm"
  ON public.evidence_requests FOR SELECT
  USING (public.can_operationally_access_farm(farm_id));

DROP POLICY IF EXISTS "evidence_responses: admin select all" ON public.evidence_request_responses;
CREATE POLICY "evidence_responses: admin select all"
  ON public.evidence_request_responses FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "evidence_responses: operational farmer select own farm" ON public.evidence_request_responses;
CREATE POLICY "evidence_responses: operational farmer select own farm"
  ON public.evidence_request_responses FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.evidence_requests er
    WHERE er.id = evidence_request_responses.request_id
      AND public.can_operationally_access_farm(er.farm_id)
  ));

DROP POLICY IF EXISTS "evidence_attachments: admin select all" ON public.evidence_request_attachments;
CREATE POLICY "evidence_attachments: admin select all"
  ON public.evidence_request_attachments FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "evidence_attachments: operational farmer select own farm" ON public.evidence_request_attachments;
CREATE POLICY "evidence_attachments: operational farmer select own farm"
  ON public.evidence_request_attachments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.evidence_requests er
    WHERE er.id = evidence_request_attachments.request_id
      AND public.can_operationally_access_farm(er.farm_id)
  ));

DROP POLICY IF EXISTS "evidence_history: admin select all" ON public.evidence_request_history;
CREATE POLICY "evidence_history: admin select all"
  ON public.evidence_request_history FOR SELECT
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "evidence_history: operational farmer select own farm" ON public.evidence_request_history;
CREATE POLICY "evidence_history: operational farmer select own farm"
  ON public.evidence_request_history FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.evidence_requests er
    WHERE er.id = evidence_request_history.request_id
      AND public.can_operationally_access_farm(er.farm_id)
  ));

-- -----------------------------------------------------------------------------
-- 10. RPC EXECUTE grants — least privilege. anon never executes anything.
-- -----------------------------------------------------------------------------
-- 10.1 The twelve client-callable RPCs. Written as literal statements (not a
--      format() loop) so the repository's corpus ACL audit can verify each one
--      statically. anon never executes any of them.
REVOKE EXECUTE ON FUNCTION public.create_evidence_request(text,uuid,text,text,text,text,date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_evidence_request(text,uuid,text,text,text,text,date) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_or_create_evidence_response_draft(uuid,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_or_create_evidence_response_draft(uuid,integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.save_evidence_response_draft(uuid,uuid,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.save_evidence_response_draft(uuid,uuid,text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.submit_evidence_response(uuid,uuid,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.submit_evidence_response(uuid,uuid,integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.request_evidence_clarification(uuid,uuid,text,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.request_evidence_clarification(uuid,uuid,text,integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_evidence_request(uuid,uuid,text,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.resolve_evidence_request(uuid,uuid,text,integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.reject_evidence_response(uuid,uuid,text,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reject_evidence_response(uuid,uuid,text,integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.cancel_evidence_request(uuid,text,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cancel_evidence_request(uuid,text,integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.reserve_evidence_attachment(uuid,uuid,text,text,bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reserve_evidence_attachment(uuid,uuid,text,text,bigint) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_evidence_attachment(uuid,uuid,uuid,text,bigint,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.finalize_evidence_attachment(uuid,uuid,uuid,text,bigint,text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.remove_draft_evidence_attachment(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.remove_draft_evidence_attachment(uuid,uuid,uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.link_existing_evidence_document(uuid,uuid,text,uuid,uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.link_existing_evidence_document(uuid,uuid,text,uuid,uuid) TO authenticated, service_role;

-- [v1.1] Draft ownership handoff. Same posture as the other farmer RPCs: no
-- PUBLIC/anon EXECUTE; authenticated + service_role only; role and operational
-- access are re-checked inside the SECURITY DEFINER body.
REVOKE EXECUTE ON FUNCTION public.claim_evidence_response_draft(uuid,uuid,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.claim_evidence_response_draft(uuid,uuid,integer) TO authenticated, service_role;

-- 10.2 Internal helpers. Never client-callable: they run inside the SECURITY
--      DEFINER RPCs above, in the definer's privilege context, so no client role
--      needs EXECUTE. Deliberate no-grant decisions:
--        acl-no-grant: evidence_apply_transition
--        acl-no-grant: evidence_lock_visible_request
--        acl-no-grant: evidence_request_as_json
--        acl-no-grant: evidence_actor_role
REVOKE EXECUTE ON FUNCTION public.evidence_apply_transition(uuid,integer,text,text,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_lock_visible_request(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_request_as_json(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_actor_role() FROM PUBLIC, anon, authenticated, service_role;

-- 10.3 Canonical value helpers. Evaluated inside CHECK constraints and inside
--      the SECURITY DEFINER RPCs, both of which run as the definer, so no
--      client grant is required. Deliberate no-grant decisions:
--        acl-no-grant: evidence_request_statuses
--        acl-no-grant: evidence_request_terminal_statuses
--        acl-no-grant: evidence_request_priorities
--        acl-no-grant: evidence_request_categories
--        acl-no-grant: evidence_category_allows_target
--        acl-no-grant: evidence_mime_allowed
--        acl-no-grant: evidence_max_size_bytes
--        acl-no-grant: evidence_document_mime
--        acl-no-grant: evidence_filename_extension_allowed
REVOKE EXECUTE ON FUNCTION public.evidence_request_statuses() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_request_terminal_statuses() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_request_priorities() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_request_categories() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_category_allows_target(text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_mime_allowed(text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_max_size_bytes(text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_document_mime(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.evidence_filename_extension_allowed(text,text,text) FROM PUBLIC, anon, authenticated, service_role;

-- 10.4 Trigger functions. Invoked only by the trigger machinery, never called
--      directly. Deliberate no-grant decisions:
--        acl-no-grant: fn_evidence_request_validate_scope
--        acl-no-grant: fn_evidence_request_protect_immutable
--        acl-no-grant: fn_evidence_request_no_delete
--        acl-no-grant: fn_evidence_response_protect_submitted
--        acl-no-grant: fn_evidence_attachment_validate
--        acl-no-grant: fn_evidence_history_append_only
REVOKE EXECUTE ON FUNCTION public.fn_evidence_request_validate_scope() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_evidence_request_protect_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_evidence_request_no_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_evidence_response_protect_submitted() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_evidence_attachment_validate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_evidence_history_append_only() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
