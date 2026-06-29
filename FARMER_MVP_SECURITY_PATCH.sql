-- =============================================================================
-- FARMER_MVP_SECURITY_PATCH.sql
-- DDP Brokerage — Farmer MVP security hardening (triggers)
--
-- PREREQUISITES:
--   □ FARMER_MVP_MIGRATION.sql already applied (tables + RLS in place).
--   □ AUTH_RLS_SCHEMA.sql Part 1 + Part 2 already applied
--     (is_ddp_admin() function must exist).
--
-- HOW TO APPLY:
--   Paste into Supabase → SQL Editor → Run.
--   Safe to re-run: all functions use CREATE OR REPLACE, all triggers use
--   DROP IF EXISTS before CREATE.
--
-- WHY TRIGGERS INSTEAD OF PURE RLS:
--   PostgreSQL RLS WITH CHECK can only inspect the *proposed new row* — it
--   cannot compare new values to old values.  Preventing field-level tampering
--   (e.g. "do not change owner_notes unless you are admin") therefore requires
--   a BEFORE UPDATE trigger, which has access to both OLD and NEW.
--
-- SECTIONS:
--   1. fn_protect_owner_notes + trg_protect_owner_notes
--      Prevents farmers from overwriting admin notes on inventory batches.
--
--   2. fn_protect_review_request_fields + trg_protect_review_request_fields
--      Prevents farmers from altering request content while marking resolved.
-- =============================================================================


-- =============================================================================
-- 1. PROTECT owner_notes ON inventory_batches
-- =============================================================================
-- The farmer UPDATE RLS policy correctly blocks self-approval and
-- client_visible escalation, but PostgreSQL RLS cannot prevent writes to
-- individual columns like owner_notes.  A farmer with direct REST API
-- access could overwrite admin notes on their own batches.
--
-- This trigger silently restores OLD.owner_notes for any non-admin caller,
-- so the field is effectively read-only for farmers regardless of what is
-- sent in the UPDATE payload.

CREATE OR REPLACE FUNCTION fn_protect_owner_notes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  -- DDP admins may set owner_notes to any value.
  IF is_ddp_admin() THEN
    RETURN NEW;
  END IF;

  -- For all other callers (farmers, service accounts without admin role):
  -- silently restore the pre-update value.
  -- The UPDATE is not rejected — only owner_notes is pinned to OLD.
  NEW.owner_notes := OLD.owner_notes;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_owner_notes ON public.inventory_batches;
CREATE TRIGGER trg_protect_owner_notes
  BEFORE UPDATE ON public.inventory_batches
  FOR EACH ROW
  EXECUTE FUNCTION fn_protect_owner_notes();

-- Verify:
-- SELECT tgname FROM pg_trigger
-- WHERE tgrelid = 'public.inventory_batches'::regclass;


-- =============================================================================
-- 2. PROTECT farmer_review_requests FIELDS DURING RESOLVE
-- =============================================================================
-- The RLS UPDATE policy for farmers only validates the resulting row's
-- status and resolved_at.  It cannot prevent a farmer from also modifying
-- message, request_type, or other immutable fields in the same UPDATE call.
--
-- This trigger enforces field-level immutability for non-admin callers:
--   • message, request_type, created_by, inventory_batch_id, farm_id,
--     product_name, farm_name, and created_at are pinned to their OLD values.
--   • Only status (open → resolved) and resolved_at (NULL → timestamp)
--     may be changed by a farmer.
--   • Attempting to re-open a resolved request raises an error.

CREATE OR REPLACE FUNCTION fn_protect_review_request_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  -- DDP admins may modify any field (e.g. to correct a typo in the message).
  IF is_ddp_admin() THEN
    RETURN NEW;
  END IF;

  -- Prevent re-opening a resolved request.
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION
      'farmer_review_requests: cannot modify a request that is already resolved.';
  END IF;

  -- Pin all immutable fields to their current values regardless of payload.
  NEW.message            := OLD.message;
  NEW.request_type       := OLD.request_type;
  NEW.created_by         := OLD.created_by;
  NEW.inventory_batch_id := OLD.inventory_batch_id;
  NEW.farm_id            := OLD.farm_id;
  NEW.product_name       := OLD.product_name;
  NEW.farm_name          := OLD.farm_name;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_review_request_fields ON public.farmer_review_requests;
CREATE TRIGGER trg_protect_review_request_fields
  BEFORE UPDATE ON public.farmer_review_requests
  FOR EACH ROW
  EXECUTE FUNCTION fn_protect_review_request_fields();

-- Verify:
-- SELECT tgname FROM pg_trigger
-- WHERE tgrelid = 'public.farmer_review_requests'::regclass;


-- =============================================================================
-- DIAGNOSTICS — run after patch to verify both triggers are in place
-- =============================================================================
-- SELECT tgname, tgrelid::regclass AS table_name, tgenabled
-- FROM pg_trigger
-- WHERE tgname IN (
--   'trg_protect_owner_notes',
--   'trg_protect_review_request_fields'
-- );
-- Expected: 2 rows, tgenabled = 'O' (origin/default enabled)
-- =============================================================================
