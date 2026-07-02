# Phase 3C-1 Validation — Submit-Time COA Copy Clarification

**Date:** 2026-07-02
**Branch:** auth-rls-mvp
**Live URL:** https://ddp-brokerage-demo.onrender.com

## Commits Validated

| Hash | Message |
|---|---|
| `b0a36f2` | Copy: clarify submit-time COA file handling |

## Merge and Deployment

- `origin/auth-rls-mvp` reached `b0a36f2` ✓
- `origin/main` reached `b0a36f2` via fast-forward merge only ✓
- Render manual deploy completed for `b0a36f2` ✓
- User manually smoke-tested the live app ✓

## Code Change Summary

**File changed:**
- `src/pages/farmer/FarmerSubmitInventory.tsx` — 1 file, 6 insertions, 2 deletions

**Behavior changed:**
- COA submit-time section label changed from upload-oriented wording ("Upload COA file (PDF / image)") to filename-oriented wording ("COA file name" / "ชื่อไฟล์ COA")
- Helper text now explains that the file name is saved for the submission
- Helper text now explains that the actual COA PDF upload happens from My Stock after submitting
- Thai helper text updated inline using the existing `isTh` ternary pattern already in the file
- No translation keys added to `translations.ts`

**Behavior preserved:**
- `handleCoaFile` logic unchanged — captures `file.name` only, as before
- `onSubmit` signature unchanged
- `buildItem()` unchanged — emits `certFileName` string and `coaAvailable` boolean as before
- `coaAvailable` toggle behavior unchanged
- `coaFileName` state capture unchanged
- No submit-time upload logic added
- No `File` object retained or passed upward

## Validation Checklist

- [x] Build passed before commit (0 TypeScript errors, 88 modules)
- [x] Branch fast-forwarded to main
- [x] Render manual deploy completed
- [x] Live app loaded
- [x] Farmer login passed
- [x] Admin login passed
- [x] Submit Inventory page opened
- [x] COA section still appeared
- [x] COA label showed "COA file name" / "ชื่อไฟล์ COA"
- [x] COA helper text explained filename-only behavior
- [x] COA helper text explained actual COA PDF upload happens from My Stock after submission
- [x] Selecting a COA file still recorded the filename
- [x] Submit/save draft flow still worked
- [x] My Stock still opened
- [x] Existing post-submission COA upload flow preserved
- [x] Admin Inventory Review still opened
- [x] Admin COA display/Open COA behavior unchanged
- [x] Buyer Pack still opened
- [x] Buyer Pack COA behavior unchanged
- [x] Farmer Dashboard still opened
- [x] FarmerStatus / My Submissions still opened
- [x] Admin pages still loaded
- [x] Route guards unchanged
- [x] Demo mode not modified
- [x] No SQL run
- [x] No Supabase changes
- [x] No secrets changed
- [x] RESET_*.sql files remained untracked only

## Risk Notes

- This was a copy-only frontend clarification — no functional change.
- No actual COA upload was added at submit time.
- No `File` object was retained or passed upward through `onSubmit`.
- No Supabase Storage, RLS, schema, or `db.ts` changes were made.
- Existing post-submission COA upload from My Stock remains the only real upload path.
- Buyer Pack signed URL behavior was not changed.
- Admin Inventory Review COA behavior was not changed.

## Status

**PASSED**
