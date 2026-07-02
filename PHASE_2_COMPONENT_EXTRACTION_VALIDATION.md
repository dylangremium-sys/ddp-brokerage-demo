# Phase 2 Component Extraction — Validation Record

**Date:** 2026-07-02
**Live URL:** https://ddp-brokerage-demo.onrender.com
**Deployed commit:** `3fec122` — Fix: harden farmer status badge rendering
**Phase 2 refactor commit:** `60013dd` — Refactor: extract farmer and admin navigation components
**Branch:** main / auth-rls-mvp (both at `3fec122`)

---

## Phase 2 Summary

Five inline components were extracted from `src/App.tsx` into standalone files with no intended behaviour change:

| Component | New file |
|---|---|
| `AdminNav` | `src/components/admin/AdminNav.tsx` |
| `FarmerNav` | `src/components/farmer/FarmerNav.tsx` |
| `LangToggle` | `src/components/shared/LangToggle.tsx` |
| `UserBadge` | `src/components/shared/UserBadge.tsx` |
| `AccessDenied` | `src/components/shared/AccessDenied.tsx` |

`App.tsx` was reduced by ~80 lines. The unused `import { T } from './translations'` was removed after `T` moved into `FarmerNav.tsx`. Build passed with 0 errors before and after.

---

## Regression Found After Deploy

**Symptom:** Farmer → My Submissions showed a blank dark green screen after the Phase 2 deploy.

**Investigation:** Audit confirmed no page key mismatch — `'farmer-status'` was used consistently in `FarmerNav.tsx`, the App.tsx render block, and all `FarmerDashboard` callbacks, identical to the pre-extraction code. All Thai translation keys used by `FarmerNav` (`farmerGroupLabel`, `navDashboard`, `buildProfile`, `myStock`, `myActivity`) existed in both EN and TH.

**Root cause (two factors):**

1. **Stale browser bundle cache.** After a Render deploy, the JS bundle hash changes but the browser may serve a cached `index.html` that references the old hash. Render stops serving old bundle files, so the JS 404s while the CSS (stable hash) still loads — leaving only the `#07130F` body background visible. Hard refresh resolves this.

2. **Unsafe status badge rendering in `src/pages/FarmerStatus.tsx`.** The farm and inventory status badge lookups were not guarded against unexpected values from live Supabase data:
   - `FARM_STATUS_CLASS[farm.status]` — could return `undefined` for an unexpected status string
   - `FARM_STATUS_LABEL[farm.status][lang]` — throws `TypeError: Cannot read properties of undefined` when the above is `undefined`
   - `STATUS_CLASS[item.status]` — same pattern for inventory items
   - `INVENTORY_STATUS_LABEL[item.status][lang]` — same throw risk

   In production, React silently unmounts the crashed component tree, leaving just the dark green body background.

---

## Fix Applied

**Commit:** `3fec122` — Fix: harden farmer status badge rendering
**File:** `src/pages/FarmerStatus.tsx`

Both badge render sites hardened with optional chaining and nullish fallbacks:

```tsx
// Farm status badge — before
<span className={`badge ${FARM_STATUS_CLASS[farm.status]}`}>
  {FARM_STATUS_LABEL[farm.status][lang]}
</span>

// Farm status badge — after
<span className={`badge ${FARM_STATUS_CLASS[farm.status] ?? 'badge-gray'}`}>
  {FARM_STATUS_LABEL[farm.status]?.[lang] ?? farm.status}
</span>

// Inventory status badge — before
<span className={`badge ${STATUS_CLASS[item.status]}`}>
  {INVENTORY_STATUS_LABEL[item.status][lang]}
</span>

// Inventory status badge — after
<span className={`badge ${STATUS_CLASS[item.status] ?? 'badge-pending'}`}>
  {INVENTORY_STATUS_LABEL[item.status]?.[lang] ?? item.status}
</span>
```

An unknown status value now renders a grey badge with the raw status string instead of crashing.

---

## Live Validation (post-deploy, post-hard-refresh)

| Check | Result |
|---|---|
| Farmer dashboard loads | ✓ |
| Continue Farm Profile loads | ✓ |
| My Stock loads | ✓ |
| My Submissions loads | ✓ resolved |
| Farmer nav remains visible for farmer role | ✓ |
| Admin user sees DDP nav only (no farmer nav) | ✓ |
| Buyer Pack opens from Master Inventory | ✓ |
| Open Photo works (blob URL conversion) | ✓ |
| Print / Save PDF works | ✓ |

---

## Operational Note

**Hard refresh after Render deploys.** Always do a hard refresh (Cmd+Shift+R on Mac / Ctrl+F5 on Windows) on the live URL after any Render deploy before testing. Render changes JS bundle hashes on each deploy; a cached `index.html` from a prior deploy will reference a stale bundle that no longer exists, producing a dark green blank screen regardless of the code in the new deploy.

---

## Phase History

| Phase | Commit | Description |
|---|---|---|
| Phase 1 | `98424bb` | Nav fix: separated farmer/admin nav visibility; added admin route guard in `goTo()` |
| Phase 2 | `60013dd` | Component extraction: AdminNav, FarmerNav, LangToggle, UserBadge, AccessDenied |
| Phase 2 fix | `3fec122` | Hardened FarmerStatus badge rendering against unexpected Supabase status values |

---

## Next Recommended Phase

**Phase 2B — Page file organisation (low risk, incremental).**

Move farmer and admin page files from `src/pages/` into internal subdirectories (`src/pages/farmer/`, `src/pages/admin/`) one small group at a time. Build and live-validate after each pass. Import paths in App.tsx update automatically with find-and-replace; no logic changes required.

Suggested order:
1. Farmer core pages: `FarmerDashboard`, `FarmerMyStock`, `FarmerStatus`
2. Farmer forms: `FarmerOnboarding`, `FarmerAdvancedProfile`, `FarmerSubmitInventory`, `FarmerRequests`
3. Admin pages: `DDPOverview`, `DDPFarmProfiles`, `DDPFarmReview`, `DDPInventoryDashboard`, `DDPInventoryReview`, `DDPMasterInventory`, `DDPBuyerPreview`
4. Shared pages: `LandingPage`, `LoginPage`, `SignupPage`, `FarmerRegister`

Phase 3 (full portal split into separate entry points / route trees) remains deferred.
