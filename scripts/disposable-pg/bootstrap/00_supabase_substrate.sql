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
-- raw_user_meta_data is the JSON blob Supabase Auth attaches to a signup, and
-- handle_new_user() reads it to decide what the new profile is called.
-- Migration 21's VERIFY inserts an auth user carrying it.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb
);

-- Hosted Supabase reads the subject from EITHER the legacy per-claim GUC
-- (request.jwt.claim.sub) OR the whole-claims JSON (request.jwt.claims), and
-- coalesces them in that order. Reading only the legacy GUC silently returns
-- NULL for any caller that sets the JSON form: migration 27's VERIFY sets
-- request.jwt.claims, so its forged-actor section saw auth.uid() = NULL and
-- reported the actor stamp broken when it was the shim that was wrong.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
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
  -- display_name is written by handle_new_user() and read by migration 21's
  -- VERIFY when it asserts what a brand-new auth user becomes.
  display_name text,
  role text,
  -- RLS_ENABLE_STAGED.sql SELECTs this column as its stage-1 smoke test.
  created_at timestamptz NOT NULL DEFAULT now()
);
-- `status`, `reviewed_by` and `updated_at` are the columns an admin review
-- action writes (src/lib/db.ts updateFarmProfileStatus / updateInventoryStatus)
-- and are what migration 35's RPC transitions. Shapes copied from production,
-- measured read-only 2026-07-28: status text NULL, reviewed_by uuid NULL,
-- updated_at timestamptz NOT NULL DEFAULT now(), and NO check constraint on
-- status (the status vocabulary is enforced in TypeScript, not in the database).
-- compliance_status, export_readiness, partner_tier and risk_level join
-- created_by/status/reviewed_by as the seven columns migration 19's field guard
-- pins against a farmer UPDATE. A substrate missing them cannot host the guard,
-- and 19's VERIFY then fails on a missing column rather than on the property it
-- means to test. farm_name comes from the pre-numbering schema
-- (SUPABASE_SCHEMA.sql) and is what the admin list view reads.
CREATE TABLE IF NOT EXISTS public.farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_name text,
  created_by uuid,
  status text,
  compliance_status text,
  export_readiness text,
  partner_tier text,
  risk_level text,
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.farm_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE
);
-- quantity_kg / client_visible / stock_status come from SUPABASE_SCHEMA.sql and
-- FARMER_MVP_MIGRATION.sql (both pre-numbering) and are substrate for every
-- numbered migration. Migration 44's reservation ledger reads all three:
-- quantity_kg is the ceiling availability is computed against, client_visible
-- is what makes a batch reservable at all, and stock_status is present only so
-- a VERIFY can assert the ledger does NOT write to it. It does NOT reproduce
-- the farmer-facing status vocabulary's own guardrails.
CREATE TABLE IF NOT EXISTS public.inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  created_by uuid,
  status text,
  reviewed_by uuid,
  -- product_name is carried by the pre-numbering schema (SUPABASE_SCHEMA.sql).
  -- Omitting it made migration 29's VERIFY fail at its first INSERT, which reads
  -- as "the contaminant gate is broken" rather than "the shim is thin".
  product_name text,
  -- notes is carried by the pre-numbering schema (SUPABASE_SCHEMA.sql) and is the
  -- column migration 18's synthetic runtime check inserts into. Omitting it made
  -- 18 fail at its Block 2 INSERT, which reads as "the runtime check is broken"
  -- rather than "the shim is thin".
  --
  -- It is added here rather than left to SUPABASE_SCHEMA.sql because that file
  -- uses CREATE TABLE IF NOT EXISTS: the substrate has already created
  -- inventory_batches by the time it runs, so its fuller column list is silently
  -- a no-op. That mechanism is why this shim drifts from the real table at all —
  -- production's inventory_batches has 45 columns, SUPABASE_SCHEMA.sql declares
  -- 22, and this shim now declares 15. Each addition here is a symptom; the cure
  -- is a substrate reconciled against production, which is a larger piece of work
  -- and a prerequisite for any migration that alters this table.
  notes text,
  -- The three contaminant verdict columns migration 29's blocker gate reads.
  -- Added by FARMER_MVP_MIGRATION.sql, which creates inventory_batches with
  -- CREATE TABLE IF NOT EXISTS and therefore cannot add them to a table this
  -- substrate has already created.
  heavy_metals_status text,
  pesticides_status text,
  microbial_status text,
  mycotoxins_status text,
  quantity_kg numeric,
  client_visible boolean NOT NULL DEFAULT false,
  stock_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
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
-- `role` distinguishes a farm owner from an ordinary member; migration 19's
-- VERIFY reads it when it sets up the farmer whose UPDATE the guard must pin.
CREATE TABLE IF NOT EXISTS public.farm_memberships (
  -- A surrogate id alongside the natural key: RLS_ENABLE_STAGED.sql selects
  -- fm.id in its stage-2 smoke test.
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid,
  role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, user_id)
);
-- Two further pre-numbering tables. ddp_scores is the per-farm scorecard from
-- SUPABASE_SCHEMA.sql that migrations 15 and 22 harden; market_price_benchmarks
-- is the shared reference table from FARMER_MVP_MIGRATION.sql that migration 22
-- overlays with a RESTRICTIVE operational-farmer read policy.
CREATE TABLE IF NOT EXISTS public.ddp_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  compliance integer,
  documentation integer,
  total_score integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.market_price_benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_type text NOT NULL,
  thc_range text,
  price_min numeric NOT NULL,
  price_max numeric NOT NULL,
  unit text NOT NULL DEFAULT 'kg',
  -- FARMER_MVP_MIGRATION.sql adds this, but it creates the table with
  -- CREATE TABLE IF NOT EXISTS and so cannot amend one this substrate made.
  visible_to_farmers boolean NOT NULL DEFAULT true
);
-- farmer_photos is the farmer-uploaded image table from FARMER_MVP_MIGRATION.sql.
-- Migrations 15 and 22 both harden it, and migration 38 owns its storage policies.
-- farmer_photos and farmer_review_requests are deliberately NOT shimmed here.
-- Mirroring them column-by-column proved to be a trap: FARMER_MVP_MIGRATION.sql
-- creates both with CREATE TABLE IF NOT EXISTS, so any substrate copy silently
-- wins and the migration then fails on a column it believed it had created --
-- three times in a row, on a different column each time. Fixtures that need
-- them apply FARMER_MVP_MIGRATION.sql as a stage instead, which is the
-- authoritative definition.
CREATE TABLE IF NOT EXISTS public.farmer_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  document_type text NOT NULL DEFAULT 'coa',
  file_name text,
  test_date date,
  total_thc numeric,
  total_cbd numeric,
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
  -- Migration 9 declares this column, but 9 creates the table with
  -- CREATE TABLE IF NOT EXISTS -- so against a substrate that already has
  -- compliance_rules the whole statement is skipped and the column never
  -- appears. Migration 26 then fails on the missing column. Carried here
  -- WITHOUT 9's foreign key to public.legal_updates, which 9 itself creates.
  source_legal_update_id uuid,
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

-- =============================================================================
-- RECONCILIATION AGAINST PRODUCTION
-- =============================================================================
-- Everything above this line was written a column at a time, each addition
-- driven by one migration failing on one missing column. That process cannot
-- converge: it only ever adds what some VERIFY happened to touch, so the shim
-- drifts further from the real database with every migration that does NOT
-- fail. Before this section, production's inventory_batches had 45 columns and
-- this file declared 16.
--
-- Why the drift was invisible: three fixtures (4, 15, 22) apply
-- SUPABASE_SCHEMA.sql and FARMER_MVP_MIGRATION.sql as explicit stages, which
-- LOOKS like building the real base schema. Both files use
-- `CREATE TABLE IF NOT EXISTS`, and this substrate has already created those
-- tables by the time they run — so their fuller column lists are a silent
-- no-op. Only their `ALTER TABLE ... ADD COLUMN` statements landed. Measured:
-- that path produced 29 of production's 45 columns on inventory_batches, and
-- the plain substrate produced 16.
--
-- What that costs: a fixture for a migration that alters a column this file
-- does not declare passes VACUOUSLY — the migration matches nothing, changes
-- nothing, and the gate reports green. That is the exact failure mode Phase 1
-- exists to eliminate, reappearing one layer down.
--
-- Derivation (measured 2026-08-04, all reads read-only against production):
--   P = production's public schema                              595 columns
--   R = this substrate + every numbered forward migration        708 columns
--   U = the unnumbered pre-numbering files on a bare prelude     172 columns
--   P - R = 96 columns production has that no numbered migration creates.
--           95 of them appear in U, so they predate numbering and belong HERE.
--           1 of them appears in NO repository file at all — see the drift
--           note on inventory_batches.asking_price_thb below.
-- No column differs in TYPE between P and R. The only object this file
-- declares that production does NOT have is ddp_scores.updated_at, kept
-- because migration 19's field guard pins it; production's ddp_scores has no
-- such column, which is a real finding recorded but not fixed here.
--
-- Added as ALTER rather than folded into the CREATE TABLE bodies above so the
-- reconciliation stays one reviewable block that can be re-derived from
-- production in a single query, instead of being scattered through prose
-- comments that each justify a single column.
-- -----------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS legal_business_name text,
  ADD COLUMN IF NOT EXISTS trading_name text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS district text,
  ADD COLUMN IF NOT EXISTS gps_coordinates text,
  ADD COLUMN IF NOT EXISTS primary_contact text,
  ADD COLUMN IF NOT EXISTS mobile_number text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS completion_percentage integer;

-- farm_profiles is the extreme case: production carries nine jsonb sections and
-- this file declared the primary key and the foreign key alone.
ALTER TABLE public.farm_profiles
  ADD COLUMN IF NOT EXISTS business_info jsonb,
  ADD COLUMN IF NOT EXISTS ownership jsonb,
  ADD COLUMN IF NOT EXISTS licenses jsonb,
  ADD COLUMN IF NOT EXISTS facility jsonb,
  ADD COLUMN IF NOT EXISTS cultivation jsonb,
  ADD COLUMN IF NOT EXISTS strains jsonb,
  ADD COLUMN IF NOT EXISTS lab_testing jsonb,
  ADD COLUMN IF NOT EXISTS export_readiness_data jsonb,
  ADD COLUMN IF NOT EXISTS monthly_reporting jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;

-- asking_price_thb is DRIFT, not substrate: it exists on production's
-- inventory_batches and appears in no .sql, .ts or .tsx file in this
-- repository, on any branch (checked 2026-08-04). It is declared here anyway
-- because a substrate that omits it cannot host a fixture for the migration
-- that has to migrate it — the currency work (D12) would alter a column the
-- test world does not have, match nothing, and pass. Declaring it does not
-- bless it; it makes it testable. Its origin is still unexplained.
--
-- harvest_date, cure_date, test_date and expiry_date are text on production,
-- not date. That is D13, and the shapes here are deliberately production's
-- wrong ones: a substrate that quietly declared them as date would make the
-- migration that converts them a no-op under test.
ALTER TABLE public.inventory_batches
  ADD COLUMN IF NOT EXISTS strain text,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS harvest_date text,
  ADD COLUMN IF NOT EXISTS cure_date text,
  ADD COLUMN IF NOT EXISTS batch_number text,
  ADD COLUMN IF NOT EXISTS thc_percent numeric,
  ADD COLUMN IF NOT EXISTS cbd_percent numeric,
  ADD COLUMN IF NOT EXISTS moisture_percent numeric,
  ADD COLUMN IF NOT EXISTS water_activity numeric,
  ADD COLUMN IF NOT EXISTS quality_grade text,
  ADD COLUMN IF NOT EXISTS price_per_kg numeric,
  ADD COLUMN IF NOT EXISTS coa_file_name text,
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS storage_conditions text,
  ADD COLUMN IF NOT EXISTS product_type text,
  ADD COLUMN IF NOT EXISTS unit text DEFAULT 'kg'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS minimum_order_kg numeric,
  ADD COLUMN IF NOT EXISTS total_terpenes_pct numeric,
  ADD COLUMN IF NOT EXISTS expiry_date text,
  ADD COLUMN IF NOT EXISTS coa_available boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS lab_name text,
  ADD COLUMN IF NOT EXISTS report_number text,
  ADD COLUMN IF NOT EXISTS sample_name text,
  ADD COLUMN IF NOT EXISTS test_date text,
  ADD COLUMN IF NOT EXISTS photo_urls jsonb,
  ADD COLUMN IF NOT EXISTS farmer_notes text,
  ADD COLUMN IF NOT EXISTS owner_notes text,
  ADD COLUMN IF NOT EXISTS asking_price_thb numeric;

ALTER TABLE public.ddp_scores
  ADD COLUMN IF NOT EXISTS facility_quality integer,
  ADD COLUMN IF NOT EXISTS product_quality integer,
  ADD COLUMN IF NOT EXISTS export_readiness integer,
  ADD COLUMN IF NOT EXISTS reliability integer,
  ADD COLUMN IF NOT EXISTS communication integer,
  ADD COLUMN IF NOT EXISTS scalability integer,
  ADD COLUMN IF NOT EXISTS gmp_readiness integer,
  ADD COLUMN IF NOT EXISTS partner_tier text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL;

ALTER TABLE public.market_price_benchmarks
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;

-- lab_name, report_number, sample_name and moisture_pct are the COA provenance
-- fields of D11 — the ones the audits reported as "written by no code". They
-- are production columns regardless of whether anything writes them, so the
-- substrate must carry them; whether a writer exists is a separate question.
ALTER TABLE public.farmer_documents
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS lab_name text,
  ADD COLUMN IF NOT EXISTS report_number text,
  ADD COLUMN IF NOT EXISTS sample_name text,
  ADD COLUMN IF NOT EXISTS moisture_pct numeric,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS expiry_date text,
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS reviewer_note text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;

-- -----------------------------------------------------------------------------
-- Three tables production has that this substrate declared nowhere.
--
-- Migrations 4, 15 and 22 each harden one of them, and each fails outright
-- against the plain substrate ("relation public.risk_flags does not exist").
-- Their fixtures survive only by applying SUPABASE_SCHEMA.sql /
-- FARMER_MVP_MIGRATION.sql as stages — the same files whose column lists this
-- substrate silently suppresses. Declaring the tables here removes that
-- dependency and makes the three migrations applicable from the substrate
-- alone.
--
-- Column shapes, defaults and constraints are production's, measured
-- read-only; they agree exactly with the pre-numbering files that created them.
-- RLS is deliberately NOT enabled on any of the three: enabling it is what
-- migrations 4 and 22 DO, and a substrate that arrived with it already on
-- would make their forward step a no-op and their rollback asymmetric.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.risk_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  flag_type text,
  label text,
  severity text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.farmer_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE CASCADE,
  photo_type text NOT NULL DEFAULT 'product'
    CHECK (photo_type IN ('product', 'packaging', 'batch_label', 'facility', 'other')),
  file_url text NOT NULL,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.farmer_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE CASCADE,
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  request_type text NOT NULL
    CHECK (request_type IN ('coa', 'photo', 'quantity', 'price', 'batch_number', 'licence', 'general')),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  product_name text,
  farm_name text,
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
-- The parameter is named p_farm_id because migration 3 names it that, and
-- PostgreSQL refuses CREATE OR REPLACE when only the parameter NAME differs
-- ("cannot change name of input parameter"). A shim that picked a different
-- name made migration 3 unapplicable in the harness while being invisible to
-- every positional caller.
CREATE OR REPLACE FUNCTION public.has_farm_membership(p_farm_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farm_memberships
    WHERE farm_id = p_farm_id AND user_id = auth.uid()
  )
$$;

-- The two trigger-only guards migration 3 installs. Migration 12's subject is
-- their EXECUTE privilege, so it needs them present -- but migration 3 cannot be
-- chained to provide them: it refuses to run once migration 21's hardened
-- handle_new_user() is installed, which this substrate now models. Shimmed as
-- trigger stubs; their bodies are migration 3's subject, not migration 12's.
CREATE OR REPLACE FUNCTION public.fn_protect_owner_notes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, auth, pg_temp AS $$
BEGIN RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.fn_protect_review_request_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, auth, pg_temp AS $$
BEGIN RETURN NEW; END $$;

-- The EXECUTE posture migration 3 established, reproduced here because migration 3
-- itself cannot be applied against this substrate (it refuses once migration 21's
-- hardened handle_new_user() is installed, which this substrate models).
--
-- Getting this wrong is not a cosmetic inaccuracy. A GRANT does not displace
-- PUBLIC's default EXECUTE, so a substrate that only GRANTs leaves PUBLIC holding
-- EXECUTE on every one of these functions. Migration 12's ROLLBACK restores a
-- baseline its own header records as measured on staging and production --
-- PUBLIC=false, anon=false -- so against a PUBLIC-holding substrate that correct
-- rollback is reported as destroying six privileges it never had any business
-- restoring. The migration was right and the shim was wrong.
REVOKE EXECUTE ON FUNCTION public.is_ddp_admin() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_ddp_admin() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_operational_farmer_access() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_operational_farmer_access() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_farm_membership(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_farm_membership(uuid) TO authenticated, service_role;

-- Migration 21 / 23 artifacts a VERIFY coexistence section may check for.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('pending','farmer','ddp_admin'));
-- handle_new_user() must actually CREATE the profile row. A no-op stub was
-- survivable only while nothing invoked it; now that on_auth_user_created is
-- attached, migration 22's VERIFY depends on the real behaviour -- it INSERTs
-- three auth.users and then UPDATEs public.profiles, never inserting a profile
-- itself. Against a stub those UPDATEs touch zero rows and the section fails
-- claiming a farmer was denied farmer access.
--
-- New users land as 'pending', which is the POST-migration-21 behaviour. That is
-- the correct posture for every fixture numbered above 21; migration 21's own
-- fixture replaces this function as its first act, so it is unaffected.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (NEW.id, NEW.email,
          coalesce(NEW.raw_user_meta_data ->> 'display_name', NEW.email),
          'pending')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

-- Trigger-only functions: service_role alone. `authenticated` is deliberately
-- absent -- nothing should call these directly.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_protect_owner_notes() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_protect_owner_notes() TO service_role;

-- The trigger production actually carries. The substrate declared the FUNCTION
-- but never the TRIGGER, which is the same class of under-representation the
-- column reconciliation fixed: a migration that drops this trigger would be a
-- no-op under test and its rollback would ADD a trigger the test world never
-- had, reporting asymmetric for a correct rollback.
--
-- The function above is a STUB here (`BEGIN RETURN NEW; END`) while production's
-- pins owner_notes to OLD. That difference is deliberate and predates this line:
-- the substrate models STRUCTURE, and reproducing the real body would mean
-- maintaining a second copy of a security-critical routine. A migration whose
-- behaviour depends on what this trigger DOES must verify it live.
DROP TRIGGER IF EXISTS trg_protect_owner_notes ON public.inventory_batches;
CREATE TRIGGER trg_protect_owner_notes
  BEFORE UPDATE ON public.inventory_batches
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_owner_notes();
REVOKE EXECUTE ON FUNCTION public.fn_protect_review_request_fields() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_protect_review_request_fields() TO service_role;

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
-- public.inventory_batches RLS — represents INVENTORY_BATCHES_RLS_PATCH.sql /
-- migration 22's operational-access overlay. Needed because migration 44's
-- VERIFY section H switches to `authenticated` and asserts that a BUYER holding
-- a reservation cannot reach the batch row behind it; without RLS here the
-- shim would report a double-blind breach that production does not have, or
-- worse, pass a test that proves nothing. It approximates the real predicate
-- (admin, or a member of the owning farm) and does NOT reproduce the full
-- policy set, the farmer write guardrails, or migration 22's RESTRICTIVE overlay.
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_batches_substrate_select ON public.inventory_batches;
CREATE POLICY inventory_batches_substrate_select ON public.inventory_batches
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_farm_membership(farm_id));
GRANT SELECT ON public.inventory_batches TO authenticated;

-- The four PERMISSIVE policies that production carries on inventory_batches,
-- from FARMER_MVP_MIGRATION.sql plus INVENTORY_BATCHES_RLS_PATCH.sql (a manual
-- hotfix recorded, but never renumbered, after the MVP migration left only one
-- policy in place). Migration 22 overlays a RESTRICTIVE operational-farmer
-- policy on top of these and its VERIFY E asserts that it did not DROP them --
-- an assertion that cannot fail, and so cannot pass meaningfully, on a substrate
-- where they never existed.
--
-- The predicates are faithful in shape but condensed: the real farmer insert and
-- update policies also pin client_visible, self-approval and stock_status
-- transitions. Those guardrails are migration 22's subject matter, not this
-- substrate's, and no fixture asserts them here.
DROP POLICY IF EXISTS "inventory_batches: admin all" ON public.inventory_batches;
CREATE POLICY "inventory_batches: admin all" ON public.inventory_batches
  FOR ALL USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());
DROP POLICY IF EXISTS "inventory_batches: farmer select own" ON public.inventory_batches;
CREATE POLICY "inventory_batches: farmer select own" ON public.inventory_batches
  FOR SELECT USING (created_by = auth.uid() OR public.has_farm_membership(farm_id));
DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;
CREATE POLICY "inventory_batches: farmer insert own" ON public.inventory_batches
  FOR INSERT WITH CHECK (
    (created_by = auth.uid() OR public.has_farm_membership(farm_id))
    AND client_visible = false);
DROP POLICY IF EXISTS "inventory_batches: farmer update own" ON public.inventory_batches;
CREATE POLICY "inventory_batches: farmer update own" ON public.inventory_batches
  FOR UPDATE USING (created_by = auth.uid() OR public.has_farm_membership(farm_id))
  WITH CHECK (client_visible = false);
GRANT INSERT, UPDATE ON public.inventory_batches TO authenticated;

-- The remaining two permissive policies migration 22's VERIFY E requires to
-- have pre-existed before its RESTRICTIVE overlay went on.
ALTER TABLE public.farm_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_memberships: farmer insert own" ON public.farm_memberships;
CREATE POLICY "farm_memberships: farmer insert own" ON public.farm_memberships
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT ON public.farm_memberships TO authenticated;

ALTER TABLE public.market_price_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "market_price_benchmarks: farmer select visible" ON public.market_price_benchmarks;
CREATE POLICY "market_price_benchmarks: farmer select visible" ON public.market_price_benchmarks
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.market_price_benchmarks TO authenticated;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage, public, auth TO anon, authenticated, service_role;
GRANT SELECT ON storage.objects TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT INSERT, DELETE ON storage.objects TO authenticated;

-- -----------------------------------------------------------------------------
-- public.farms base RLS. These policies belong to the pre-numbering application
-- schema and are created by NO file in this repository, so a substrate without
-- them cannot host any migration that amends them. Migration 19 refuses to run
-- its farmer-UPDATE section without "farms: farmer update own" and reports the
-- absence as a PRECONDITION FAILED; migration 22's VERIFY E asserts that the
-- pre-existing permissive policies were not dropped, which is unprovable if they
-- never existed. Names are taken verbatim from those two VERIFY scripts.
-- -----------------------------------------------------------------------------
ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farms: admin all" ON public.farms;
CREATE POLICY "farms: admin all" ON public.farms
  FOR ALL TO authenticated
  USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());
DROP POLICY IF EXISTS "farms: farmer update own" ON public.farms;
CREATE POLICY "farms: farmer update own" ON public.farms
  FOR UPDATE TO authenticated
  USING (public.has_farm_membership(id)) WITH CHECK (public.has_farm_membership(id));
-- Without a SELECT policy the farmer UPDATE below matches NO rows, and every
-- "the farmer could not change this column" assertion in migration 19's VERIFY
-- passes because nothing happened at all -- the false-negative this substrate
-- must not manufacture. Only 19's check on an ALLOWED column catches it.
DROP POLICY IF EXISTS "farms: farmer select own" ON public.farms;
CREATE POLICY "farms: farmer select own" ON public.farms
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.has_farm_membership(id));
DROP POLICY IF EXISTS "farms: farmer insert own" ON public.farms;
-- Deliberately NOT written in terms of has_operational_farmer_access(): that
-- function belongs to migration 22, whose ROLLBACK drops it. A substrate policy
-- depending on it makes that DROP fail with "other objects depend on it", so
-- migration 22 would be untestable because of how its own substrate was written.
CREATE POLICY "farms: farmer insert own" ON public.farms
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
GRANT SELECT, INSERT, UPDATE ON public.farms TO authenticated;

-- -----------------------------------------------------------------------------
-- The on_auth_user_created trigger. handle_new_user() was already shimmed as a
-- function, but Supabase attaches it to auth.users with this trigger, and
-- migration 21 exists precisely to change what that trigger does (a brand-new
-- auth user must land as 'pending', never 'farmer'). Without the trigger the
-- function is unreachable and 21's VERIFY A reports "no profile row was created
-- for the new auth user" -- a true statement about the shim, not about 21.
--
-- NOTE the knock-on effect: any fixture that INSERTs into auth.users now gets a
-- profiles row automatically, so a later "seed the profile" INSERT ... ON
-- CONFLICT DO NOTHING silently no-ops instead of writing its intended role.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Supabase's broad default privileges on the public schema. These govern tables
-- that do not exist yet, so nothing about the present catalog reveals them --
-- which is exactly why migration 14 exists to narrow them. Without this the
-- baseline has no pg_default_acl row at all, so 14's rollback (which GRANTs the
-- broad set back) looks like it invented privileges from nowhere.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated;

-- ...and the same broad grants on the tables that already exist. Supabase ships
-- the public schema this way; RLS, not table privileges, is what actually
-- constrains anon and authenticated. Migration 15's ROLLBACK restores these
-- grants, so without them here that correct rollback appears to invent
-- privileges from nowhere on eighteen table/grantee pairs.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;

-- REMOVED 2026-08-04 (defect D9). This line used to follow:
--
--   REVOKE DELETE, UPDATE ON public.compliance_audit_log FROM anon;
--
-- justified as "the pre-15 posture differed by role", on the grounds that
-- migration 15's ROLLBACK restores DELETE and UPDATE to `authenticated` but not
-- to `anon`. That reasoning runs backwards: it derives what the world was from
-- what the rollback does, which is the one thing the fixture is supposed to be
-- checking. With the carve-out in place, 15's forward
--
--   REVOKE UPDATE, DELETE ON public.compliance_audit_log FROM anon, authenticated
--
-- removed nothing from anon, so half of that statement was never exercised, and
-- the rollback's failure to restore anon could not be seen because there was
-- nothing to restore.
--
-- Production settles it. Measured read-only on 2026-08-04, prod's pg_default_acl
-- grants `anon` DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE
-- and UPDATE on every new table in `public` — from BOTH the postgres and
-- supabase_admin default-ACL entries — and 22 public tables still carry
-- DELETE/UPDATE for anon today. compliance_audit_log is created by migration 9
-- as postgres, so at the moment migration 15 ran, anon HELD update and delete on
-- it. The REVOKE was load-bearing.
--
-- Consequence, which is a real finding rather than a regression: with the true
-- baseline restored, migration 15's rollback is asymmetric — it under-restores
-- anon. That is fail-safe (anon ends with fewer privileges than it started) but
-- it is not a reversal, and it is registered in lib/known-asymmetries.mjs rather
-- than hidden in the substrate again.
