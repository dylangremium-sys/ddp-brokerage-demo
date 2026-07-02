# Phase 2B Group 1 — Farmer Core Pages Move: Validation Record

**Date:** 2026-07-02
**Live URL:** https://ddp-brokerage-demo.onrender.com
**Deployed commit:** `6226e31` — Refactor: move core farmer pages into farmer folder
**Branch:** main / auth-rls-mvp (both at `6226e31`)

---

## Group 1 Move Summary

Three low-risk farmer page files were moved from `src/pages/` into `src/pages/farmer/` with no logic or behaviour changes.

| File | From | To |
|---|---|---|
| `FarmerStatus.tsx` | `src/pages/FarmerStatus.tsx` | `src/pages/farmer/FarmerStatus.tsx` |
| `FarmerRequests.tsx` | `src/pages/FarmerRequests.tsx` | `src/pages/farmer/FarmerRequests.tsx` |
| `FarmerMyStock.tsx` | `src/pages/FarmerMyStock.tsx` | `src/pages/farmer/FarmerMyStock.tsx` |

**Changes made:**

- `src/App.tsx` — three import paths updated (`./pages/X` → `./pages/farmer/X`)
- `FarmerStatus.tsx` — `../translations` → `../../translations`, `../types` → `../../types`
- `FarmerRequests.tsx` — `../types` → `../../types`
- `FarmerMyStock.tsx` — `../types` → `../../types`

Total diff: 4 files, 7 insertions, 7 deletions. All renames tracked by git at 99% similarity. Build passed with 0 errors before commit.

---

## Smoke Test Results

| Check | Result |
|---|---|
| Farmer → My Dashboard loads | ✓ |
| Farmer → My Stock loads | ✓ |
| Farmer → My Submissions loads | ✓ |
| Farmer → My Requests loads / no regression observed | ✓ |
| Farmer nav remains visible for farmer role | ✓ |
| Admin login shows DDP nav only | ✓ |
| Admin pages load (Overview, Farm Profiles, Inventory, Master Inventory) | ✓ |
| Buyer Pack opens from Master Inventory | ✓ |
| Open Photo works | ✓ |
| COA link works | ✓ |
| Print / Save PDF works | ✓ |
| Demo mode works end-to-end | ✓ |

---

## Operational Note

**Hard refresh after Render deploys.** Always hard-refresh (Cmd+Shift+R on Mac / Ctrl+F5 on Windows) after any Render deploy before testing. The JS bundle hash changes on each deploy; a cached `index.html` from before the deploy references a stale bundle that no longer exists, producing a dark green blank screen regardless of the deployed code.

---

## Phase 2B Progress

| Group | Commit | Files moved | Status |
|---|---|---|---|
| Group 1 | `6226e31` | `FarmerStatus`, `FarmerRequests`, `FarmerMyStock` → `src/pages/farmer/` | ✓ live |
| Group 2 | — | `FarmerOnboarding`, `FarmerAdvancedProfile` → `src/pages/farmer/` | pending audit |
| Group 3 | — | `FarmerDashboard`, `FarmerSubmitInventory`, `FarmerRegister` | deferred |
| Group 4 | — | All DDP/admin pages → `src/pages/admin/` | deferred |
| Group 5 | — | `LandingPage`, `LoginPage`, `SignupPage` → `src/pages/shared/` or root | lowest priority |

---

## Next Recommended Phase

**Phase 2B Group 2 — FarmerOnboarding + FarmerAdvancedProfile**

These two files are naturally paired (both use `calcCompletion`, `loadFarmDraft`, `saveFarmDraft`). Move them together after a brief audit confirming no cross-page imports have been added since the Group 1 audit. Recommended controlled prompt:

```
CONTROLLED AUDIT — PHASE 2B GROUP 2 PRE-MOVE AUDIT ONLY

Audit FarmerOnboarding.tsx and FarmerAdvancedProfile.tsx before moving them
into src/pages/farmer/. Confirm imports, cross-page dependencies, and exact
relative path changes required. Do not move files.
```
