-- =============================================================================
-- Auth/storage substrate for replaying the REAL production public schema.
--
-- `ddp_ro` has SELECT on public and NO USAGE on `auth` or `storage`, so a
-- production dump can only ever contain the public schema. This file supplies
-- what the dump therefore cannot: the roles its GRANTs name, the schemas its
-- functions qualify, and the handful of auth/storage objects its policies call.
--
-- DELIBERATELY NOT scripts/disposable-pg/bootstrap/00_supabase_substrate.sql.
-- That file also creates public tables (farms, documents, farmer_documents …)
-- and CREATE OR REPLACEs public functions including is_ddp_admin. Loading it
-- alongside a real dump would silently substitute simplified definitions for
-- the very objects under test — which is the entire point of this exercise.
-- Nothing here touches the public schema.
-- =============================================================================

-- Roles named by the dump's GRANT, POLICY and ALTER DEFAULT PRIVILEGES
-- statements. A role missing from this list aborts the load part-way through
-- under ON_ERROR_STOP, which is why replay.sh asserts the load completed rather
-- than trusting that VERIFY passed afterwards — see the note there.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'anon','authenticated','service_role','authenticator',
    'supabase_admin','supabase_auth_admin','supabase_storage_admin',
    'dashboard_user','supabase_read_only_user','pgbouncer',
    'ddp_ro','ddp_audit_reader'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS graphql_public;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Matches the disposable harness's shim exactly, so a VERIFY written for one
-- runs unchanged against the other. Supabase's real auth.uid() also reads the
-- request.jwt.claims JSON; `request.jwt.claim.sub` is the path every VERIFY in
-- this repository sets.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/')
$$;

GRANT USAGE ON SCHEMA auth, storage, extensions, public
  TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt()
  TO anon, authenticated, service_role;
