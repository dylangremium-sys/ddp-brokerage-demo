-- DDP Inventory Demo — Supabase Schema
-- Run this in the Supabase SQL Editor for your project.
-- Enable the pgcrypto extension first if gen_random_uuid() is not available:
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- farms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farms (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_name            TEXT,
  legal_business_name  TEXT,
  trading_name         TEXT,
  province             TEXT,
  district             TEXT,
  gps_coordinates      TEXT,
  primary_contact      TEXT,
  mobile_number        TEXT,
  email                TEXT,
  status               TEXT,                 -- FarmStatus enum values
  completion_percentage INTEGER,
  compliance_status    TEXT,
  export_readiness     TEXT,
  risk_level           TEXT,
  partner_tier         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- farm_profiles  (extended JSON profile data per farm)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id               UUID REFERENCES farms(id) ON DELETE CASCADE,
  business_info         JSONB,
  ownership             JSONB,
  licenses              JSONB,
  facility              JSONB,
  cultivation           JSONB,
  strains               JSONB,
  lab_testing           JSONB,
  export_readiness_data JSONB,
  monthly_reporting     JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- inventory_batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id           UUID REFERENCES farms(id) ON DELETE SET NULL,
  product_name      TEXT,
  strain            TEXT,
  location          TEXT,
  quantity_kg       NUMERIC,
  harvest_date      TEXT,
  cure_date         TEXT,
  batch_number      TEXT,
  thc_percent       NUMERIC,
  cbd_percent       NUMERIC,
  moisture_percent  NUMERIC,
  water_activity    NUMERIC,
  quality_grade     TEXT,
  price_per_kg      NUMERIC,
  coa_file_name     TEXT,
  photo_url         TEXT,
  storage_conditions TEXT,
  notes             TEXT,
  status            TEXT,                 -- InventoryStatus enum values
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- ddp_scores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ddp_scores (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             UUID REFERENCES farms(id) ON DELETE CASCADE,
  compliance          INTEGER,
  documentation       INTEGER,
  facility_quality    INTEGER,
  product_quality     INTEGER,
  export_readiness    INTEGER,
  reliability         INTEGER,
  communication       INTEGER,
  scalability         INTEGER,
  gmp_readiness       INTEGER,
  total_score         INTEGER,
  partner_tier        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- risk_flags
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_flags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id    UUID REFERENCES farms(id) ON DELETE CASCADE,
  flag_type  TEXT,
  label      TEXT,
  severity   TEXT,          -- 'low' | 'medium' | 'high'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- status_history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT,          -- 'farm' | 'inventory_batch'
  entity_id   UUID,
  old_status  TEXT,
  new_status  TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id              UUID REFERENCES farms(id) ON DELETE CASCADE,
  inventory_batch_id   UUID REFERENCES inventory_batches(id) ON DELETE CASCADE,
  document_type        TEXT,
  file_name            TEXT,
  file_url             TEXT,
  expiry_date          TEXT,
  review_status        TEXT,
  reviewer_note        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS) — enable once auth is added.
-- For now, the demo uses the anon key with RLS disabled or open policies.
-- ---------------------------------------------------------------------------
-- ALTER TABLE farms ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE inventory_batches ENABLE ROW LEVEL SECURITY;
-- etc.

-- Example open read policy for demo (add after enabling RLS):
-- CREATE POLICY "anon read" ON farms FOR SELECT USING (true);
-- CREATE POLICY "anon insert" ON farms FOR INSERT WITH CHECK (true);
-- CREATE POLICY "anon update" ON farms FOR UPDATE USING (true);
