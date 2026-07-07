-- =============================================================================
-- INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql
-- DDP Brokerage — inventory_batches farmer INSERT guardrail remediation
--
-- WHY THIS FILE EXISTS:
--   A live pg_policies parity review (docs/SECURITY_TEST_LOG.md, Section 5A,
--   dated 2026-07-07) found that the deployed
--   "inventory_batches: farmer insert own" policy's WITH CHECK expression is:
--
--     ((created_by = auth.uid()) OR has_farm_membership(farm_id))
--
--   This is missing three guardrail conditions that INVENTORY_BATCHES_RLS_PATCH.sql
--   documents as the intended, already-"applied" production policy:
--     • client_visible = false        (farmer cannot self-publish to buyers)
--     • status NOT IN ('Approved')    (farmer cannot self-approve)
--     • stock_status IS NULL OR stock_status IN ('draft','submitted','needs_changes')
--       (farmer cannot insert directly into an admin-only stock lifecycle state)
--
--   The corresponding "inventory_batches: farmer update own" policy (added by
--   FARMER_MVP_MIGRATION.sql Section F) already enforces these same three
--   guardrails correctly and was confirmed live-matching in the same parity
--   review — only the INSERT-time guardrails were found missing live. This file
--   closes that specific gap by reapplying the INSERT policy from
--   INVENTORY_BATCHES_RLS_PATCH.sql verbatim.
--
-- NULL-SAFETY REVIEW (done before writing this file, not assumed):
--   inventory_batches.status is TEXT, nullable, with no column default
--   (SUPABASE_SCHEMA.sql). `status NOT IN ('Approved')` evaluates to NULL/false
--   for a NULL status, which WITH CHECK treats as a rejected insert.
--   Reviewed src/lib/db.ts (createInventoryBatch) and the farmer submission UI
--   (src/pages/farmer/FarmerSubmitInventory.tsx) and src/data.ts: every actual
--   insert code path explicitly sets status = 'Pending Review' (InventoryItem.status
--   is a required, non-optional TypeScript field — never omitted, never null,
--   never 'Approved'). client_visible defaults to false at the column level
--   (NOT NULL DEFAULT false) and is also explicitly passed as `false` by the app.
--   stock_status is nullable and the guardrail explicitly allows NULL. On this
--   basis, the stricter WITH CHECK below does not break the app's normal farmer
--   submission path.
--
-- SCOPE:
--   Drops and recreates ONLY "inventory_batches: farmer insert own".
--   Does not touch "admin all", "farmer select own", or "farmer update own" on
--   this table, and does not touch any other table's policies.
--   Does not create, update, or delete any data rows.
--
-- HOW TO APPLY:
--   Owner reviews this file, then pastes it into Supabase → SQL Editor → Run.
--   This file is NOT applied automatically — it is prepared for manual review
--   and manual execution only.
--
-- VERIFICATION AFTER APPLYING:
--   Re-export pg_policies for inventory_batches (same method as the original
--   parity review) and confirm the "farmer insert own" with_check now matches
--   this file exactly. Then update docs/SECURITY_TEST_LOG.md accordingly.
-- =============================================================================

DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer insert own"
  ON public.inventory_batches
  FOR INSERT
  WITH CHECK (
    (created_by = auth.uid() OR has_farm_membership(farm_id))
    AND client_visible = false
    AND status NOT IN ('Approved')
    AND (
      stock_status IS NULL
      OR stock_status IN ('draft', 'submitted', 'needs_changes')
    )
  );

-- Verification — run after applying to confirm the new with_check is live:
-- SELECT policyname, cmd, with_check
-- FROM pg_policies
-- WHERE tablename = 'inventory_batches'
--   AND policyname = 'inventory_batches: farmer insert own';
