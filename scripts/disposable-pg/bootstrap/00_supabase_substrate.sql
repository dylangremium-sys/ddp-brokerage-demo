-- =============================================================================
-- Disposable-PostgreSQL bootstrap — minimal, faithful Supabase substrate.
--
-- This file recreates ONLY the Supabase/platform + earlier-migration objects that
-- a migration-under-test assumes already exist (normally provided by migrations
-- 1..N-1 and the hosted Supabase platform). Nothing here belongs to any migration
-- under test; it exists solely so a migration triplet + its VERIFY/ROLLBACK can
-- execute against a throwaway, socket-only cluster.
--
-- MINIMUM-SUBSTRATE PRINCIPLE (brief §6): this is a faithful *test substrate*, not
-- a Supabase emulator. Every shimmed object is documented in
-- docs/DISPOSABLE_PG_HARNESS.md with a four-line boundary record
-- (why it exists · which real object it represents · what it approximates · what
-- it does NOT reproduce). Anything not faithfully modelled stays covered by the
-- live-staging harness instead.
--
-- This SQL is deliberately declarative and reviewable — never string-built in JS.
-- Provenance: reconstructed from the proven manual migration-24 disposable run
-- (PostgreSQL 18.4; VERIFY A–R 18/18; rollback STORAGE→main; destructive guard).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles. The exact roles migrations GRANT/REVOKE against. NOLOGIN + no network
-- surface (see the harness's listen_addresses='' posture) means trust is safe.
-- -----------------------------------------------------------------------------
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
END $roles$;

-- -----------------------------------------------------------------------------
-- auth schema + JWT-claim shim.
--   auth.uid() represents Supabase GoTrue's JWT-derived caller id. It reads the
--   `request.jwt.claim.sub` session GUC and returns NULL when unset — exactly the
--   fail-closed shape RLS policies and helpers depend on. It does NOT reproduce
--   real token issuance, signature verification, expiry or refresh.
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Two distinct, fixed users so behavioural sections that need a second actor
-- (e.g. migration-24 VERIFY L, the draft-ownership handoff) can pick actor_a and
-- actor_b deterministically.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-a000-000000000001','a@disposable.test'),
  ('00000000-0000-4000-a000-000000000002','b@disposable.test')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- storage schema + tables.
--   storage.buckets/storage.objects represent the Supabase Storage catalog rows a
--   migration's storage policies read. They are owned by the bootstrap superuser
--   so a migration's STORAGE precondition ("current_user owns storage.objects")
--   is satisfiable without supabase_storage_admin membership. They do NOT
--   reproduce the Storage HTTP API, real object bytes, signed URLs, or the
--   server-side file_size_limit enforcement (that is HTTP-layer, live-staging only).
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  metadata jsonb,
  owner uuid
);

CREATE SCHEMA IF NOT EXISTS extensions;

-- -----------------------------------------------------------------------------
-- Public dependency tables (subset of columns the migrations / VERIFY touch).
-- These represent tables created by earlier migrations (1..23).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  email text,
  role text
);
-- `status`, `reviewed_by` and `updated_at` are the columns an admin review
-- action writes (src/lib/db.ts updateFarmProfileStatus / updateInventoryStatus)
-- and are what migration 35's RPC transitions. Shapes copied from production,
-- measured read-only 2026-07-28: status text NULL, reviewed_by uuid NULL,
-- updated_at timestamptz NOT NULL DEFAULT now(), and NO check constraint on
-- status (the status vocabulary is enforced in TypeScript, not in the database).
CREATE TABLE IF NOT EXISTS public.farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid,
  status text,
  reviewed_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.farm_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  created_by uuid,
  status text,
  reviewed_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- public.status_history — the compliance artefact recording how an entity
-- reached its current status. Created by the pre-numbering schema
-- (SUPABASE_SCHEMA.sql), so it is substrate, not part of any migration under
-- test. Column shapes copied from production, measured read-only 2026-07-28:
-- entity_type/entity_id/old_status/new_status/note are all NULLABLE, and
-- entity_id carries NO foreign key (it addresses two different tables).
CREATE TABLE IF NOT EXISTS public.status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text,
  entity_id uuid,
  old_status text,
  new_status text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.farm_memberships (
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid,
  PRIMARY KEY (farm_id, user_id)
);
-- public.farmer_documents — created by FARMER_MVP_MIGRATION.sql (pre-numbering),
-- so it is substrate for every numbered migration. The review_status and the four
-- contaminant columns are copied from FARMER_MVP_MIGRATION.sql:162-185 because the
-- export gate reads them: a batch whose COA records a FAILED contaminant test, or
-- whose COA has not been accepted by a reviewer, must not clear the gate. It does
-- NOT reproduce migration 28's document_field_extractions provenance layer.
CREATE TABLE IF NOT EXISTS public.farmer_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  document_type text NOT NULL DEFAULT 'coa',
  file_name text,
  test_date date,
  heavy_metals_status text CHECK (heavy_metals_status IN ('pass','fail','not_tested') OR heavy_metals_status IS NULL),
  pesticides_status   text CHECK (pesticides_status   IN ('pass','fail','not_tested') OR pesticides_status   IS NULL),
  microbial_status    text CHECK (microbial_status    IN ('pass','fail','not_tested') OR microbial_status    IS NULL),
  mycotoxins_status   text CHECK (mycotoxins_status   IN ('pass','fail','not_tested') OR mycotoxins_status   IS NULL),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','accepted','rejected')),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  document_type text,
  file_name text
);
-- public.compliance_rules — created by migration 9 (COMPLIANCE_WATCHTOWER_MVP), so
-- it is substrate for anything numbered above it. Shape copied from
-- 9_COMPLIANCE_WATCHTOWER_MVP.sql:56-71. It does NOT reproduce the watchtower's
-- ingestion pipeline, its AI-suggestion flow, or migrations 25/26's provenance
-- and source-governance columns; a migration depending on any of those must
-- declare it and verify against live staging instead.
CREATE TABLE IF NOT EXISTS public.compliance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  jurisdiction text,
  entity_type text NOT NULL CHECK (entity_type IN (
    'farm', 'batch', 'coa', 'buyer', 'document', 'shipment', 'platform_claim', 'data_protection')),
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  is_blocking boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'suggested', 'approved', 'active', 'paused', 'retired', 'rejected')),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- public.compliance_audit_log — created by migration 9 (COMPLIANCE_WATCHTOWER_MVP),
-- so it is substrate for anything numbered above it. Shape copied from
-- 9_COMPLIANCE_WATCHTOWER_MVP.sql:102-129, including the inline `action` CHECK,
-- because migrations that widen the action vocabulary must be able to find the
-- auto-named constraint `compliance_audit_log_action_check` and fail loudly here
-- if its name ever drifts. It does NOT reproduce migration 11's TRUNCATE
-- hardening or migration 27's authoritative-actor rewrite; a migration whose
-- behaviour depends on either must declare that explicitly and verify it live.
CREATE TABLE IF NOT EXISTS public.compliance_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('admin', 'ai_assistant', 'system', 'legal_reviewer')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'legal_update_created', 'legal_update_reviewed', 'rule_suggested', 'rule_approved',
    'rule_paused', 'rule_retired', 'alert_created', 'alert_resolved',
    'readiness_status_changed', 'document_status_changed', 'sent_to_legal_review',
    'reviewer_note_added', 'rule_rejected', 'legal_update_archived', 'alert_dismissed'
  )),
  entity_type text NOT NULL,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Authorization helper functions earlier migrations create. These approximate
-- the real predicates closely enough that policies/triggers evaluate identically;
-- they do NOT reproduce the full role model of the hosted platform.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_ddp_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'ddp_admin')
$$;
CREATE OR REPLACE FUNCTION public.has_operational_farmer_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'farmer')
$$;
CREATE OR REPLACE FUNCTION public.has_farm_membership(target_farm_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farm_memberships
    WHERE farm_id = target_farm_id AND user_id = auth.uid()
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_ddp_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_operational_farmer_access() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_farm_membership(uuid) TO authenticated, service_role;

-- Migration 21 / 23 artifacts a VERIFY coexistence section may check for.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('pending','farmer','ddp_admin'));
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
BEGIN RETURN NEW; END $$;

-- -----------------------------------------------------------------------------
-- RLS harness posture: enable RLS on storage.objects and grant the client roles
-- the table-level privileges Supabase grants them. This is faithful to the hosted
-- platform (Supabase ships storage.objects with RLS ON) and is a PRECONDITION for a
-- future SET ROLE-based enforcement probe — but NOTE: no current fixture issues
-- SET ROLE, so these policies are not yet exercised against a non-privileged caller
-- (VERIFY runs as the owner, which bypasses RLS). See docs "Scope of the RLS claim".
-- The migration under test owns its own policy set; here we only reproduce the
-- platform's baseline grants.
-- -----------------------------------------------------------------------------
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage, public, auth TO anon, authenticated, service_role;
GRANT SELECT ON storage.objects TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT INSERT, DELETE ON storage.objects TO authenticated;
