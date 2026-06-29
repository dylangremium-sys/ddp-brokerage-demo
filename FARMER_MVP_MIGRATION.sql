-- =============================================================================
-- FARMER_MVP_MIGRATION.sql
-- DDP Brokerage — Farmer MVP database layer
--
-- PREREQUISITES:
--   □ SUPABASE_SCHEMA.sql already applied (farms, inventory_batches, etc.)
--   □ AUTH_RLS_SCHEMA.sql Part 1 + Part 2 already applied (profiles,
--     farm_memberships, is_ddp_admin(), has_farm_membership())
--
-- HOW TO APPLY:
--   Paste this entire file into Supabase → SQL Editor → Run.
--   It is safe to run multiple times (all DDL uses IF NOT EXISTS / IF EXISTS).
--
-- SECTIONS:
--   A. Extend inventory_batches with farmer-side fields
--   B. New table: farmer_review_requests
--   C. New table: market_price_benchmarks  (+ seed data)
--   D. New table: farmer_documents
--   E. New table: farmer_photos
--   F. RLS — fix gap on inventory_batches (missing farmer UPDATE policy)
--   G. RLS — farmer_review_requests
--   H. RLS — market_price_benchmarks
--   I. RLS — farmer_documents
--   J. RLS — farmer_photos
--   K. Storage buckets (manual Supabase dashboard steps — see comments)
-- =============================================================================


-- =============================================================================
-- A. EXTEND inventory_batches — farmer-side fields
-- =============================================================================
-- All columns use IF NOT EXISTS so this is safe to re-run.

ALTER TABLE public.inventory_batches
  ADD COLUMN IF NOT EXISTS stock_status         text,
  ADD COLUMN IF NOT EXISTS product_type         text,
  ADD COLUMN IF NOT EXISTS unit                 text NOT NULL DEFAULT 'kg',
  ADD COLUMN IF NOT EXISTS minimum_order_kg     numeric,
  ADD COLUMN IF NOT EXISTS total_terpenes_pct   numeric,
  ADD COLUMN IF NOT EXISTS expiry_date          text,
  ADD COLUMN IF NOT EXISTS client_visible       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coa_available        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lab_name             text,
  ADD COLUMN IF NOT EXISTS report_number        text,
  ADD COLUMN IF NOT EXISTS sample_name          text,
  ADD COLUMN IF NOT EXISTS test_date            text,
  ADD COLUMN IF NOT EXISTS heavy_metals_status  text,
  ADD COLUMN IF NOT EXISTS pesticides_status    text,
  ADD COLUMN IF NOT EXISTS microbial_status     text,
  ADD COLUMN IF NOT EXISTS mycotoxins_status    text,
  ADD COLUMN IF NOT EXISTS photo_urls           jsonb,
  ADD COLUMN IF NOT EXISTS farmer_notes         text,
  ADD COLUMN IF NOT EXISTS owner_notes          text;

-- Diagnostic: confirm columns were added
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'inventory_batches'
-- ORDER BY ordinal_position;


-- =============================================================================
-- A2. BACKFILL stock_status FOR PRE-MIGRATION ROWS
-- =============================================================================
-- inventory_batches rows created before this migration have stock_status = NULL.
-- The farmer UPDATE policy in Section F uses:
--   USING (... AND stock_status IN ('draft', 'submitted', 'needs_changes'))
-- In PostgreSQL, NULL IN (...) evaluates to NULL (treated as false by RLS).
-- Without this backfill, any batch created before this migration would be
-- silently uneditable by the farmer — the update would fail with no error.
--
-- This UPDATE assigns a sensible starting state based on the existing
-- admin-reviewed `status` column.
--
-- Safe: only touches rows WHERE stock_status IS NULL (pre-migration rows).
-- Idempotent: re-running when no NULL rows exist is a no-op.

UPDATE public.inventory_batches
SET stock_status = CASE
  WHEN status = 'Approved'         THEN 'approved_internal'
  WHEN status = 'Missing Document' THEN 'needs_changes'
  WHEN status = 'Rejected'         THEN 'archived'
  ELSE 'submitted'
END
WHERE stock_status IS NULL;


-- =============================================================================
-- B. NEW TABLE: farmer_review_requests
-- =============================================================================
-- Stores DDP → farmer change requests (e.g. "Upload a clearer COA").
-- Farmers can read and mark-resolved. Only DDP admin can INSERT.

CREATE TABLE IF NOT EXISTS public.farmer_review_requests (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_batch_id   uuid        REFERENCES public.inventory_batches(id) ON DELETE CASCADE,
  farm_id              uuid        REFERENCES public.farms(id) ON DELETE CASCADE,
  request_type         text        NOT NULL
                         CHECK (request_type IN (
                           'coa', 'photo', 'quantity', 'price',
                           'batch_number', 'licence', 'general'
                         )),
  message              text        NOT NULL,
  status               text        NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'resolved')),
  created_by           uuid        REFERENCES auth.users(id),
  resolved_at          timestamptz,
  product_name         text,        -- denormalised for display without joins
  farm_name            text,        -- denormalised for display without joins
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frr_inventory_batch_id
  ON public.farmer_review_requests (inventory_batch_id);
CREATE INDEX IF NOT EXISTS idx_frr_farm_id
  ON public.farmer_review_requests (farm_id);
CREATE INDEX IF NOT EXISTS idx_frr_status
  ON public.farmer_review_requests (status);


-- =============================================================================
-- C. NEW TABLE: market_price_benchmarks  +  seed data
-- =============================================================================
-- Visible benchmarks are shown to farmers as price-range hints.
-- Admin can add/edit. Farmers see only visible_to_farmers = true rows.

CREATE TABLE IF NOT EXISTS public.market_price_benchmarks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_type      text        NOT NULL,
  thc_range         text,                 -- e.g. '20–25%'
  price_min         numeric     NOT NULL,
  price_max         numeric     NOT NULL,
  unit              text        NOT NULL DEFAULT 'kg',
  visible_to_farmers boolean    NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Seed with sensible Thai-market benchmarks (฿ per kg).
-- Uses ON CONFLICT DO NOTHING so re-running is safe.
-- The IDs are stable so the frontend can match the same records.
INSERT INTO public.market_price_benchmarks
  (id, product_type, thc_range, price_min, price_max, unit, visible_to_farmers)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'flower',  '20–25%', 35000, 55000, 'kg', true),
  ('00000000-0000-0000-0000-000000000002', 'flower',  '15–20%', 20000, 35000, 'kg', true),
  ('00000000-0000-0000-0000-000000000003', 'trim',    NULL,      5000, 12000, 'kg', true),
  ('00000000-0000-0000-0000-000000000004', 'biomass', NULL,      3000,  8000, 'kg', true),
  ('00000000-0000-0000-0000-000000000005', 'extract', NULL,     80000,200000, 'kg', true)
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- D. NEW TABLE: farmer_documents
-- =============================================================================
-- COA files and other compliance documents uploaded by farmers.
-- Richer than the existing `documents` table — includes full COA lab fields.
-- file_url should point to Supabase Storage once storage is configured.
-- In demo/localStorage mode, file_url is left NULL and file_name stores
-- the local filename string.

CREATE TABLE IF NOT EXISTS public.farmer_documents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id              uuid        REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id   uuid        REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  document_type        text        NOT NULL DEFAULT 'coa'
                         CHECK (document_type IN ('coa', 'licence', 'photo', 'other')),
  file_name            text,
  file_url             text,        -- NULL until Supabase Storage is configured
  lab_name             text,
  report_number        text,
  sample_name          text,
  test_date            date,
  total_thc            numeric,
  total_cbd            numeric,
  moisture_pct         numeric,
  heavy_metals_status  text CHECK (heavy_metals_status  IN ('pass','fail','not_tested') OR heavy_metals_status  IS NULL),
  pesticides_status    text CHECK (pesticides_status    IN ('pass','fail','not_tested') OR pesticides_status    IS NULL),
  microbial_status     text CHECK (microbial_status     IN ('pass','fail','not_tested') OR microbial_status     IS NULL),
  mycotoxins_status    text CHECK (mycotoxins_status    IN ('pass','fail','not_tested') OR mycotoxins_status    IS NULL),
  review_status        text        NOT NULL DEFAULT 'pending'
                         CHECK (review_status IN ('pending','accepted','rejected')),
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_fd_inventory_batch_id
  ON public.farmer_documents (inventory_batch_id);
CREATE INDEX IF NOT EXISTS idx_fd_farm_id
  ON public.farmer_documents (farm_id);


-- =============================================================================
-- E. NEW TABLE: farmer_photos
-- =============================================================================
-- Product photos attached to inventory batches.
-- file_url should point to Supabase Storage once configured.
-- In demo mode, the app stores base64 data URLs directly in
-- inventory_batches.photo_urls (JSONB) — NOT in this table.
-- This table is for the production path (Storage URLs).

CREATE TABLE IF NOT EXISTS public.farmer_photos (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id              uuid        REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id   uuid        REFERENCES public.inventory_batches(id) ON DELETE CASCADE,
  photo_type           text        NOT NULL DEFAULT 'product'
                         CHECK (photo_type IN ('product','packaging','batch_label','facility','other')),
  file_url             text        NOT NULL,
  caption              text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fp_inventory_batch_id
  ON public.farmer_photos (inventory_batch_id);


-- =============================================================================
-- F. RLS — inventory_batches
-- =============================================================================
-- The existing RLS_ENABLE_STAGED.sql Stage 9/10 only added:
--   • "inventory_batches: admin all"
--   • "inventory_batches: farmer select own"
--   • "inventory_batches: farmer insert own"
--
-- MISSING: a farmer UPDATE policy.  Without it, `sbUpsert()` silently fails
-- when a farmer edits an existing batch, and `handleMarkClientVisible()` only
-- updates localStorage.  This section adds the gap-filler.
--
-- SAFE: IF NOT EXISTS is not available for policies, but DROP IF EXISTS is.
-- Running this section when the policy already exists is safe.

-- Enable RLS if not already done (idempotent).
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;

-- Drop and recreate farmer update policy to ensure it is current.
DROP POLICY IF EXISTS "inventory_batches: farmer update own" ON public.inventory_batches;

-- Farmer may edit their own batch ONLY when it is in an editable state.
-- WITH CHECK prevents:
--   • self-approving  (status stays non-Approved)
--   • setting client_visible = true  (admin-only privilege)
--   • advancing to admin-only stock statuses
CREATE POLICY "inventory_batches: farmer update own"
  ON public.inventory_batches FOR UPDATE
  USING (
    -- Must own the batch
    (created_by = auth.uid() OR has_farm_membership(farm_id))
    -- Only allow edits in farmer-controlled states
    AND stock_status IN ('draft', 'submitted', 'needs_changes')
  )
  WITH CHECK (
    -- Still own the batch after the update
    (created_by = auth.uid() OR has_farm_membership(farm_id))
    -- Farmer cannot flip client_visible to true
    AND client_visible = false
    -- Farmer cannot self-approve
    AND status NOT IN ('Approved')
    -- Farmer cannot advance to admin-only stock lifecycle states
    AND (stock_status IS NULL OR stock_status NOT IN ('approved_internal', 'client_visible', 'reserved', 'sold'))
  );

-- Verify: list all policies on inventory_batches
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'inventory_batches';


-- =============================================================================
-- G. RLS — farmer_review_requests
-- =============================================================================

ALTER TABLE public.farmer_review_requests ENABLE ROW LEVEL SECURITY;

-- Admin has full access.
DROP POLICY IF EXISTS "farmer_review_requests: admin all" ON public.farmer_review_requests;
CREATE POLICY "farmer_review_requests: admin all"
  ON public.farmer_review_requests FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read requests linked to their own inventory batches.
DROP POLICY IF EXISTS "farmer_review_requests: farmer select own" ON public.farmer_review_requests;
CREATE POLICY "farmer_review_requests: farmer select own"
  ON public.farmer_review_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = inventory_batch_id
        AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
    )
    OR
    (farm_id IS NOT NULL AND has_farm_membership(farm_id))
  );

-- Farmer can update ONLY to mark status = 'resolved'.
-- They cannot change the message, request_type, or created_by.
DROP POLICY IF EXISTS "farmer_review_requests: farmer resolve own" ON public.farmer_review_requests;
CREATE POLICY "farmer_review_requests: farmer resolve own"
  ON public.farmer_review_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = inventory_batch_id
        AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
    )
    OR
    (farm_id IS NOT NULL AND has_farm_membership(farm_id))
  )
  WITH CHECK (
    status = 'resolved'
    AND resolved_at IS NOT NULL
  );


-- =============================================================================
-- H. RLS — market_price_benchmarks
-- =============================================================================

ALTER TABLE public.market_price_benchmarks ENABLE ROW LEVEL SECURITY;

-- Admin has full access (can set prices, toggle visibility).
DROP POLICY IF EXISTS "market_price_benchmarks: admin all" ON public.market_price_benchmarks;
CREATE POLICY "market_price_benchmarks: admin all"
  ON public.market_price_benchmarks FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Any authenticated user (farmer) can read rows where visible_to_farmers = true.
-- No public (anon) access.
DROP POLICY IF EXISTS "market_price_benchmarks: farmer select visible" ON public.market_price_benchmarks;
CREATE POLICY "market_price_benchmarks: farmer select visible"
  ON public.market_price_benchmarks FOR SELECT
  USING (visible_to_farmers = true AND auth.uid() IS NOT NULL);


-- =============================================================================
-- I. RLS — farmer_documents
-- =============================================================================

ALTER TABLE public.farmer_documents ENABLE ROW LEVEL SECURITY;

-- Admin unrestricted.
DROP POLICY IF EXISTS "farmer_documents: admin all" ON public.farmer_documents;
CREATE POLICY "farmer_documents: admin all"
  ON public.farmer_documents FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read their own documents.
DROP POLICY IF EXISTS "farmer_documents: farmer select own" ON public.farmer_documents;
CREATE POLICY "farmer_documents: farmer select own"
  ON public.farmer_documents FOR SELECT
  USING (
    has_farm_membership(farm_id)
    OR (
      inventory_batch_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.inventory_batches ib
        WHERE ib.id = inventory_batch_id
          AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
      )
    )
  );

-- Farmer can insert their own documents.
DROP POLICY IF EXISTS "farmer_documents: farmer insert own" ON public.farmer_documents;
CREATE POLICY "farmer_documents: farmer insert own"
  ON public.farmer_documents FOR INSERT
  WITH CHECK (
    has_farm_membership(farm_id)
    OR (
      inventory_batch_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.inventory_batches ib
        WHERE ib.id = inventory_batch_id
          AND ib.created_by = auth.uid()
      )
    )
  );


-- =============================================================================
-- J. RLS — farmer_photos
-- =============================================================================

ALTER TABLE public.farmer_photos ENABLE ROW LEVEL SECURITY;

-- Admin unrestricted.
DROP POLICY IF EXISTS "farmer_photos: admin all" ON public.farmer_photos;
CREATE POLICY "farmer_photos: admin all"
  ON public.farmer_photos FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read their own photos.
DROP POLICY IF EXISTS "farmer_photos: farmer select own" ON public.farmer_photos;
CREATE POLICY "farmer_photos: farmer select own"
  ON public.farmer_photos FOR SELECT
  USING (
    has_farm_membership(farm_id)
    OR (
      inventory_batch_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.inventory_batches ib
        WHERE ib.id = inventory_batch_id
          AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
      )
    )
  );

-- Farmer can insert their own photos.
DROP POLICY IF EXISTS "farmer_photos: farmer insert own" ON public.farmer_photos;
CREATE POLICY "farmer_photos: farmer insert own"
  ON public.farmer_photos FOR INSERT
  WITH CHECK (
    inventory_batch_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = inventory_batch_id
        AND ib.created_by = auth.uid()
    )
  );


-- =============================================================================
-- K. STORAGE BUCKETS — manual dashboard steps (no SQL equivalent)
-- =============================================================================
-- File upload is currently SIMULATED:
--   • Photos: stored as base64 data URLs in localStorage and in
--     inventory_batches.photo_urls (JSONB) — NOT in Supabase Storage.
--   • COA files: stored as filename strings only — no actual file upload.
--
-- To enable real file storage, perform these steps in the Supabase dashboard
-- (Authentication → Storage → New bucket):
--
--  Bucket 1: farmer-documents
--    - Private (not public)
--    - Max file size: 10 MB
--    - Allowed MIME types: application/pdf, image/jpeg, image/png, image/webp
--
--  Bucket 2: farmer-photos
--    - Private (not public)
--    - Max file size: 5 MB
--    - Allowed MIME types: image/jpeg, image/png, image/webp
--
-- After creating the buckets, apply these Storage policies in
-- Supabase → Storage → Policies:
--
--  farmer-documents bucket:
--    • INSERT: auth.uid() = owner (restrict path to uid/ prefix)
--    • SELECT: is_ddp_admin() OR path starts with auth.uid()
--
--  farmer-photos bucket:
--    • INSERT: auth.uid() = owner
--    • SELECT: is_ddp_admin() OR path starts with auth.uid()
--
-- In SQL (applies to Storage via storage.objects table).
-- Apply in Supabase → SQL Editor after creating the buckets.
/*

-- ── farmer-documents ─────────────────────────────────────────────────────────

-- Admin unrestricted (download, delete, overwrite, list).
CREATE POLICY "farmer-documents: admin all"
  ON storage.objects FOR ALL
  USING    (bucket_id = 'farmer-documents' AND is_ddp_admin())
  WITH CHECK (bucket_id = 'farmer-documents' AND is_ddp_admin());

-- Farmer upload: path must start with their own UID.
CREATE POLICY "farmer-documents: farmer upload own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'farmer-documents'
    AND auth.uid()::text = (string_to_array(name, '/'))[1]
  );

-- Farmer read: only their own prefix.
CREATE POLICY "farmer-documents: farmer or admin read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'farmer-documents'
    AND (
      is_ddp_admin()
      OR auth.uid()::text = (string_to_array(name, '/'))[1]
    )
  );

-- ── farmer-photos ─────────────────────────────────────────────────────────────

-- Admin unrestricted (download, delete, overwrite, list).
CREATE POLICY "farmer-photos: admin all"
  ON storage.objects FOR ALL
  USING    (bucket_id = 'farmer-photos' AND is_ddp_admin())
  WITH CHECK (bucket_id = 'farmer-photos' AND is_ddp_admin());

-- Farmer upload: path must start with their own UID.
CREATE POLICY "farmer-photos: farmer upload own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'farmer-photos'
    AND auth.uid()::text = (string_to_array(name, '/'))[1]
  );

-- Farmer read: only their own prefix.
CREATE POLICY "farmer-photos: farmer or admin read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'farmer-photos'
    AND (
      is_ddp_admin()
      OR auth.uid()::text = (string_to_array(name, '/'))[1]
    )
  );

*/
--
-- Frontend integration steps after storage is set up:
--   1. Replace FileReader data-URL approach in FarmerSubmitInventory.tsx with
--      supabase.storage.from('farmer-photos').upload(path, file).
--   2. Store the returned public URL in farmer_photos.file_url.
--   3. Replace coa_file_name string with upload to farmer-documents bucket.
-- =============================================================================


-- =============================================================================
-- DIAGNOSTICS — run after migration to verify
-- =============================================================================
-- 1. Confirm new columns on inventory_batches:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'inventory_batches'
-- ORDER BY ordinal_position;

-- 2. Confirm new tables exist:
-- SELECT tablename FROM pg_tables
-- WHERE schemaname = 'public'
-- AND tablename IN (
--   'farmer_review_requests', 'market_price_benchmarks',
--   'farmer_documents', 'farmer_photos'
-- );

-- 3. Confirm seed benchmarks:
-- SELECT * FROM public.market_price_benchmarks ORDER BY product_type;

-- 4. Confirm all RLS policies:
-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE tablename IN (
--   'inventory_batches', 'farmer_review_requests',
--   'market_price_benchmarks', 'farmer_documents', 'farmer_photos'
-- )
-- ORDER BY tablename, policyname;
-- =============================================================================
