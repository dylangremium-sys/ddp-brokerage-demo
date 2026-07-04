-- ============================================================================
-- FILE B: RESET_DEMO_DATA_KEEP_ADMIN.sql
-- Date: 2026-06-30
--
-- Deletes all demo/business data in safe FK order.
-- PRESERVES:
--   • Admin profile (profiles WHERE role = 'ddp_admin')
--   • auth.users (ALL rows — no auth.users deletion in this file)
--   • market_price_benchmarks (reference/seed data, not demo data)
--   • All table structures, indexes, RLS policies, triggers, functions
--
-- DELETES:
--   • All storage objects in farmer-documents and farmer-photos buckets
--   • All status_history rows
--   • All farmer_review_requests rows
--   • All documents rows
--   • All farmer_documents rows
--   • All farmer_photos rows
--   • All ddp_scores rows
--   • All risk_flags rows
--   • All inventory_batches rows
--   • All farm_memberships rows
--   • All farm_profiles rows
--   • All farms rows
--   • Farmer profiles (profiles WHERE role = 'farmer')
--
-- NOTE ON auth.users:
--   Farmer auth.users rows are NOT deleted. Those users can still log in
--   but will have no profile row (the app will show an error). To fully
--   remove demo users, a Supabase admin must delete them from
--   Authentication → Users in the dashboard, or run a separate targeted
--   DELETE FROM auth.users WHERE id IN (...) after manual inspection.
--
-- ROLLBACK:
--   This script is wrapped in BEGIN / COMMIT. If you need to abort
--   mid-execution, run ROLLBACK; in the same SQL Editor session before
--   clicking Run on this script. Once COMMIT executes, the deletes are
--   permanent. Restore from a Supabase database backup (Project → Backups)
--   if you need to undo after COMMIT.
-- ============================================================================

-- ============================================================================
-- PRE-FLIGHT: confirm admin profile exists before proceeding
-- ============================================================================
-- Run this standalone first. If it returns 0 rows, STOP — do not apply the
-- reset until you have confirmed the admin account.
--
-- SELECT id, email, display_name, role
-- FROM public.profiles
-- WHERE role = 'ddp_admin';
-- ============================================================================

BEGIN;

-- ── Count snapshot going in ─────────────────────────────────────────────────
-- Save these counts for your records before the deletions execute.

SELECT 'PRE-DELETE COUNTS' AS checkpoint,
       (SELECT COUNT(*) FROM public.farms)                    AS farms,
       (SELECT COUNT(*) FROM public.inventory_batches)        AS inventory_batches,
       (SELECT COUNT(*) FROM public.farm_memberships)         AS farm_memberships,
       (SELECT COUNT(*) FROM public.profiles)                 AS profiles,
       (SELECT COUNT(*) FROM public.farmer_review_requests)   AS review_requests,
       (SELECT COUNT(*) FROM public.status_history)           AS status_history,
       (SELECT COUNT(*) FROM public.ddp_scores)               AS ddp_scores,
       (SELECT COUNT(*) FROM public.risk_flags)               AS risk_flags,
       (SELECT COUNT(*) FROM storage.objects
        WHERE bucket_id IN ('farmer-documents','farmer-photos')) AS storage_objects;


-- ============================================================================
-- STEP 1: Storage objects
-- Must be first — Supabase Storage is not automatically cascade-deleted when
-- DB rows are deleted. Orphaned storage objects waste quota and expose stale
-- file URLs.
-- ============================================================================
DELETE FROM storage.objects
WHERE bucket_id IN ('farmer-documents', 'farmer-photos');


-- ============================================================================
-- STEP 2: status_history
-- Polymorphic table (entity_type / entity_id) — no FK cascade.
-- Must be deleted explicitly before farms and inventory_batches are removed,
-- otherwise the history rows become permanently orphaned with no way to
-- identify their parent.
-- ============================================================================
DELETE FROM public.status_history;


-- ============================================================================
-- STEP 3: farmer_review_requests
-- FK: farm_id → farms ON DELETE CASCADE
--     inventory_batch_id → inventory_batches ON DELETE CASCADE
-- Deleting explicitly here rather than relying on cascade so the step is
-- visible and auditable.
-- ============================================================================
DELETE FROM public.farmer_review_requests;


-- ============================================================================
-- STEP 4: documents  (admin-managed document metadata)
-- FK: farm_id → farms ON DELETE CASCADE
--     inventory_batch_id → inventory_batches ON DELETE CASCADE
-- ============================================================================
DELETE FROM public.documents;


-- ============================================================================
-- STEP 5: farmer_documents  (COA files uploaded by farmers)
-- FK: farm_id → farms ON DELETE CASCADE
--     inventory_batch_id → inventory_batches ON DELETE SET NULL
-- ============================================================================
DELETE FROM public.farmer_documents;


-- ============================================================================
-- STEP 6: farmer_photos
-- FK: farm_id → farms ON DELETE CASCADE
--     inventory_batch_id → inventory_batches ON DELETE CASCADE
-- ============================================================================
DELETE FROM public.farmer_photos;


-- ============================================================================
-- STEP 7: ddp_scores
-- FK: farm_id → farms ON DELETE CASCADE
-- ============================================================================
DELETE FROM public.ddp_scores;


-- ============================================================================
-- STEP 8: risk_flags
-- FK: farm_id → farms ON DELETE CASCADE
-- ============================================================================
DELETE FROM public.risk_flags;


-- ============================================================================
-- STEP 9: inventory_batches
-- FK: farm_id → farms ON DELETE SET NULL  (not CASCADE — must delete first)
-- Deleting before farms to cleanly remove batches and prevent orphaned rows
-- with farm_id = NULL polluting a fresh baseline.
-- ============================================================================
DELETE FROM public.inventory_batches;


-- ============================================================================
-- STEP 10: farm_memberships
-- FK: farm_id → farms ON DELETE CASCADE
--     user_id  → auth.users ON DELETE CASCADE
-- ============================================================================
DELETE FROM public.farm_memberships;


-- ============================================================================
-- STEP 11: farm_profiles
-- FK: farm_id → farms ON DELETE CASCADE
-- ============================================================================
DELETE FROM public.farm_profiles;


-- ============================================================================
-- STEP 12: farms  (root entity)
-- After Steps 1–11, this should cascade-delete any remaining child rows.
-- ============================================================================
DELETE FROM public.farms;


-- ============================================================================
-- STEP 13: farmer profiles
-- Deletes profiles WHERE role = 'farmer'.
-- Does NOT delete auth.users — those users can still log in but will have
-- no profile, which will cause a "profile not found" error in the app.
-- See file header note about auth.users cleanup.
-- ============================================================================
DELETE FROM public.profiles
WHERE role = 'farmer';


-- ── Count snapshot after deletion ───────────────────────────────────────────
SELECT 'POST-DELETE COUNTS' AS checkpoint,
       (SELECT COUNT(*) FROM public.farms)                    AS farms,
       (SELECT COUNT(*) FROM public.inventory_batches)        AS inventory_batches,
       (SELECT COUNT(*) FROM public.farm_memberships)         AS farm_memberships,
       (SELECT COUNT(*) FROM public.profiles)                 AS profiles,
       (SELECT COUNT(*) FROM public.farmer_review_requests)   AS review_requests,
       (SELECT COUNT(*) FROM public.status_history)           AS status_history,
       (SELECT COUNT(*) FROM public.ddp_scores)               AS ddp_scores,
       (SELECT COUNT(*) FROM public.risk_flags)               AS risk_flags,
       (SELECT COUNT(*) FROM storage.objects
        WHERE bucket_id IN ('farmer-documents','farmer-photos')) AS storage_objects;


-- ── Confirm admin profile survived ──────────────────────────────────────────
-- Expect: 1+ rows with role = 'ddp_admin'.
SELECT id, email, display_name, role, created_at
FROM public.profiles
WHERE role = 'ddp_admin';

-- Expect: 1 row — 'farmer' profiles gone, admin preserved.
SELECT role, COUNT(*) AS count
FROM public.profiles
GROUP BY role;

-- Expect: 5 rows — reference data preserved.
SELECT COUNT(*) AS market_benchmarks_preserved
FROM public.market_price_benchmarks;


COMMIT;


-- ============================================================================
-- POST-COMMIT VERIFICATION (run separately after COMMIT)
-- ============================================================================

-- All 12 business tables should be empty:
-- SELECT 'farms',                COUNT(*) FROM public.farms
-- UNION ALL
-- SELECT 'farm_profiles',        COUNT(*) FROM public.farm_profiles
-- UNION ALL
-- SELECT 'farm_memberships',     COUNT(*) FROM public.farm_memberships
-- UNION ALL
-- SELECT 'inventory_batches',    COUNT(*) FROM public.inventory_batches
-- UNION ALL
-- SELECT 'farmer_review_requests', COUNT(*) FROM public.farmer_review_requests
-- UNION ALL
-- SELECT 'documents',            COUNT(*) FROM public.documents
-- UNION ALL
-- SELECT 'farmer_documents',     COUNT(*) FROM public.farmer_documents
-- UNION ALL
-- SELECT 'farmer_photos',        COUNT(*) FROM public.farmer_photos
-- UNION ALL
-- SELECT 'ddp_scores',           COUNT(*) FROM public.ddp_scores
-- UNION ALL
-- SELECT 'risk_flags',           COUNT(*) FROM public.risk_flags
-- UNION ALL
-- SELECT 'status_history',       COUNT(*) FROM public.status_history;

-- Admin profile must exist:
-- SELECT id, email, display_name, role FROM public.profiles WHERE role = 'ddp_admin';

-- Storage must be empty in farm buckets:
-- SELECT bucket_id, COUNT(*) FROM storage.objects
-- WHERE bucket_id IN ('farmer-documents','farmer-photos')
-- GROUP BY bucket_id;
