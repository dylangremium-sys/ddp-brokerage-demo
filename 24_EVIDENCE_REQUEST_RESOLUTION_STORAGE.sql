-- =============================================================================
-- Migration 24 — STORAGE companion (Evidence Request & Resolution Workflow)
--
-- Creates the private evidence bucket and its storage.objects policies
-- (contract §7.1, §7.2, §7.6, §8.3).
--
-- WHY THIS IS A SEPARATE FILE
-- CREATE POLICY on storage.objects requires ownership of that table. In a
-- Supabase project storage.objects is owned by supabase_storage_admin, NOT by
-- the role that applies public-schema migrations. If these statements lived in
-- 24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql, a role lacking that membership
-- would fail here and roll back the ENTIRE migration — tables, RPCs and RLS
-- included. Keeping storage separate means a storage-privilege problem costs
-- only the storage layer.
--
-- APPLY ORDER:  24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql  →  this file.
-- ROLLBACK ORDER: this file  →  24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql.
--
-- Precondition: public.can_operationally_access_farm(uuid) (migration 24 forward)
--               public.is_ddp_admin()                      (migration 3)
--
-- Apply with a role holding supabase_storage_admin membership (for example the
-- Supabase dashboard SQL editor).
--
-- NOT APPLIED TO PRODUCTION BY THE IMPLEMENTATION RUN THAT CREATED THIS FILE.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions.
-- -----------------------------------------------------------------------------
DO $precondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_operationally_access_farm'
  ) THEN
    RAISE EXCEPTION
      'migration 24 storage precondition failed: public.can_operationally_access_farm(uuid) '
      'is missing. Apply 24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql first.';
  END IF;

  IF NOT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER')
     AND current_user <> (SELECT tableowner FROM pg_tables
                          WHERE schemaname = 'storage' AND tablename = 'objects') THEN
    RAISE EXCEPTION
      'migration 24 storage precondition failed: current_user "%" is not a member of '
      '"supabase_storage_admin", which owns storage.objects. CREATE POLICY would fail. '
      'Re-run as a role holding that membership (e.g. the Supabase dashboard SQL editor).',
      current_user;
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Private bucket (contract §7.1). public = false: no public URLs are ever
--    permitted; all reads go through short-lived signed URLs.
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('evidence-request-files', 'evidence-request-files', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- -----------------------------------------------------------------------------
-- 2. Object policies (contract §7.2, §8.3).
--
--    Canonical path:
--      <farm_id>/<request_id>/<response_id>/<attachment_id>/<sanitized_filename>
--
--    Authorization is derived from the FIRST path segment (farm_id) and is
--    always cross-checked against a real evidence_request_attachments row, so a
--    caller cannot invent a path for a farm they are not authorized for.
--
--    NOTE: unlike the pre-existing farmer buckets, this bucket is farm-scoped,
--    not {userId}-prefixed. Revoking a farm membership therefore revokes access
--    to previously uploaded evidence immediately.
-- -----------------------------------------------------------------------------

-- 2.1 Administrators may read every evidence object; they never write.
DROP POLICY IF EXISTS "evidence-request-files: admin read" ON storage.objects;
CREATE POLICY "evidence-request-files: admin read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'evidence-request-files' AND public.is_ddp_admin());

-- 2.2 Authorized farmers may read objects belonging to a farm they can access.
DROP POLICY IF EXISTS "evidence-request-files: farmer read own farm" ON storage.objects;
--     Read authority is tied to a LIVE ATTACHMENT ROW, not to the path prefix.
--
--     This previously granted SELECT on anything whose first path segment was a
--     farm the caller can access. That made read access a property of the NAME
--     rather than of the workflow: any object under a known farm prefix was
--     readable, including one with no attachment row at all. Combined with the
--     removal protocol that is exactly the wrong shape — an object that lost or
--     never had its owning row stayed readable to every farm member with no way
--     to delete it, since the DELETE policy does key on the attachment row.
--
--     Anchoring both SELECT and DELETE to the same row removes that asymmetry:
--     an object is readable only while a workflow row claims it, and the farm is
--     taken from the request rather than parsed out of the object name.
CREATE POLICY "evidence-request-files: farmer read own farm"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'evidence-request-files'
    AND EXISTS (
      SELECT 1
      FROM public.evidence_request_attachments a
      JOIN public.evidence_requests er ON er.id = a.request_id
      WHERE a.storage_bucket = 'evidence-request-files'
        AND a.storage_object_path = storage.objects.name
        AND a.origin = 'request_upload'
        AND public.can_operationally_access_farm(er.farm_id)
    )
  );

-- 2.3 Farmers may INSERT only into a path reserved for them by
--     reserve_evidence_attachment(): the object path must match a
--     pending_upload attachment they created, on a draft response.
DROP POLICY IF EXISTS "evidence-request-files: farmer insert reserved path" ON storage.objects;
CREATE POLICY "evidence-request-files: farmer insert reserved path"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'evidence-request-files'
    AND EXISTS (
      SELECT 1
      FROM public.evidence_request_attachments a
      JOIN public.evidence_request_responses r ON r.id = a.response_id
      JOIN public.evidence_requests er         ON er.id = a.request_id
      WHERE a.storage_bucket = 'evidence-request-files'
        AND a.storage_object_path = storage.objects.name
        AND a.origin = 'request_upload'
        AND a.upload_state = 'pending_upload'
        -- Once controlled removal has been authorized the reservation is spent:
        -- no NEW object may be inserted at this path. Without this predicate the
        -- removal marker was decorative for INSERT — remove_draft_evidence_attachment
        -- could mark a row and an upload authorized against the same row would
        -- still be admitted, which is precisely how an object could land with no
        -- attachment row to own it. This is the database half of closing that
        -- race; the RPC half is the two-phase protocol in 7.11.
        AND a.removal_requested_at IS NULL
        AND a.created_by_user_id = auth.uid()
        AND r.state = 'draft'
        AND er.status IN ('open','clarification_requested')
        AND public.can_operationally_access_farm(er.farm_id)
    )
  );

-- 2.4 Farmers may DELETE an object ONLY when remove_draft_evidence_attachment
--     has explicitly authorized that exact object for removal.
--
--     A Supabase Storage object must be deleted through the Storage API; a SQL
--     DELETE against storage.objects removes only the metadata row and orphans
--     the file. The database therefore cannot delete the object itself. Instead
--     the removal RPC sets removal_requested_at on the attachment, opening a
--     narrow window in which the client may delete that one object through the
--     Storage API; the RPC is then called again and completes the removal once
--     it can prove the object is gone.
--
--     Gating on removal_requested_at (rather than on upload_state) is what makes
--     the protocol safe in both directions:
--       * a READY object cannot be deleted before the RPC authorizes it, so a
--         submitted response can never point at a missing object; and
--       * a PENDING object cannot be deleted casually either — it too must be
--         authorized, so the database always knows an object is in the process
--         of going away and can fail submission/finalization closed meanwhile.
--
--     Every other condition still applies: exact reserved path, the attachment's
--     creator, a draft response, and an actionable request.
DROP POLICY IF EXISTS "evidence-request-files: farmer delete own draft" ON storage.objects;
CREATE POLICY "evidence-request-files: farmer delete own draft"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'evidence-request-files'
    AND EXISTS (
      SELECT 1
      FROM public.evidence_request_attachments a
      JOIN public.evidence_request_responses r ON r.id = a.response_id
      JOIN public.evidence_requests er         ON er.id = a.request_id
      WHERE a.storage_bucket = 'evidence-request-files'
        AND a.storage_object_path = storage.objects.name
        AND a.created_by_user_id = auth.uid()
        AND a.origin = 'request_upload'
        AND a.removal_requested_at IS NOT NULL
        AND r.state = 'draft'
        -- DELIBERATELY NOT gated on er.status. Requiring an actionable request
        -- here made this policy and remove_draft_evidence_attachment mutually
        -- gating: after an admin cancelled/resolved/rejected a request holding a
        -- farmer's draft upload, neither the marker could be set nor the object
        -- deleted, stranding unsubmitted files until privileged manual cleanup.
        -- Every other condition still applies, and they are what actually
        -- authorize the delete: the exact reserved path, the attachment's
        -- creator, an explicit removal authorization from the RPC, a DRAFT
        -- response (so submitted evidence is never deletable), and operational
        -- access to the owning farm. Adding evidence still requires an
        -- actionable request — see the INSERT policy above, which keeps it.
        AND public.can_operationally_access_farm(er.farm_id)
    )
  );

-- 2.5 No UPDATE policy exists for any client role: an uploaded evidence object
--     is never overwritten in place. Replacement is a new response cycle.

-- 2.6 Restrictive backstop: nothing in this bucket is reachable by a caller who
--     is neither a DDP admin nor an operational farmer for the path's farm.
--     This ANDs with every permissive policy above, so a future permissive
--     policy cannot accidentally widen access to pending or anonymous callers.
DROP POLICY IF EXISTS "evidence-request-files: operational farmer or admin" ON storage.objects;
CREATE POLICY "evidence-request-files: operational farmer or admin"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  USING (
    bucket_id IS DISTINCT FROM 'evidence-request-files'
    OR public.is_ddp_admin()
    OR public.can_operationally_access_farm(
         NULLIF((string_to_array(name, '/'))[1], '')::uuid)
  )
  WITH CHECK (
    bucket_id IS DISTINCT FROM 'evidence-request-files'
    OR public.is_ddp_admin()
    OR public.can_operationally_access_farm(
         NULLIF((string_to_array(name, '/'))[1], '')::uuid)
  );

COMMIT;

-- =============================================================================
-- ROLLBACK (storage companion) — run BEFORE 24_..._ROLLBACK.sql:
--
--   BEGIN;
--   DROP POLICY IF EXISTS "evidence-request-files: operational farmer or admin"  ON storage.objects;
--   DROP POLICY IF EXISTS "evidence-request-files: farmer delete own draft"      ON storage.objects;
--   DROP POLICY IF EXISTS "evidence-request-files: farmer insert reserved path"  ON storage.objects;
--   DROP POLICY IF EXISTS "evidence-request-files: farmer read own farm"         ON storage.objects;
--   DROP POLICY IF EXISTS "evidence-request-files: admin read"                   ON storage.objects;
--   -- Remove the bucket only when it holds no objects:
--   DELETE FROM storage.buckets WHERE id = 'evidence-request-files'
--     AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'evidence-request-files');
--   COMMIT;
-- =============================================================================
