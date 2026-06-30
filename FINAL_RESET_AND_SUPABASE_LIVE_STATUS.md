# DDP Brokerage — Final Reset & Supabase Live Status

**Date:** 2026-06-30
**Branch:** `auth-rls-mvp`
**Deployed commit:** `fe75464`
**Live URL:** https://ddp-brokerage-demo.onrender.com

---

## 1. Security Hardening

Applied via SQL migrations committed to this branch.

### Migration 3 — `3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql`

Fixed "Function Search Path Mutable" and "Public Can Execute SECURITY DEFINER" errors on all five SECURITY DEFINER functions:

| Function | Fix applied |
|---|---|
| `handle_new_user()` | Added `SET search_path = public, auth, pg_temp` |
| `is_ddp_admin()` | Added `SET search_path = public, auth, pg_temp` |
| `has_farm_membership()` | Added `SET search_path = public, auth, pg_temp` |
| `fn_protect_owner_notes()` | Added `SET search_path = public, auth, pg_temp` |
| `fn_protect_review_request_fields()` | Added `SET search_path = public, auth, pg_temp` |

All five: `REVOKE EXECUTE FROM PUBLIC, anon`. Trigger-only functions also revoked from `authenticated`. RLS-helper functions granted to `authenticated, service_role`.

### Migration 4 — `4_RLS_ENABLE_REMAINING_TABLES.sql`

Enabled RLS and created policies on four previously unprotected tables:

| Table | Policies |
|---|---|
| `ddp_scores` | Admin: all rows. Farmer: own farm only. |
| `risk_flags` | Admin: all rows. Farmer: own farm only. |
| `status_history` | Admin: all rows. Farmer: entities they own (polymorphic). |
| `documents` | Admin: all rows. Farmer: own farm only. |

### Supabase Security Advisor — final state

- **Errors: 0**
- Warnings: 3 (accepted for MVP — see section 6)

---

## 2. Database Reset

Applied manually in Supabase SQL Editor via `5B_RESET_DEMO_DATA_KEEP_ADMIN_NO_STORAGE_DELETE.sql`.

**Deleted (in FK-safe order):**
- `status_history`
- `farmer_review_requests`
- `documents`, `farmer_documents`, `farmer_photos`
- `ddp_scores`, `risk_flags`
- `inventory_batches`
- `farm_memberships`
- `farm_profiles`
- `farms`
- `profiles` WHERE `role = 'farmer'` (old demo farmer profiles only)

**Preserved:**
- All `auth.users` rows (Supabase manages these; SQL Editor cannot delete them)
- Admin `profiles` row
- `market_price_benchmarks` reference data

**Storage note:** `storage.objects` cannot be deleted via SQL Editor. Any farm/product photos from the old demo remain in Supabase Storage buckets but are orphaned (no database references). They can be removed manually via the Supabase Dashboard → Storage UI if needed.

---

## 3. Clean Accounts Created

Both created as standard Supabase Auth users via the Supabase Dashboard → Authentication → Users.

| Role | Email | Profile role |
|---|---|---|
| Admin | dylan+admin1@gmail.com | `ddp_admin` |
| Farmer | dylan+farmer1@gmail.com | `farmer` |

The `handle_new_user()` trigger automatically created both profiles with `role = 'farmer'`. The seed script corrected the admin profile to `role = 'ddp_admin'` via `ON CONFLICT (id) DO UPDATE`.

---

## 4. Seed Data Created

Applied manually in Supabase SQL Editor via `6C_SEED_CLEAN_BASELINE_FIXED.sql`, then patched with `6C_SEED_CLEAN_BASELINE_FIXED_V2.sql`.

| Table | Count | Detail |
|---|---|---|
| `profiles` | 2 | 1 admin (`ddp_admin`), 1 farmer (`farmer`) |
| `farms` | 1 | "DDP Demo Farm", Chiang Mai, Mae Rim |
| `farm_profiles` | 1 | Minimal JSON skeleton — province, legal name only |
| `farm_memberships` | 1 | Farmer → Demo Farm, role `owner` |
| `inventory_batches` | 1 | "Dried Flower", 10 kg, batch DEMO-BATCH-001 |

**Stable seed UUIDs (deterministic, safe to re-seed):**
- Farm: `00000000-0000-4000-8000-000000000001`
- Batch: `00000000-0000-4000-8000-000000000002`

**Patch applied (V2):** The original seed set `status = 'Submitted'`, which is not a valid `InventoryStatus` value in the frontend type. Patch updated the batch to `status = 'Pending Review'` and `stock_status = 'submitted'` so the FarmerMyStock "Pending" filter tab matches correctly.

---

## 5. Data-Source Mismatch Fix — `fe75464`

### Root cause

`getFarmProfiles()` and `getInventoryBatches()` in `src/lib/db.ts` read exclusively from localStorage, ignoring Supabase. Admin pages showed stale localStorage/seed data (Calli Krush, Northern Green Farm, etc.) after the database reset. Farmer My Stock was empty because `getFarmerScope()` returned Supabase item IDs but the filter compared them against localStorage rows that did not contain those UUIDs.

### Fix — three files changed

**`src/data.ts`**
- Added `sbConfigured` check (reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at module load).
- `loadFarms()` and `loadInventory()` return `[]` when Supabase is configured, preventing localStorage auto-seed from populating stale demo data into React state.
- Demo mode (no env vars) is unchanged — auto-seed behaviour is fully preserved.

**`src/lib/db.ts`**
- Added `toInventoryStatus()` — normalises invalid DB status values to `'Pending Review'`.
- Added `farmRowToProfile()` — maps `farms` + `farm_profiles` JSONB blobs to the full `FarmProfile` interface.
- Added `batchRowToInventoryItem()` — maps `inventory_batches` rows (with optional `farms` join for name) to `InventoryItem`.
- Added `loadFarmsFromDB()` — fetches all farms + farm_profiles join; used by admin pages.
- Added `loadInventoryFromDB()` — fetches all inventory batches; used by admin pages.
- Added `loadFarmerInventoryFromDB(itemIds, farmIds)` — fetches actual batch rows for a farmer's scope; used to populate Farmer My Stock.

**`src/App.tsx`**
- Added admin `useEffect`: when `isSupabaseConfigured && currentProfile.role === 'ddp_admin'`, calls `loadFarmsFromDB()` and `loadInventoryFromDB()`, then replaces `farms` and `inventory` state with live Supabase data.
- Updated farmer scope `useEffect`: after `getFarmerScope()` resolves, now also calls `loadFarmerInventoryFromDB()` in parallel with `loadReviewRequestsFromDB()`. Supabase rows are merged into `inventory` state, replacing any localStorage rows with matching IDs.

---

## 6. Smoke Test Results — Post-Deploy

Tested on live app: https://ddp-brokerage-demo.onrender.com

| Page | Expected | Result |
|---|---|---|
| Admin → Overview | Clean counts, no old farms | Pass |
| Admin → Farm Profiles | "Demo Farm" only, no Calli Krush | Pass |
| Admin → Inventory Review | "Dried Flower, 10 kg, Pending Review" | Pass |
| Admin → Master Inventory | Empty (no approved batches yet) | Pass — correct |
| Admin → Buyer Preview | Empty (no client-visible batches) | Pass — correct |
| Farmer → My Stock → Pending tab | "Dried Flower, DEMO-BATCH-001" | Pass |
| Old localStorage/demo data | Gone | Pass |

---

## 7. Accepted Supabase Security Warnings (MVP)

Three warnings remain in Supabase Security Advisor. All are reviewed and accepted for the current MVP stage.

| Warning | Reason accepted |
|---|---|
| `auth.users` exposed via view | Standard Supabase setup; no PII exposed beyond what the app already accesses via `auth.uid()` |
| Function without `SECURITY DEFINER` in public schema | Non-sensitive helper; RLS enforced at the table level |
| `anon` role has broad schema access | Supabase default; all tables have RLS enabled and policies restricting anon reads |

These warnings do not represent exploitable vulnerabilities at the current scale and access model. Re-evaluate before public launch or when adding new unauthenticated routes.

---

## 8. Next Recommended Tasks

### Immediate / before adding real farm data

- [ ] **Farmer onboarding flow** — farmer should be able to fill in the full farm profile form; currently the Demo Farm profile JSON is a skeleton.
- [ ] **Batch submission polish** — farmer submits a new batch via the app; verify it appears in Admin Inventory Review with correct status.
- [ ] **Admin approval flow** — admin approves a batch; verify it moves to Master Inventory and becomes client-visible in Buyer Preview.

### Near-term

- [ ] **Storage orphan cleanup** — remove old demo photos from Supabase Storage buckets via Dashboard → Storage.
- [ ] **COA / document upload** — test that file uploads write to the correct storage bucket and that the document FK rows are created.
- [ ] **Review request flow** — farmer submits a review request; admin sees it in Inventory Review; admin leaves notes; farmer sees `needs_changes` status in My Stock.

### Pre-production

- [ ] **RLS audit on new tables** — any table added after this migration must have RLS enabled and policies before going live.
- [ ] **Re-evaluate accepted Security Advisor warnings** — revisit the three accepted warnings before enabling public or buyer-facing access.
- [ ] **Remove demo seed users** — `dylan+admin1@gmail.com` and `dylan+farmer1@gmail.com` should be replaced or removed before onboarding real partners.
- [ ] **Environment separation** — create a staging Supabase project so resets and seed changes do not touch production data.
