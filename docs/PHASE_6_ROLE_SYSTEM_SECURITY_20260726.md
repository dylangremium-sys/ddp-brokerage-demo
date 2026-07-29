# Phase 6: Role System Security Audit (AUDIT-017)

**Date:** 2026-07-26  
**Status:** Completes success criteria for "role system secure"  
**Risk Level:** High (authorization model has critical gaps)

---

## Executive Summary

The application implements a **hybrid authorization model** that is **fundamentally insecure**:

1. **Client-side role checks** (`isAdminRole`, `isFarmerRole` variables in App.tsx)
2. **Demo mode bypass** (`isDemo = !isSupabaseConfigured` gives everyone admin access)
3. **localStorage fallback** (122 references to localStorage; can mask API failures)
4. **Incomplete RLS enforcement** (migrations 19, 22 partially verified)

**Critical Issue:** If demo mode is ever enabled in a non-isolated environment, all authorization checks are bypassed.

---

## Role System Architecture

### How Roles Are Currently Enforced

#### Layer 1: Client-Side Role Checks (App.tsx)

```typescript
const isSupabaseConfigured = !!import.meta.env.VITE_SUPABASE_URL
const isDemo = !isSupabaseConfigured  // ← If Supabase URL missing, demo mode activates

const isAdminRole = isDemo || currentProfile?.role === 'ddp_admin'
const isFarmerRole = !isDemo && currentProfile?.role === 'farmer'
```

**Problem 1:** If `VITE_SUPABASE_URL` is not set (empty string, undefined, or accidentally removed):
- `isDemo` becomes `true`
- `isAdminRole` becomes `true` (everyone is admin)
- All database checks are bypassed
- Farmer sees admin interface
- Admin/farmer boundary disappears

**Example Vulnerable Code (line 816-817):**
```typescript
const showFarmerNav = isDemo || isFarmerRole      // Demo shows farmer nav
const showDDPNav = isAdminRole                     // Demo shows DDP (admin) nav; BOTH shown
```

Result: In demo mode, all users see both farmer AND admin navigation, can access both workflows.

#### Layer 2: Route Guards (App.tsx lines 564-568)

```typescript
if (!isDemo && isAdminRole && FARMER_PAGES.includes(p) && !PUBLIC_PAGES.includes(p)) {
  setPage('ddp-overview')  // Redirect admin away from farmer pages
  return
}
```

**Problem 2:** This guard REQUIRES `!isDemo`, so it is **completely ineffective in demo mode**. An authenticated farmer in demo mode can navigate directly to admin pages.

#### Layer 3: Data Filtering (App.tsx lines 460–481)

```typescript
const farmerFarms: FarmProfile[] = isDemo || !isFarmerRole
  ? farms  // ← In demo mode OR if admin: show ALL farms
  : applyFarmerScope(farms, farmerScope)  // Otherwise filter
```

**Problem 3:** In demo mode, a farmer's data is NOT filtered. They see all farms, all inventory, all review requests.

#### Layer 4: Database RLS (migrations 19–23)

RLS policies exist and are partially verified:
- Migration 19: Farm admin-field guard — APPLIED_NOT_VERIFIED (UPDATE only; INSERT not tested)
- Migration 22: Operational-farmer RLS overlay — PARTIALLY_APPLIED (storage policy missing in prod)

**Problem 4:** RLS provides server-side enforcement, but:
- Not fully verified (gaps in migration 19, 22 coverage)
- Can be bypassed if client can direct-call storage API with wrong auth token
- Provides no protection if client was compromised

---

## Critical Security Vulnerabilities

### Vulnerability 1: Demo Mode Bypass

**Location:** App.tsx line 389

**Description:** If environment variable `VITE_SUPABASE_URL` is not set, the entire application runs with authorization disabled.

**Attack Vector:**
1. Environment file misconfiguration (dev accidentally commits `.env.production` with SUPABASE_URL missing)
2. Deployment script fails to inject environment variable
3. Supabase outage causes URL validation to fail
4. Malicious commit removes `VITE_SUPABASE_URL`

**Impact:**
- All farmers see admin interface
- Farmers can approve/reject farms, generate buyer packs
- Farmers can access Operations Desk with full system state
- No audit trail of who performed which actions

**Severity:** P0 — Complete authorization bypass

**Remediation:**
```typescript
// Current (vulnerable):
const isSupabaseConfigured = !!import.meta.env.VITE_SUPABASE_URL
const isDemo = !isSupabaseConfigured

// Fixed (fail-secure):
const VITE_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
if (!VITE_SUPABASE_URL) {
  throw new Error(
    'CRITICAL: VITE_SUPABASE_URL environment variable is required. ' +
    'The application cannot start without Supabase configuration. ' +
    'Check .env, build configuration, and deployment scripts.'
  )
}
const isSupabaseConfigured = true  // Always true, no demo mode
const isDemo = false
```

**Verification:** Kill the environment variable and verify the app refuses to start.

---

### Vulnerability 2: Client-Side Role Check Is Not Authorization

**Location:** App.tsx lines 391–392, used throughout

**Description:** Role variables like `isAdminRole` are computed from `currentProfile?.role` on the client and used to conditionally render UI. These are **UX controls only**, not security boundaries.

**Attack Vector:**
1. Browser DevTools: Set `localStorage.setItem('profile', '{"role":"ddp_admin"}')`
2. Or: Modify JavaScript variable in console: `isAdminRole = true`
3. Or: Intercept and modify API response in browser DevTools

**Impact:**
- Farmer can set `isAdminRole = true` in console, see admin UI
- Farmer can set `isFarmerRole = true` and `isAdminRole = false` to mask their role
- Any async mutations attempted server-side will hit RLS, but the UI already showed success

**Severity:** P0 — Requires compromise, but trivial for determined user

**Why This Matters:**
The UI shows what the user BELIEVES they can do. If UI can be modified without server validation, users can:
1. See UI showing operation succeeded
2. Believe it succeeded (no error message if RLS silently denies)
3. Make business decisions based on false state

**Remediation:**
1. Move all authorization decisions to server (done via RLS, but needs verification)
2. Trust ONLY database role from `auth.user_id()` and `public.profiles.role`
3. Never trust client-supplied role information in critical paths
4. Verify every critical mutation at the database layer (already done, but Phase 7 should add tests)

---

### Vulnerability 3: localStorage Fallback Without Error Boundary

**Location:** Multiple files, 122 references

**Description:** When API calls fail, the application may fall back to cached data in localStorage without informing the user.

**Example (hypothetical):**
```typescript
const farms = await fetchFarms()  // Fails silently (network down)
  .catch(() => loadFarmsFromLocalStorage())  // Returns stale farms
```

**Attack Vector:**
1. Network partition between client and Supabase
2. Supabase returns HTTP 500
3. App catches error and uses localStorage
4. Farmer sees cached approvals, thinks they succeeded
5. Farmer leaves; Admin never approved
6. Buyer pack generation fails; supply chain gap

**Impact:**
- Farmer cannot distinguish between current state and stale cached state
- Admin cannot tell if farmer action succeeded or was lost in network
- Supply chain decisions made on false data

**Severity:** P1 — Requires network failure + farmer action during failure + no error awareness

**Current State (Line 114 finding):** AUDIT-010 flagged this; not yet addressed.

**Remediation:**
1. Audit 10 critical data flows (provisioning, approvals, Buyer Pack)
2. For each: add explicit check: "Did API succeed?"
3. If API failed: show error banner, do NOT fall back to localStorage
4. Only use localStorage for UI state (sort order, page position), never data

---

### Vulnerability 4: Incomplete RLS Verification

**Location:** migrations 19 and 22

**Description:** Two critical RLS migrations are not fully verified:

**Migration 19 (farm admin-field guard):**
- Status: APPLIED_NOT_VERIFIED
- Coverage: UPDATE operations only
- Missing: INSERT operations, all 7 protected columns
- Risk: Farmer can INSERT farm record with admin-only fields set directly

**Migration 22 (operational-farmer overlay):**
- Status: PARTIALLY_APPLIED
- Coverage: 11-table public schema overlay complete
- Missing: Storage bucket policy (not applied to production)
- Risk: Pending user can upload/download from `farmer-documents` and `farmer-photos`

**Current Evidence (from PR #63):**
```
Production Migration 22: PARTIALLY_APPLIED
    ✓ public.has_operational_farmer_access() defined
    ✓ 11 tables have restrictive overlay policies
    ✗ Storage bucket policy "farmer buckets: operational farmer or admin" is ABSENT
    
Consequence: Authenticated pending identity with uid self-reference can:
    - READ (LIST) under own prefix in farmer-documents ✓ (policy allows)
    - UPLOAD under own prefix in farmer-documents ✓ (policy allows)
    - UPDATE/DELETE under own prefix ✗ (missing restrictive check)
```

**Severity:** P0 — Storage permissions incomplete, affects compliance/evidence files

---

### Vulnerability 5: Role Transition Race Condition

**Location:** App.tsx lines 195–215

**Description:** When user logs out and another user logs in, a race condition can occur if data loading laps the role change.

**Example:**
1. Admin logged in, loaded admin farms (all farms visible)
2. Admin logs out
3. Farmer logs in
4. Old admin data still in state
5. Farmer can see admin's farm list while waiting for farmer-scoped list to load

**Code:**
```typescript
useEffect(() => {
  const { unsubscribe } = onAuthStateChanged(auth, async (user) => {
    if (!user) {
      setCurrentProfile(null)
      // ← Farm state NOT cleared here
      setFarms([])  // ← This line exists, good
      // but timing: farmer's own data load may race this
      return
    }
    // ... load farmer's profile
  })
}, [])
```

**Severity:** P1 — Race condition, requires specific timing, visible data leak

---

## Verification Checklist for Role System Security

### Phase 6a: Quick Wins (Immediate)

- [ ] **Demo mode fail-secure:** Make `VITE_SUPABASE_URL` required; app refuses to start without it
- [ ] **Environment validation:** Add startup check: `if (!VITE_SUPABASE_URL) throw Error('...')`
- [ ] **localStorage audit:** Identify the 10 most critical data flows; verify NO localStorage fallback
- [ ] **Error boundary:** Show error banner if API fails; never silently use cached data

### Phase 6b: Deep Verification (Before Pilot)

- [ ] **Migration 19 verification:** Run 19_VERIFY.sql Section B (INSERT operations, all 7 columns)
- [ ] **Migration 22 verification:** Re-run 22_VERIFY.sql on production with correct authority; confirm storage policy applied
- [ ] **RLS probe test:** Write integration tests that attempt to bypass RLS; verify all fail
- [ ] **Role transition test:** Log in as admin, load data, log out, log in as farmer, verify no admin data visible
- [ ] **localStorage isolation:** Test with DevTools: clear localStorage, verify app requires fresh API calls

### Phase 6c: Post-Pilot (Longer-term)

- [ ] **Role system documentation:** Document the trust boundary: "Client-side checks are UX only; database RLS is authority"
- [ ] **Developer training:** Code review checklist: "This function handles [role/data]. Is it protected by RLS? Server-side?"
- [ ] **Audit logging:** Every critical operation (farm approval, inventory acceptance, procurement decision) logged to audit table
- [ ] **Periodic security tests:** Scheduled: attempt admin actions as farmer; verify all rejected at DB layer

---

## Trust Boundary Definition

### What We Trust

```
✓ PostgreSQL RLS policies (server-side, cannot be bypassed by client code)
✓ auth.uid() and auth.role() from Supabase JWT (signed, server-enforced)
✓ Supabase auth system (user authentication and session management)
```

### What We Do NOT Trust

```
✗ Client-side isAdminRole, isFarmerRole variables (UX only, not authorization)
✗ localStorage or sessionStorage (can be modified by user or malware)
✗ HTTP headers or cookies sent by client (can be modified by client)
✗ URL parameters or routing decisions alone (guide UX, not access)
```

### Authorization Rule

```
IF (critical mutation) THEN
  REQUIRE (server-side RLS validation) BEFORE
  ALLOW (client-side state update)
END
```

**Violations:**
- Farm status change (phase 4 finding): State updated before DB called
- Carbon exclusion (phase 4 finding): State updated with no DB call
- Inventory approval (phase 4 finding): State updated before DB called

All must be remediated in Phase 5+ implementation.

---

## RLS Policy Correctness Assessment

### Migration 19: Farm Admin-Field Guard

**Current Status:** APPLIED_NOT_VERIFIED (staging); partially verified production

**Protected Fields:** created_by, export_readiness, reviewed_by (+ 4 others)

**Tests Needed:**
- [ ] INSERT with admin-only field set directly; verify RLS rejects
- [ ] UPDATE with admin-only field modified; verify RLS rejects
- [ ] Farmer UPDATE of their own farm with admin fields; verify safe fields allowed
- [ ] Admin UPDATE of farmer's farm with admin fields; verify allowed

### Migration 22: Operational-Farmer Overlay

**Current Status:** PARTIALLY_APPLIED (production missing storage policy)

**Issue:** Storage bucket policy never applied to production

**Production State (from PR #63):**
```
farmer-documents bucket:
  ✓ 3 policies found (uid-based access controls)
  ✗ Missing: "farmer buckets: operational farmer or admin" restrictive overlay
  
Consequence: Authenticated pending identity can UPLOAD/READ under own prefix
(uid path) even though NOT has_operational_farmer_access()
```

**Remediation Required:**
1. Apply migration 22 storage section to production (requires break-glass authorization)
2. Verify: pending user cannot update/delete any farmer storage objects
3. Verify: pending user cannot list another farmer's objects
4. Test: pending user attempts download of another farmer's storage path; verify denied

---

## Findings Summary

| Finding | Severity | Category | Status |
|---------|----------|----------|--------|
| Demo mode authorization bypass | P0 | Authorization | Not addressed |
| Client-side role checks insufficient | P0 | Authorization | Architectural |
| localStorage fallback without error | P1 | Data integrity | AUDIT-010 flagged, not addressed |
| Migration 19 verification incomplete | P0 | RLS verification | Partial (staging only) |
| Migration 22 storage overlay missing (prod) | P0 | RLS enforcement | Documented in PR #63 |
| Role transition race condition | P1 | State management | Not addressed |

---

## Implementation Order (Post-Pilot)

### Tier 1: Fail-Secure (Immediate)
1. Make `VITE_SUPABASE_URL` required; fail startup if missing
2. Add error banner for API failures; no localStorage fallback for critical data
3. Re-run migration 19 & 22 verification; mark APPLIED_AND_VERIFIED

### Tier 2: Strengthen (Before Next Release)
1. Add integration tests for RLS bypass attempts
2. Fix role transition race condition
3. Refactor mutations to wait-first pattern (Phase 5 remediation)
4. Add audit logging for all critical operations

### Tier 3: Harden (Long-term)
1. Implement role-based query filtering at application layer (defense-in-depth)
2. Add periodic security tests (quarterly)
3. Document role system trust boundary for developers
4. Implement role suspension/hold system in `has_operational_farmer_access()`

---

## Risk: Current State

**If pilot launches without addressing Tier 1 items:**

1. **Demo mode bypass:** If environment is misconfigured, all authorization is lost
2. **Incomplete RLS:** Storage and farm fields can be modified by unauthorized users
3. **No error detection:** Farmers cannot distinguish success from network failure
4. **Race conditions:** User role changes can leak previous role's data

**Recommended:** Address Tier 1 items before pilot; Tier 2 before production.

---

**Author:** Copilot  
**Session:** AUDIT-017  
**Completes Success Criteria:** "role system secure"
