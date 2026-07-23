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
CREATE TABLE IF NOT EXISTS public.farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid
);
CREATE TABLE IF NOT EXISTS public.farm_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  created_by uuid
);
CREATE TABLE IF NOT EXISTS public.farm_memberships (
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid,
  PRIMARY KEY (farm_id, user_id)
);
CREATE TABLE IF NOT EXISTS public.farmer_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  document_type text NOT NULL DEFAULT 'coa',
  file_name text
);
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  document_type text,
  file_name text
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
-- the table-level privileges Supabase grants them, so an eventual SET ROLE
-- authenticated actually evaluates the storage policies (grant AND RLS both
-- required). The migration under test owns its own policy set; here we only
-- reproduce the platform's baseline grants.
-- -----------------------------------------------------------------------------
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage, public, auth TO anon, authenticated, service_role;
GRANT SELECT ON storage.objects TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT INSERT, DELETE ON storage.objects TO authenticated;
