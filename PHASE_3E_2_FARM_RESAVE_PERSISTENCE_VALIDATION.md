# Phase 3E-2 Validation — Farm Re-Save Persistence

## 1. Summary

This validation confirms the farm profile re-save persistence fix.

The SQL migration proposal was committed and merged first (`26fe051`). The migration was manually applied in Supabase SQL Editor. Duplicate precheck passed. Verification queries V1–V5 passed. `db.ts` was updated after the database migration was verified (`d1b9c0c`). `d1b9c0c` was pushed, fast-forward merged to main, deployed manually on Render, and live smoke-tested. User confirmed the live smoke test passed.

Landing page/UI work was excluded and remains stashed separately.

Validated commits:
1. `26fe051` — SQL: add farm re-save persistence migration proposal
2. `d1b9c0c` — Fix: make farm profile re-save persistence idempotent

---

## 2. SQL Migration Commit Summary

**Commit:** `26fe051` — SQL: add farm re-save persistence migration proposal

**File:**
- `FARM_RESAVE_PERSISTENCE_MIGRATION.sql`

**Validated SQL behavior:**
- Added protective trigger function: `public.fn_protect_farm_admin_fields()`
- Added trigger: `trg_protect_farm_admin_fields` on `public.farms`
- Added farmer UPDATE policy on `public.farms`
- Added duplicate guard (DO block raises exception if duplicates exist before constraint is added)
- Added unique constraint: `farm_profiles_farm_id_unique` on `public.farm_profiles(farm_id)`
- Added farmer UPDATE policy on `public.farm_profiles`
- Included verification queries V1–V5 and commented rollback SQL
- SQL was applied manually in Supabase SQL Editor only — no CLI, no automated runner

---

## 3. Supabase Verification Results

All checks passed following manual application of the migration.

| Check | Result |
|---|---|
| Duplicate precheck before migration | 0 rows — safe to proceed |
| V1 duplicate check post-migration | 0 rows |
| V2 trigger check | `trg_protect_farm_admin_fields` exists, `tgenabled = O` |
| V3 function check | `fn_protect_farm_admin_fields` exists, `prosecdef = true` |
| V4 policy check | Both UPDATE policies present (`farms` + `farm_profiles`) |
| V5 constraint check | `farm_profiles_farm_id_unique` exists, `contype = u` |

---

## 4. db.ts Commit Summary

**Commit:** `d1b9c0c` — Fix: make farm profile re-save persistence idempotent

**File:**
- `src/lib/db.ts`

**Validated db.ts behavior:**
- Removed admin-risk null fields from the `public.farms` upsert payload:
  - `compliance_status`
  - `export_readiness`
  - `risk_level`
  These columns are now protected by `fn_protect_farm_admin_fields` at the DB layer. Omitting them from the payload prevents unnecessary null writes against trigger-protected columns.
- Added `sbUpsertOn(table, data, onConflict)` helper — upserts with an explicit conflict target column.
- Added `sbUpsertIgnore(table, data, onConflict)` helper — upserts with `ignoreDuplicates: true` on conflict.
- Changed `farm_profiles` write path from hard `INSERT` to `sbUpsertOn('farm_profiles', ..., 'farm_id')` — idempotent on `farm_id`; safe on re-save.
- Added `updated_at` to the `farm_profiles` payload.
- Changed `farm_memberships` write path from hard `INSERT` to `sbUpsertIgnore('farm_memberships', ..., 'farm_id,user_id')` — silently ignores duplicate membership on re-save.
- Preserved demo/localStorage behavior (unchanged).
- Preserved seed/non-UUID early return behavior (unchanged).
- Preserved COA, carbon, inventory, buyer pack, and admin review behavior (unchanged).

---

## 5. Live Deploy and Smoke Test

All items confirmed passed by user following manual Render deploy of `d1b9c0c`.

| Check | Result |
|---|---|
| Render deploy succeeded | PASSED |
| Deployed commit was `d1b9c0c` | PASSED |
| Live app loaded without blank/green screen | PASSED |
| Farmer login worked | PASSED |
| Admin login worked | PASSED |
| Route guards remained unchanged | PASSED |
| Existing farm profile loaded | PASSED |
| Existing farm profile re-save worked | PASSED |
| Re-save after safe farmer-owned field change worked | PASSED |
| No Supabase/RLS error appeared | PASSED |
| No duplicate farm profile was visibly created | PASSED |
| Farmer remained associated with the same farm after re-save | PASSED |
| Farmer profile display remained intact | PASSED |
| Admin Farm Review opened | PASSED |
| Farm review list and details loaded | PASSED |
| Admin-owned fields were not visibly wiped after farmer re-save | PASSED |
| Carbon guard behavior remained intact | PASSED |
| Submit Inventory opened | PASSED |
| My Stock opened | PASSED |
| Admin Inventory Review opened | PASSED |
| Buyer preview opened | PASSED |
| Buyer Pack opened | PASSED |
| Master Inventory opened | PASSED |
| COA signed/open behavior unchanged | PASSED |

---

## 6. Explicit Risk Notes

- This was a targeted persistence fix for farm re-save only.
- Carbon programme persistence remains separate and unresolved — carbon controls are still disabled in live Supabase mode pending a future schema migration.
- Landing page/UI redesign remains separate and was not included; it remains in `stash@{0}` and `stash@{1}`.
- `RESET_*.sql` stubs remain untracked only — not staged, not committed, not run.
- No secrets, env files, deployment config, or Render config changed.
- No Supabase change was made from CLI; migration was applied manually in SQL Editor only.
- No further schema changes were made after V1–V5 verification passed.

---

## 7. Final Status

**Status: PASSED**
