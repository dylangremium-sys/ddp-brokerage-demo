# Phase 2B Group 2 — Farmer Profile Pages Move: Validation Record

**Date:** 2026-07-02
**Live URL:** https://ddp-brokerage-demo.onrender.com
**Deployed commit:** `9345f49` — Refactor: move farmer profile pages into farmer folder
**Branch:** main / auth-rls-mvp (both at `9345f49`)

---

## Group 2 Move Summary

Two paired farmer profile page files were moved from `src/pages/` into `src/pages/farmer/` with no logic or behaviour changes.

| File | From | To |
|---|---|---|
| `FarmerOnboarding.tsx` | `src/pages/FarmerOnboarding.tsx` | `src/pages/farmer/FarmerOnboarding.tsx` |
| `FarmerAdvancedProfile.tsx` | `src/pages/FarmerAdvancedProfile.tsx` | `src/pages/farmer/FarmerAdvancedProfile.tsx` |

**Changes made:**

- `src/App.tsx` — two import paths updated (`./pages/X` → `./pages/farmer/X`)
- `FarmerOnboarding.tsx` — `../translations` → `../../translations`, `../data` → `../../data`, `../types` → `../../types`, `../services/auth` → `../../services/auth`
- `FarmerAdvancedProfile.tsx` — `../translations` → `../../translations`, `../data` → `../../data`, `../types` → `../../types`

Total diff: 3 files, 9 insertions, 9 deletions. Both renames tracked by git at 99% similarity. Build passed with 0 errors before commit.

---

## Smoke Test Results

| Check | Result |
|---|---|
| Farmer → My Dashboard loads | ✓ |
| Farmer → Continue Farm Profile loads | ✓ |
| Farmer → Advanced Details loads (if accessible) | ✓ |
| Farmer profile draft save/load works | ✓ |
| Farmer nav remains visible for farmer role | ✓ |
| Farmer → My Stock loads | ✓ |
| Farmer → My Submissions loads | ✓ |
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
| Group 2 | `9345f49` | `FarmerOnboarding`, `FarmerAdvancedProfile` → `src/pages/farmer/` | ✓ live |
| Group 3 | — | `FarmerDashboard`, `FarmerSubmitInventory` — audit separately first | pending audit |
| Group 4 | — | `FarmerRegister` | deferred (pre-auth hybrid page) |
| Group 5 | — | All DDP/admin pages → `src/pages/admin/` | deferred |
| Group 6 | — | `LandingPage`, `LoginPage`, `SignupPage` | lowest priority |

**Current state of `src/pages/farmer/`:**
```
src/pages/farmer/
  FarmerAdvancedProfile.tsx  ← Group 2
  FarmerMyStock.tsx          ← Group 1
  FarmerOnboarding.tsx       ← Group 2
  FarmerRequests.tsx         ← Group 1
  FarmerStatus.tsx           ← Group 1
```

**Remaining in `src/pages/` root (farmer):**
```
src/pages/
  FarmerDashboard.tsx        ← Group 3 candidate (audit first)
  FarmerRegister.tsx         ← Group 4 (deferred)
  FarmerSubmitInventory.tsx  ← Group 3 candidate (audit separately)
```

---

## Next Recommended Phase

**Phase 2B Group 3 — FarmerDashboard and FarmerSubmitInventory (audit separately)**

These two files have different risk profiles and should be audited independently before any move:

- `FarmerDashboard.tsx` — core farmer entry point; imports `loadFarmDraft`, `UserProfile`; passes `openRequestsCount` and multiple callback props. Likely safe but audit first.
- `FarmerSubmitInventory.tsx` — complex multi-step inventory submission form; receives a COA upload prop (`onCoaUpload`), draft logic, market benchmarks, and review requests. Higher complexity — audit carefully and consider moving alone after FarmerDashboard is confirmed.

Recommended next prompt:

```
CONTROLLED AUDIT — PHASE 2B GROUP 3 PRE-MOVE AUDIT ONLY

Audit FarmerDashboard.tsx and FarmerSubmitInventory.tsx before moving either
into src/pages/farmer/. Inspect all imports, props interfaces, and any special
wiring in App.tsx. Classify move risk for each file separately. Do not move files.
```
