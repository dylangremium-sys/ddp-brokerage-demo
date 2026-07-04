-- ============================================================================
-- FILE A: BACKUP_COUNTS_BEFORE_RESET.sql
-- Date: 2026-06-30
--
-- READ-ONLY diagnostic snapshot.
-- Run this BEFORE applying RESET_B_DEMO_DATA.sql.
-- No destructive commands in this file.
-- ============================================================================


-- ============================================================================
-- 1. ROW COUNTS — every affected table
-- ============================================================================

SELECT 'profiles'                  AS table_name, COUNT(*) AS row_count FROM public.profiles
UNION ALL
SELECT 'farms',                                   COUNT(*)               FROM public.farms
UNION ALL
SELECT 'farm_profiles',                           COUNT(*)               FROM public.farm_profiles
UNION ALL
SELECT 'farm_memberships',                        COUNT(*)               FROM public.farm_memberships
UNION ALL
SELECT 'inventory_batches',                       COUNT(*)               FROM public.inventory_batches
UNION ALL
SELECT 'farmer_review_requests',                  COUNT(*)               FROM public.farmer_review_requests
UNION ALL
SELECT 'documents',                               COUNT(*)               FROM public.documents
UNION ALL
SELECT 'farmer_documents',                        COUNT(*)               FROM public.farmer_documents
UNION ALL
SELECT 'farmer_photos',                           COUNT(*)               FROM public.farmer_photos
UNION ALL
SELECT 'ddp_scores',                              COUNT(*)               FROM public.ddp_scores
UNION ALL
SELECT 'risk_flags',                              COUNT(*)               FROM public.risk_flags
UNION ALL
SELECT 'status_history',                          COUNT(*)               FROM public.status_history
UNION ALL
SELECT 'market_price_benchmarks (KEEP — ref data)', COUNT(*)            FROM public.market_price_benchmarks
ORDER BY table_name;


-- ============================================================================
-- 2. STORAGE OBJECTS — files in farm-connected buckets
-- ============================================================================

SELECT
  bucket_id,
  COUNT(*)      AS object_count,
  MIN(created_at) AS oldest,
  MAX(created_at) AS newest
FROM storage.objects
WHERE bucket_id IN ('farmer-documents', 'farmer-photos')
GROUP BY bucket_id;


-- ============================================================================
-- 3. PROFILE SUMMARY — non-sensitive; no passwords exposed
-- ============================================================================

SELECT
  p.id,
  p.display_name,
  p.email,
  p.role,
  p.created_at,
  CASE WHEN p.role = 'ddp_admin' THEN 'KEEP — admin account'
       ELSE 'candidate for deletion'
  END AS reset_action
FROM public.profiles p
ORDER BY p.role DESC, p.created_at;


-- ============================================================================
-- 4. FARM / MEMBERSHIP RELATIONSHIP SUMMARY
-- ============================================================================

SELECT
  f.id            AS farm_id,
  f.farm_name,
  f.status        AS farm_status,
  f.created_at    AS farm_created,
  p.email         AS owner_email,
  p.role          AS owner_profile_role,
  fm.role         AS membership_role
FROM public.farms f
LEFT JOIN public.farm_memberships fm ON fm.farm_id = f.id
LEFT JOIN public.profiles p          ON p.id       = fm.user_id
ORDER BY f.created_at;


-- ============================================================================
-- 5. INVENTORY BATCH SUMMARY
-- ============================================================================

SELECT
  ib.id,
  ib.product_name,
  ib.status,
  ib.quantity_kg,
  ib.created_at,
  f.farm_name
FROM public.inventory_batches ib
LEFT JOIN public.farms f ON f.id = ib.farm_id
ORDER BY ib.created_at;


-- ============================================================================
-- 6. REVIEW REQUESTS SUMMARY
-- ============================================================================

SELECT
  frr.id,
  frr.request_type,
  frr.status,
  frr.farm_name,
  frr.product_name,
  frr.created_at
FROM public.farmer_review_requests frr
ORDER BY frr.created_at;


-- ============================================================================
-- 7. CONFIRM ADMIN PROFILE EXISTS (expect 1+ rows)
-- ============================================================================

SELECT
  id,
  email,
  display_name,
  role,
  created_at
FROM public.profiles
WHERE role = 'ddp_admin';
