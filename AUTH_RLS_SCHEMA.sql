-- AUTH_RLS_SCHEMA.sql
-- Run AFTER SUPABASE_SCHEMA.sql has already been applied.
--
-- PART 1: Auth data model — apply immediately, safe to run.
-- PART 2: Helper functions — apply immediately.
-- PART 3: RLS policies     — READ the comments; apply ONLY after auth UI is tested.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- PART 1: AUTH DATA MODEL
-- ============================================================================

-- profiles ─ one row per auth.users row, holds the application role
CREATE TABLE IF NOT EXISTS profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'farmer'
                 CHECK (role IN ('ddp_admin', 'farmer')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- farm_memberships ─ links a user to a farm (owner / operator)
CREATE TABLE IF NOT EXISTS farm_memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id    UUID REFERENCES farms(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'owner'
               CHECK (role IN ('owner', 'operator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, user_id)
);

-- Add audit columns to farms
ALTER TABLE farms ADD COLUMN IF NOT EXISTS created_by  UUID REFERENCES auth.users(id);
ALTER TABLE farms ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id);

-- Add audit columns to inventory_batches
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS created_by  UUID REFERENCES auth.users(id);
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id);

-- ============================================================================
-- PART 2: HELPER FUNCTIONS (safe to apply now — no RLS yet)
-- ============================================================================

-- Auto-create a profiles row whenever a new auth user is inserted.
-- Reads display_name from the raw_user_meta_data set at signUp time.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    'farmer'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- is_ddp_admin() — used by RLS policies
CREATE OR REPLACE FUNCTION is_ddp_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'ddp_admin'
  );
$$;

-- has_farm_membership() — true if current user has any membership for this farm
CREATE OR REPLACE FUNCTION has_farm_membership(p_farm_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farm_memberships
    WHERE farm_id = p_farm_id AND user_id = auth.uid()
  );
$$;

-- ============================================================================
-- PART 3: RLS POLICIES
-- ─────────────────────────────────────────────────────────────────────────────
-- DO NOT APPLY YET. Uncomment and run each block only after:
--   1. Auth UI is tested end-to-end (sign up, sign in, sign out).
--   2. At least one ddp_admin profile exists.
--   3. At least one farmer profile with a farm_membership exists.
--   4. You have verified data reads work correctly without RLS first.
--
-- To enable RLS on a table:   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
-- To disable for debugging:   ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;
-- To bypass for owner:        ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
-- ============================================================================

-- ─── profiles ──────────────────────────────────────────────────────────────
-- ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile; DDP admin can read all profiles.
-- CREATE POLICY "profiles: select own or admin"
--   ON public.profiles FOR SELECT
--   USING (id = auth.uid() OR is_ddp_admin());

-- Users can update their own profile but cannot change their role.
-- CREATE POLICY "profiles: update own (no role change)"
--   ON public.profiles FOR UPDATE
--   USING (id = auth.uid())
--   WITH CHECK (
--     id = auth.uid() AND
--     role = (SELECT role FROM public.profiles WHERE id = auth.uid())
--   );

-- Only DDP admin can change a user's role.
-- CREATE POLICY "profiles: admin update role"
--   ON public.profiles FOR UPDATE
--   USING (is_ddp_admin());

-- ─── farms ─────────────────────────────────────────────────────────────────
-- ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;

-- DDP admin has unrestricted access to all farms.
-- CREATE POLICY "farms: admin all"
--   ON public.farms FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- Farmer can read their own farms (created by them or via membership).
-- CREATE POLICY "farms: farmer select own"
--   ON public.farms FOR SELECT
--   USING (created_by = auth.uid() OR has_farm_membership(id));

-- Farmer can insert farms where they are the creator.
-- CREATE POLICY "farms: farmer insert own"
--   ON public.farms FOR INSERT
--   WITH CHECK (created_by = auth.uid());

-- ─── farm_profiles ─────────────────────────────────────────────────────────
-- ALTER TABLE public.farm_profiles ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "farm_profiles: admin all"
--   ON public.farm_profiles FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- CREATE POLICY "farm_profiles: farmer select own"
--   ON public.farm_profiles FOR SELECT
--   USING (has_farm_membership(farm_id));

-- CREATE POLICY "farm_profiles: farmer insert own"
--   ON public.farm_profiles FOR INSERT
--   WITH CHECK (has_farm_membership(farm_id));

-- ─── farm_memberships ──────────────────────────────────────────────────────
-- ALTER TABLE public.farm_memberships ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "farm_memberships: admin all"
--   ON public.farm_memberships FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- CREATE POLICY "farm_memberships: farmer select own"
--   ON public.farm_memberships FOR SELECT
--   USING (user_id = auth.uid());

-- ─── inventory_batches ─────────────────────────────────────────────────────
-- ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "inventory_batches: admin all"
--   ON public.inventory_batches FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- Farmer can read batches they created, or batches belonging to their farms.
-- CREATE POLICY "inventory_batches: farmer select own"
--   ON public.inventory_batches FOR SELECT
--   USING (
--     created_by = auth.uid() OR
--     has_farm_membership(farm_id)
--   );

-- Farmer can insert their own batches.
-- CREATE POLICY "inventory_batches: farmer insert own"
--   ON public.inventory_batches FOR INSERT
--   WITH CHECK (created_by = auth.uid());

-- Only admin can update status (approve/reject/missing document).
-- CREATE POLICY "inventory_batches: admin update"
--   ON public.inventory_batches FOR UPDATE
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- ─── ddp_scores ────────────────────────────────────────────────────────────
-- ALTER TABLE public.ddp_scores ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "ddp_scores: admin all"
--   ON public.ddp_scores FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- CREATE POLICY "ddp_scores: farmer select own farm"
--   ON public.ddp_scores FOR SELECT
--   USING (has_farm_membership(farm_id));

-- ─── risk_flags ────────────────────────────────────────────────────────────
-- ALTER TABLE public.risk_flags ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "risk_flags: admin all"
--   ON public.risk_flags FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- CREATE POLICY "risk_flags: farmer select own farm"
--   ON public.risk_flags FOR SELECT
--   USING (has_farm_membership(farm_id));

-- ─── status_history ────────────────────────────────────────────────────────
-- ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "status_history: admin all"
--   ON public.status_history FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- Farmer can read history for their own farms and their own inventory batches.
-- CREATE POLICY "status_history: farmer select own"
--   ON public.status_history FOR SELECT
--   USING (
--     (entity_type = 'farm' AND has_farm_membership(entity_id)) OR
--     (entity_type = 'inventory_batch' AND EXISTS (
--       SELECT 1 FROM public.inventory_batches ib
--       WHERE ib.id = entity_id
--         AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
--     ))
--   );

-- ─── documents ─────────────────────────────────────────────────────────────
-- ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "documents: admin all"
--   ON public.documents FOR ALL
--   USING (is_ddp_admin()) WITH CHECK (is_ddp_admin());

-- CREATE POLICY "documents: farmer select own"
--   ON public.documents FOR SELECT
--   USING (
--     has_farm_membership(farm_id) OR
--     (inventory_batch_id IS NOT NULL AND EXISTS (
--       SELECT 1 FROM public.inventory_batches ib
--       WHERE ib.id = inventory_batch_id
--         AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
--     ))
--   );
