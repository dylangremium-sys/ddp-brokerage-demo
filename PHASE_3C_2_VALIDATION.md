# Phase 3C-2 Validation — Submit-Time COA PDF Upload

**Date:** 2026-07-02
**Branch:** auth-rls-mvp
**Commit validated:** `737427c` — Feat: upload COA PDF during inventory submission
**Live URL:** https://ddp-brokerage-demo.onrender.com

---

## Merge and Deploy Status

| Check | Result |
|-------|--------|
| `origin/auth-rls-mvp` reached `737427c` | ✅ Confirmed |
| `origin/main` reached `737427c` | ✅ Confirmed |
| Merge type | Fast-forward only (`--ff-only`) |
| Render manual deploy for `737427c` | ✅ Completed |
| User smoke-tested live app | ✅ Confirmed |

---

## Code Change Summary

### Files Changed

- `src/App.tsx`
- `src/pages/farmer/FarmerSubmitInventory.tsx`

### Behavior Added

- Farmer Submit Inventory now retains the selected COA PDF file locally at submit time.
- Submit-time COA picker is PDF-only (`accept=".pdf,application/pdf"`).
- Non-PDF files are rejected or prevented (client-side MIME/extension check with inline error).
- On live Supabase farmer submissions, the inventory batch is saved first.
- After the batch save succeeds, the COA PDF is uploaded to the existing `farmer-documents` storage flow.
- The inventory batch is patched with:
  - `coa_file_name`
  - `coa_available`
  - `coa_storage_path`
- React inventory state is updated with:
  - `certFileName`
  - `coaAvailable`
  - `coaStoragePath`
- Admin and Buyer Pack signed URL behavior becomes available immediately after submit-time upload.
- My Stock upload/replace remains unchanged as the retry/replace path.
- Demo mode remains filename-only (no upload when `!isSupabaseConfigured`).
- Draft save does not upload a COA.
- Upload failure does not roll back the submitted inventory item.

---

## Implementation Notes

- No `File` object was added to `InventoryItem`.
- `buildItem` does not persist a `File` object.
- `onSubmit` now accepts an optional `File` argument: `onSubmit: (item: InventoryItem, coaFile?: File | null) => void | Promise<void>`.
- `handleInventorySubmit` now accepts an optional COA `File`.
- `createInventoryBatch` is awaited before COA upload/patch, ensuring the Supabase row exists before `patchInventoryBatch` runs.
- COA upload is gated to five conditions:
  - `coaFile` exists
  - `isSupabaseConfigured`
  - `isFarmerRole`
  - `currentProfile` exists
  - `item.id` exists
- Existing `handleCoaUpload` for My Stock was not changed.
- `lib/db.ts` was not changed.
- `uploadCoaFile`, `patchInventoryBatch`, and `getCoaSignedUrl` were reused as-is.
- No Supabase schema, SQL, RLS, or storage policy changes were made.

---

## Validation Checklist

- [x] Build passed before commit
- [x] Branch fast-forwarded to main
- [x] Render manual deploy completed
- [x] Live app loaded
- [x] Farmer login passed
- [x] Admin login passed
- [x] Submit Inventory page opened
- [x] COA section still appeared
- [x] COA file picker was PDF-only
- [x] Non-PDF file was rejected or not selectable
- [x] Selecting a PDF recorded the filename
- [x] Helper text matched submit-time upload behavior
- [x] New inventory batch with PDF COA submitted successfully
- [x] User routed to My Stock after submission
- [x] New batch appeared in My Stock
- [x] New batch showed COA filename
- [x] New batch showed COA present / replace option
- [x] Admin Inventory Review opened
- [x] Newly submitted batch appeared for review
- [x] COA filename appeared in Admin Inventory Review
- [x] Open COA button appeared
- [x] Open COA button opened signed PDF URL
- [x] Buyer Pack opened for the submitted batch
- [x] Buyer Pack COA badge/status appeared correctly
- [x] Buyer Pack Open COA behavior worked if available
- [x] Existing My Stock manual COA upload/replace flow still worked
- [x] Existing My Stock batches still loaded
- [x] Farmer Dashboard still opened
- [x] FarmerStatus / My Submissions still opened
- [x] Admin pages still loaded
- [x] Route guards unchanged
- [x] Demo mode remained filename-only if tested
- [x] Upload failure did not roll back submission if tested
- [x] Farmer could retry COA upload from My Stock if tested
- [x] No SQL run
- [x] No Supabase changes
- [x] No secrets changed
- [x] RESET_*.sql files remained untracked only

---

## Risk Notes

- This was a frontend/data-flow change only.
- No database schema change was required.
- No storage policy change was required.
- No RLS change was required.
- The existing My Stock upload path remains the fallback and replace path.
- Admin Inventory Review and Buyer Pack components were not changed.
- Signed URL behavior was not changed; it only now receives `coaStoragePath` earlier (immediately after a submit-time upload).

---

## Final Status

**Status: PASSED**
