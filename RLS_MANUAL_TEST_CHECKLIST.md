# RLS Manual Test Checklist

Run these tests in Supabase mode (env vars set). Each section maps to a staged RLS block.
Run the full checklist **before enabling any RLS stage**, then re-run after each stage.

---

## Prerequisites

Before running any stage:

- [ ] `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set in `.env.local`
- [ ] App running with `npm run dev` (navbar shows **● Database mode: Supabase**)
- [ ] Stage 0 diagnostic SQL run and output reviewed
- [ ] At least one `ddp_admin` profile exists in Supabase `profiles` table
- [ ] At least one farmer profile exists with a `farm_memberships` row
- [ ] `is_ddp_admin()` and `has_farm_membership()` functions confirmed present

---

## Test A — Demo Mode (no env vars)

These tests must pass before AND after every RLS stage. If these break,
the issue is in app code, not RLS.

| # | Action | Expected result |
|---|--------|----------------|
| A1 | Remove env vars, restart dev server | Navbar shows **○ Demo mode: localStorage** |
| A2 | Click "Enter Farmer Portal" | Goes directly to Farm Registration (no login prompt) |
| A3 | Open My Submissions | Shows seed farms and seed inventory |
| A4 | Click "Enter DDP Portal" | Goes directly to DDP Overview |
| A5 | DDP Farms page | Shows all seed farm profiles |
| A6 | Reset Demo button | Clears all data, returns to landing |
| A7 | Re-add env vars, restart | Mode badge switches back to Supabase |

---

## Test B — Farmer: Sign In

| # | Action | Expected result |
|---|--------|----------------|
| B1 | Open landing page | "Sign in" button visible in top-right |
| B2 | Click "Enter Farmer Portal" without signing in | Redirected to Signup page |
| B3 | Sign in with farmer credentials | Lands on landing page, badge shows **Farmer** chip |
| B4 | Navbar visible pages | Farmer group only: Register Farm, Submit Inventory, My Submissions |
| B5 | DDP pages absent from navbar | No DDP nav group visible |
| B6 | Manually navigate to DDP Overview via app | "Access Denied" shown |

---

## Test C — Farmer: Farm Registration

| # | Action | Expected result |
|---|--------|----------------|
| C1 | Click "Register Farm" → fill form → Submit | No error banner, redirects to My Submissions |
| C2 | My Submissions → Farm Status section | New farm card visible with correct name and status |
| C3 | Supabase Table Editor → `farms` | New row with `created_by` = farmer's UUID |
| C4 | Supabase Table Editor → `farm_profiles` | New row with `farm_id` = new farm's UUID |
| C5 | Supabase Table Editor → `farm_memberships` | New row: `user_id` = farmer UUID, `farm_id` = farm UUID, `role` = 'owner' |
| C6 | My Submissions does NOT show seed farms | farm-1, farm-2, farm-3 absent from farmer's view |

---

## Test D — Farmer: Inventory Submission

| # | Action | Expected result |
|---|--------|----------------|
| D1 | Click "Submit Inventory" | Farm dropdown shows ONLY farmer's registered farms (not seed farms) |
| D2 | Select own farm from dropdown | Contact/location fields auto-fill |
| D3 | Fill inventory form → Submit | No error banner, success alert shown |
| D4 | My Submissions → Inventory Status section | New batch card visible |
| D5 | Supabase Table Editor → `inventory_batches` | New row with `created_by` = farmer UUID, `farm_id` = farmer's farm UUID |
| D6 | Farmer's My Submissions does NOT show other users' inventory | Only their own batches visible |

---

## Test E — Farmer: My Submissions Visibility

| # | Action | Expected result |
|---|--------|----------------|
| E1 | New farmer (no submissions yet) | Combined empty state: "No submissions yet. Register your farm..." |
| E2 | After farm submitted | Farm card visible in Farm Status section |
| E3 | After inventory submitted | Batch card visible in Inventory Status section |
| E4 | Seed farms (farm-1 etc.) not in Farm Status | Seed data absent for authenticated farmer |
| E5 | Sign out → sign in as different farmer | Second farmer sees only THEIR farms |

---

## Test F — Farmer: Cannot Access DDP Admin Pages

| # | Action | Expected result |
|---|--------|----------------|
| F1 | Navbar has no DDP group | Correct — DDP nav hidden for farmer role |
| F2 | App page state set to 'ddp-overview' (via dev tools or workaround) | "Access Denied" screen shown |
| F3 | App page state set to 'ddp-farms' | "Access Denied" screen shown |
| F4 | App page state set to 'ddp-inventory' | "Access Denied" screen shown |

---

## Test G — Admin: Sign In

| # | Action | Expected result |
|---|--------|----------------|
| G1 | Sign in with admin credentials | Badge shows **Admin** chip |
| G2 | Navbar | Both Farmer group AND DDP group visible |
| G3 | Click "Enter DDP Portal" from landing | Goes directly to DDP Overview |

---

## Test H — Admin: Sees All Farms

| # | Action | Expected result |
|---|--------|----------------|
| H1 | DDP → Farm Profiles page | Seed farms AND farmer-submitted farms all visible |
| H2 | Farm count matches Supabase `farms` table row count | Counts agree |
| H3 | Open a farmer-submitted farm for review | Farm detail page loads with all profile sections |
| H4 | Approve a farm → confirm in Farm Profiles | Status changes to Approved |
| H5 | Supabase Table Editor → `farms` | `status` updated, `reviewed_by` = admin UUID |
| H6 | Supabase Table Editor → `status_history` | New row: entity_type = 'farm', old_status, new_status |

---

## Test I — Admin: Sees All Inventory

| # | Action | Expected result |
|---|--------|----------------|
| I1 | DDP → Inventory Review | All batches visible (seed + farmer-submitted) |
| I2 | Open a farmer batch for review | Inventory review page loads correctly |
| I3 | Approve an inventory batch | Status changes to Approved |
| I4 | Farmer's My Submissions → same batch | Status shows Approved |
| I5 | Supabase → `inventory_batches` | `status` = 'Approved', `reviewed_by` = admin UUID |
| I6 | Supabase → `status_history` | Row: entity_type = 'inventory_batch' |

---

## Test J — Supabase Table Data Verification

Run in Supabase SQL Editor after each workflow above.

```sql
-- J1: Row counts for all tables
SELECT 'profiles'           AS tbl, COUNT(*) FROM public.profiles
UNION ALL
SELECT 'farms',                      COUNT(*) FROM public.farms
UNION ALL
SELECT 'farm_profiles',              COUNT(*) FROM public.farm_profiles
UNION ALL
SELECT 'farm_memberships',           COUNT(*) FROM public.farm_memberships
UNION ALL
SELECT 'inventory_batches',          COUNT(*) FROM public.inventory_batches
UNION ALL
SELECT 'status_history',             COUNT(*) FROM public.status_history
ORDER BY tbl;

-- J2: Confirm created_by is set on all user-created farms
SELECT id, farm_name, created_by
FROM public.farms
WHERE created_by IS NOT NULL;

-- J3: Confirm reviewed_by is set on approved/rejected items
SELECT id, farm_name, status, reviewed_by
FROM public.farms
WHERE reviewed_by IS NOT NULL;

-- J4: Full membership view
SELECT
  fm.user_id,
  p.email,
  p.role,
  fm.farm_id,
  f.farm_name,
  fm.role AS member_role
FROM public.farm_memberships fm
JOIN public.profiles p ON p.id = fm.user_id
JOIN public.farms f    ON f.id = fm.farm_id;
```

---

## RLS-Specific Tests (run after each stage)

### After Stages 1–2 (profiles RLS)

| # | Test | Expected |
|---|------|---------|
| R1 | Sign in as farmer — app loads | ✅ Farmer badge visible |
| R2 | Sign in as admin — app loads | ✅ Admin badge visible |
| R3 | Sign in as farmer — check browser Network tab, profiles query | Returns exactly 1 row |
| R4 | Sign out and sign in again | No spinner freeze |

### After Stages 3–4 (farms RLS)

| # | Test | Expected |
|---|------|---------|
| R5 | Farmer — My Submissions farms section | Only their farms |
| R6 | Admin — Farm Profiles | All farms (including seed data) |
| R7 | Farmer submits new farm — no error | Farm visible in My Submissions |

### After Stages 5–6 (farm_profiles RLS)

| # | Test | Expected |
|---|------|---------|
| R8 | Farmer submits new farm | No policy error in error banner |
| R9 | Admin opens a farmer's farm review | Full profile detail shown |

### After Stages 7–8 (farm_memberships RLS)

| # | Test | Expected |
|---|------|---------|
| R10 | Farmer submits new farm | Membership row created, no error |
| R11 | Farmer scope reloads after sign-out/sign-in | Correct farms visible |

### After Stages 9–10 (inventory_batches RLS)

| # | Test | Expected |
|---|------|---------|
| R12 | Farmer submits inventory | Batch appears in My Submissions |
| R13 | Admin Inventory Review | Farmer's new batch visible |
| R14 | Admin approves batch | Status updates, no error |
| R15 | Farmer My Submissions | Batch now shows Approved status |

---

## Rollback Decision Table

| Symptom | Likely cause | Rollback command |
|---------|-------------|-----------------|
| App stuck on "Loading…" forever | profiles SELECT policy failed | Targeted profiles rollback in `RLS_ROLLBACK.sql` |
| Farm Profiles empty for admin | farms admin policy missing | Targeted farms rollback |
| My Submissions empty after farm submit | farms farmer select policy | Targeted farms rollback |
| Farm registration red error banner | farm_profiles or farm_memberships INSERT policy | Stage 6 or 8 rollback |
| Inventory Review empty for admin | inventory_batches admin policy | Targeted inventory rollback |
| Submit Inventory red error banner | inventory_batches farmer insert policy | Targeted inventory rollback |
| App completely blank (white screen) | Auth entirely broken | Full rollback (first block in `RLS_ROLLBACK.sql`) |

---

## Quick Rollback Reference

If the app goes blank after enabling RLS, paste this in Supabase SQL Editor immediately:

```sql
ALTER TABLE public.profiles           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farms              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_profiles      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_memberships   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ddp_scores         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_flags         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_history     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents          DISABLE ROW LEVEL SECURITY;
```

The app will return to its current working state immediately.
