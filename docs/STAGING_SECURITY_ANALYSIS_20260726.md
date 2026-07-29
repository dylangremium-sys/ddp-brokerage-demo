# Staging Security Harness — Analysis & Next Steps

**Date:** 2026-07-26  
**Analysis scope:** Staging harness failures from 2026-07-21 run

## Summary

Staging security harness reported 5 failures:
- **3 migrations (12, 14, 15)** — VERIFY assertion failures — **STALE EXPECTATIONS**
- **2 storage operations** — cleanup failures — **GENUINE DEFECT (storage cleanup bug)**

## Findings

### A. Stale VERIFY Assertions (Migrations 12, 14, 15)

These VERIFY scripts predate migrations 19–23 and assert conditions that those later migrations legitimately changed:

| Migration | Check | Nature | Evidence |
|---|---|---|---|
| **12** | "no public/anon executable functions" (count=0) | Stale | Migrations 19, 22, 23 added functions with broader ACLs for role-based routing |
| **14** | Object count invariants; "farms table unchanged" | Stale | Migration 19 adds `fn_protect_farm_admin_fields()`; 23 adds `issue_buyer_pack_snapshot` |
| **15** | Fixed function inventory; "all tables RLS on" | Stale | Deepest audit; asserts pre-migration-19 snapshot; later migrations expand function set |

**Status:** KNOWN and DOCUMENTED. These do not represent live drift; they represent schema legitimately growing as new migrations apply.

**Resolution path (Phase 3b, deferred):**
1. Separate "core migration effect" checks from "inventory snapshot" checks
2. Update function inventory in migrations 14, 15 to include migrations 19–23
3. For migration 12, verify which new functions have public/anon EXECUTE and confirm intentional
4. Update VERIFY scripts and re-run harness

---

### B. Storage Cleanup Bug (Genuine Defect)

**Root cause:** Control-object deletion is failing; 36 residual synthetic test objects remain on staging from prior runs (2026-07-12 to 2026-07-20).

**Location:** `scripts/run-staging-security-tests.mjs` — storage cleanup section

**Pattern:** Similar to previous farm-cleanup bug (filter on non-existent column).

**Resolution (Phase 3a, actionable):**
1. Debug and fix the DELETE logic for storage list-control objects
2. Re-run harness to verify cleanup now succeeds
3. Manually cleanup the 36 residual objects (or include in harness cleanup)

---

## Recommendation

**Phase 3a (this phase):** Fix the storage cleanup bug; document the stale-expectation findings.

**Phase 3b (later phase):** Update migrations 12, 14, 15 VERIFY scripts once function inventory is stable. This work should involve:
- A developer confirming which new function grants are intentional
- Systematic refactoring of "structure" checks vs "snapshot" checks
- A principle: "Keep VERIFY scripts current as later migrations modify the schema"

**Phase 3c (post-pilot):** Consider consolidating these migration-specific VERIFY scripts into a single "catalog health" script that tracks changes across the full migration arc.

---

## Storage Residue Cleanup Commands

For post-harness manual cleanup of the 36 remaining synthetic objects:

```sql
-- Run against staging, authenticated as a read-write role (e.g., authenticated or service_role)
-- DO NOT run against production

DELETE FROM storage.objects 
WHERE bucket_id IN (
  SELECT id FROM storage.buckets 
  WHERE name IN ('farmer-documents', 'farmer-photos')
)
AND name LIKE '%security-test-%';

-- Verify cleanup
SELECT bucket_id, COUNT(*) as remaining_count
FROM storage.objects
WHERE name LIKE '%security-test-%'
GROUP BY bucket_id;
```

If the bucket is scoped to service_role (bucket auth is RLS-gated), execute as `service_role`:

```bash
export STAGING_ADMIN_JWT="<service_role_jwt>"
export STAGING_SUPABASE_URL="<url>"

curl -X DELETE "${STAGING_SUPABASE_URL}/storage/v1/b/farmer-documents/search?prefix=security-test-" \
  -H "Authorization: Bearer ${STAGING_ADMIN_JWT}"

curl -X DELETE "${STAGING_SUPABASE_URL}/storage/v1/b/farmer-photos/search?prefix=security-test-" \
  -H "Authorization: Bearer ${STAGING_ADMIN_JWT}"
```

---

## Next Steps

1. **Review:** Developer confirms the stale-expectation analysis (spot check one failing check per migration)
2. **Fix Phase 3a:** Update `scripts/run-staging-security-tests.mjs` storage cleanup logic
3. **Verify:** Re-run harness; confirm storage cleanup passes
4. **Schedule Phase 3b:** Plan VERIFY script refactoring (separate from this audit if timeline is tight)
5. **Document:** Add comment to migrations 12, 14, 15 headers noting they may have later migration dependencies
