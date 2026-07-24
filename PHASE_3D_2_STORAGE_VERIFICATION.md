# Phase 3D-2 Validation — Live Supabase COA Storage Verification

**Date:** 2026-07-02  
**Branch:** auth-rls-mvp  
**Live URL:** <https://ddp-brokerage-demo.onrender.com>  
**Code commit validated:** `737427c` — Feat: upload COA PDF during inventory submission  
**Current docs commit / live deploy lineage:** `cb157f4` — DOCS: validate Phase 3C-2 submit-time COA upload

`cb157f4` is a docs-only commit containing no app-code changes beyond `737427c`. Render's live deployment showed `cb157f4` as the deployed commit; because it carries no app-code delta, the deployed application logic is fully equivalent to `737427c`.

---

## Why This Verification Was Required

Phase 3D-1 (repo-only RLS audit) confirmed that the Phase 3C-2 COA upload architecture was sound:
- Storage path construction matched the INSERT policy assumption.
- `patchInventoryBatch` COA fields were compatible with the farmer UPDATE policy.
- `getCoaSignedUrl` was correctly gated to admin-only components.

However, 3D-1 identified three critical live Supabase checks that could not be confirmed from the repo alone:

| Check | Concern |
|-------|---------|
| **V6** — `coa_storage_path` column on `inventory_batches` | Column added by `8_COA_UPLOAD_STORAGE_MIGRATION.sql` Part A; unconfirmed whether applied |
| **V7** — `farmer-documents` bucket exists and is private | Bucket defined in SQL comments and dashboard steps; could not be confirmed without live access |
| **V3** — Storage RLS policies for `farmer-documents` | Policies defined in `8_COA_UPLOAD_STORAGE_MIGRATION.sql` Part C; unconfirmed whether applied |

Initial live check of **V7** returned 0 rows — the bucket did not exist. A missing bucket is a hard blocker for COA upload: `uploadCoaFile()` in `db.ts` calls `supabase.storage.from('farmer-documents').upload(...)`, which fails immediately if the bucket is absent.

---

## Manual Supabase Fix Applied

The `farmer-documents` bucket was created manually via the Supabase Storage dashboard (no SQL run from this repo session or CLI).

| Setting | Value |
|---------|-------|
| Bucket name | `farmer-documents` |
| Visibility | Private (`public = false`) |
| MIME restriction | `application/pdf` |
| Max file size | Per dashboard default (10 MB target per `8_COA_UPLOAD_STORAGE_MIGRATION.sql` comment) |

No repo code was changed for this fix. No migration file was created in this step. The repo already contained `8_COA_UPLOAD_STORAGE_MIGRATION.sql` with the bucket creation instructions (marked as a manual dashboard step — no SQL equivalent). The fix was the manual execution of those documented steps.

---

## Live Verification Checklist

- [x] **V6** — `coa_storage_path` column exists on `inventory_batches`
  - `column_name: coa_storage_path` · `data_type: text` · `is_nullable: YES`
- [x] **V7** — `farmer-documents` bucket exists
- [x] **V7** — `farmer-documents` bucket is private (`public = false`)
- [x] **V7** — `allowed_mime_types` includes `application/pdf`
- [x] **V3** — `farmer-documents: admin all` policy exists (ALL)
- [x] **V3** — `farmer-documents: farmer read own` policy exists (SELECT)
- [x] **V3** — `farmer-documents: farmer upload own` policy exists (INSERT)
- [x] Render live deploy confirmed
- [x] Deployed code includes `737427c` (via `cb157f4` docs-only lineage)
- [x] User confirmed live COA upload verification passed after bucket creation
- [x] User confirmed signed URL / admin COA open flow passed
- [x] No app code changed
- [x] No SQL run from repo or CLI
- [x] No secrets changed
- [x] No Render CLI used
- [x] RESET_*.sql files remained untracked only

---

## Risk Notes

- Bucket creation was a **manual Supabase dashboard change**, not a repo migration. It is not captured in any committed SQL file as an applied state — only as documented instructions in `8_COA_UPLOAD_STORAGE_MIGRATION.sql`.
- The repo already contains `8_COA_UPLOAD_STORAGE_MIGRATION.sql`, but the live bucket had not been created prior to this verification step.
- **Future environment rebuilds** (new Supabase project, staging environment, handover) must ensure the `farmer-documents` bucket is manually created as private with `application/pdf` MIME restriction before deploying the Phase 3C-2 code.
- Current production is now aligned: `coa_storage_path` column exists, bucket is private, and all three storage RLS policies are active.
- Full RLS audit queries **V1, V2, V4, V5, V8, V9, and V10** from the Phase 3D-1 report remain optional if deeper RLS policy verification is desired in a future sub-phase.
- This document covers the critical COA storage verification. It is not an exhaustive proof of all RLS policies across all tables.

---

## Final Status

**Status: PASSED — critical COA storage blocker resolved**
