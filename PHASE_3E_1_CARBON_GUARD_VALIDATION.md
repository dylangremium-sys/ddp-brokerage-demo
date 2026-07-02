# Phase 3E-1 Validation — Carbon Guard, Completion Hint Fixes, and UI Polish

## 1. Summary

This validation covers frontend carbon persistence guards, completion hint cleanup, buyer preview copy polish, and farmer status fallback labels.

Validated commits:
1. `ac78880` — Fix: prevent misleading completion and carbon status states
2. `848e2df` — Fix: prevent misleading farmer carbon exclusion state
3. `0aab450` — UI: polish buyer preview copy and farmer status fallbacks

All three commits reached `origin/auth-rls-mvp` and `origin/main`. Merge to main was fast-forward only. Render manual deploy completed for `0aab450`. User confirmed live smoke test passed.

No SQL, Supabase, Auth, RLS, schema, migrations, secrets, env, deployment config, or `db.ts` changes were made. `FARM_RESAVE_PERSISTENCE_MIGRATION.sql` was not created. The landing page redesign was not included; it remains stashed separately.

---

## 2. Commit ac78880

**Files changed:**
- `src/App.tsx`
- `src/pages/admin/DDPFarmReview.tsx`
- `src/pages/farmer/FarmerDashboard.tsx`

**Behavior validated:**
- `DDPFarmReview` remounts by farm id (`key={reviewFarm.id}`) to prevent stale local carbon status when switching reviewed farms.
- Admin carbon status controls are disabled in live Supabase mode because carbon status is not yet persisted to the database.
- Admin warning banner appears when `carbonPersistenceAvailable` is false.
- Misleading completion hints are suppressed for Approved / Strategic Partner farms.
- Export licence and GMP cert hints that did not align with completion calculation were removed.

---

## 3. Commit 848e2df

**Files changed:**
- `src/App.tsx`
- `src/pages/farmer/FarmerStatus.tsx`
- `src/translations.ts`

**Behavior validated:**
- `FarmerStatus` receives `carbonPersistenceAvailable` prop from `App.tsx`.
- Farmer carbon exclude/withdraw action is disabled in live Supabase mode.
- Farmer-facing carbon-not-connected warning appears when `carbonPersistenceAvailable` is false.
- English and Thai warning translations exist (`carbonNotConnectedNotice`).
- Demo mode behavior (all controls active) remains unchanged.

---

## 4. Commit 0aab450

**Files changed:**
- `src/pages/admin/DDPBuyerPreview.tsx`
- `src/pages/farmer/FarmerStatus.tsx`
- `src/translations.ts`

**Behavior validated:**
- Buyer preview copy no longer uses misleading "prototype" / "PROTOTYPE MODULE" language.
- Buyer preview clearly indicates buyer access and saved buyer records are not yet live.
- `FarmerStatus` uses fallback labels for unnamed farm profiles (`t.unnamedFarmProfile`) and unnamed batches (`t.unnamedBatch`).
- English and Thai fallback label translations exist.
- No persistence, security, database, or routing logic was changed.

---

## 5. Live Smoke Test Checklist

All items confirmed passed by user following manual Render deploy of `0aab450`.

| Check | Result |
|---|---|
| Render deploy succeeded | PASSED |
| Deployed commit was `0aab450` | PASSED |
| Live app loaded without blank/green screen | PASSED |
| Farmer login worked | PASSED |
| Admin login worked | PASSED |
| Route guards remained unchanged | PASSED |
| Admin buyer preview opened | PASSED |
| Buyer preview copy reflected not-yet-live buyer access | PASSED |
| FarmerStatus / My Submissions opened | PASSED |
| Farm cards rendered correctly | PASSED |
| Inventory/batch cards rendered correctly | PASSED |
| Farmer carbon row still appeared | PASSED |
| Farmer carbon exclude/withdraw button remained disabled in live Supabase mode | PASSED |
| Farmer carbon warning still appeared | PASSED |
| Admin Farm Review opened | PASSED |
| Admin carbon status control remained disabled in live Supabase mode | PASSED |
| Admin carbon warning still appeared | PASSED |
| Switching reviewed farms showed no stale carbon state | PASSED |
| Farmer Dashboard opened | PASSED |
| Submit Inventory opened | PASSED |
| My Stock opened | PASSED |
| Admin Inventory Review opened | PASSED |
| Buyer Pack opened | PASSED |
| COA signed/open behavior unchanged | PASSED |

---

## 6. Explicit Risk Notes

- This was frontend-only validation. No backend changes were included.
- Carbon programme status is still not persisted in Supabase; no DB column exists for it.
- Carbon controls are intentionally disabled in live Supabase mode until a persistence schema migration is applied.
- Farm re-save persistence remains unresolved and belongs to Phase 3E-2 (`FARM_RESAVE_PERSISTENCE_MIGRATION.sql`).
- No database schema, RLS policy, storage policy, migration, or `db.ts` change was made.
- The landing page redesign is excluded from this validation and remains as separate stashed work (`stash@{0}: WIP landing page redesign separate work`).

---

## 7. Final Status

**Status: PASSED**
