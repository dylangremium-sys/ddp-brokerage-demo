# Mutation Truthfulness Audit — Critical Findings (AUDIT-015)

**Date:** 2026-07-26  
**Scope:** Business-sensitive mutations (farm approval/rejection, inventory approval/rejection, role changes, procurement decisions)  
**Risk:** UI shows successful state while database rejected the mutation

---

## Summary

**Critical Issue Found:** Optimistic state updates without rollback on DB failure.

Pattern identified in `src/App.tsx` lines 742–745:
```typescript
// 1. UI STATE CHANGES IMMEDIATELY
setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))

// 2. DB REQUEST SENT (asynchronous)
updateFarmProfileStatus(...).catch(onDbError)

// 3. NAVIGATION HAPPENS AFTER STATE UPDATE
goTo('ddp-farms')
```

**Problem:** If DB request fails:
- UI already shows the new status (line 742 committed the state)
- User sees a "success" UI state
- Error is caught and shown in UI, but state is not rolled back
- User navigates away, believing the action succeeded
- Database never received the change

This violates **mutation truthfulness**: the UI must never show a state that the database doesn't have.

---

## Critical Mutations Affected

### 1. Farm Status Changes (Line 742–745)

**Handler:** `onFarmStatusAction` (called via DDPFarmCard component)

**Mutation:** Change farm status (watchlist, strategic, active, reject)

**Current behavior (UNSAFE):**
```typescript
setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))  // SYNCHRONOUS
updateFarmProfileStatus(farmId, newStatus, oldStatus, currentProfile?.id).catch(onDbError)  // ASYNC, no rollback
goTo('ddp-farms')  // NAVIGATION HAPPENS
```

**Audit result:** ❌ FAILS — optimistic update, no rollback on error

**Remediation:**
```typescript
// Option 1: Wait for DB before updating UI
try {
  await updateFarmProfileStatus(farmId, newStatus, oldStatus, currentProfile?.id)
  setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))
} catch (err) {
  onDbError(err)
  return  // Don't navigate on failure
}
goTo('ddp-farms')

// Option 2: Optimistic with rollback
setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))
try {
  await updateFarmProfileStatus(farmId, newStatus, oldStatus, currentProfile?.id)
} catch (err) {
  setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: oldStatus } : f))  // ROLLBACK
  onDbError(err)
  return
}
goTo('ddp-farms')
```

---

### 2. Carbon Programme Exclusion (Line 748–752)

**Handler:** `handleFarmerCarbonExclude`

**Mutation:** Mark farm as excluded/withdrawn from carbon programme

**Current behavior (UNSAFE):**
```typescript
setFarms(prev => prev.map(f => f.id === farmId ? { ...f, carbonProgrammeStatus: newStatus } : f))  // SYNC
if (isSupabaseConfigured) {
  console.warn('Carbon exclusion: Production persistence requires approved SQL/RLS...')
}
// NO DB call, but state changed anyway
```

**Audit result:** ❌ FAILS — state updated without DB persistence; no error handling

**Severity:** P0 — Status is changed locally but never reaches database

**Remediation:**
```typescript
if (!isSupabaseConfigured) {
  setFarms(prev => prev.map(f => f.id === farmId ? { ...f, carbonProgrammeStatus: newStatus } : f))
  return
}

// In production, await the DB call
try {
  await updateFarmCarbonStatus(farmId, newStatus)
  setFarms(prev => prev.map(f => f.id === farmId ? { ...f, carbonProgrammeStatus: newStatus } : f))
} catch (err) {
  onDbError(err)
}
```

---

### 3. Inventory Approval/Rejection (Need to audit `InventoryBatchCard` handlers)

**Expected pattern (need to find):**
- User clicks "Approve Batch" or "Reject Batch"
- UI updates local state
- DB request sent
- On error: ???

**Action:** Find `handleInventoryApproval`, `handleInventoryRejection` handlers in App.tsx or component files.

---

### 4. Procurement Decisions (Line 181: comment references state management)

**Expected mutations:**
- "Mark as Progress" → Record procurement decision
- "Hold for Review" → Record decision as 'hold'
- "Reject Batch" → Record decision as 'reject'

**Note from code (line 181):**
> "synchronous setState is needed in the early-return branch"

This suggests awareness of the issue, but need to audit the actual implementation.

---

### 5. Role Changes (Admin changing farmer/buyer/admin roles)

**Expected mutations:**
- User goes from 'pending' → 'farmer' → 'buyer' → etc.

**Action:** Audit `handleRoleChange` in App.tsx; check for rollback pattern.

---

## Generic Error-Handling Pattern

Audit the database wrapper function `onDbError` (line 737 reference):

**Current:**
```typescript
catch (err) {
  onDbError(err)  // Sets an error message, but what state?
  return  // Early exit
}
```

**Question:** Does `onDbError` rollback state, or just show an error toast?

**Audit result:** NEEDS INVESTIGATION — find and review `onDbError` implementation.

---

## Checklist: Mutation Truthfulness

For each mutation handler, verify:

- [ ] **Error-first design:** Fail closed (don't change local state until DB confirms)
  - OR: Optimistic with rollback (change state, DB fails, roll back on error)
  
- [ ] **No orphaned state:** If DB fails, UI state matches DB state
  
- [ ] **Navigation guard:** Don't navigate to a success screen if DB failed
  
- [ ] **Error visibility:** User sees clear error message, not "Success"
  
- [ ] **Rollback timing:** If optimistic, rollback happens before user sees changed state

---

## Recommendations

### Immediate (Phase 4)

1. **Audit `onDbError`** — does it rollback state?

2. **Fix farm status changes** (line 742–745):
   - Either: make it async-first (await before setState)
   - Or: add rollback on catch

3. **Fix carbon exclusion** (line 748–752):
   - Make it genuinely async; add error handling

4. **Find & audit inventory approval/rejection** handlers

5. **Find & audit role change** handlers

6. **Find & audit procurement decision** handlers

### Deferred (Post-pilot)

1. **Create a mutation wrapper utility:**
   ```typescript
   async function mutateWithRollback<T>(
     mutation: () => Promise<T>,
     onSuccess: (result: T) => void,
     onRollback: () => void,
   ): Promise<void> {
     const previous = getCurrentState()
     try {
       const result = await mutation()
       onSuccess(result)
     } catch (err) {
       onRollback()
       throw err
     }
   }
   ```

2. **Add integration tests:**
   - Each critical mutation should have a test asserting: "if DB fails, state rolls back"

3. **Document mutation policy:**
   - All business-critical mutations (approval, rejection, role change) must be error-resilient

---

## Evidence

**File:** `src/App.tsx`

**Lines examined:**
- 742–745: Farm status change (UNSAFE — optimistic, no rollback)
- 748–752: Carbon exclusion (UNSAFE — no DB call at all in Supabase mode)
- 181: Comment hints at prior awareness ("synchronous setState needed")

**Pattern:** Synchronous state change followed by async DB call with catch-only error handling

**Risk:** UI shows successful state while database rejected the mutation

---

## Success Criteria

- [ ] All critical mutation handlers reviewed (farm approval, inventory approval, role changes, procurement decisions)
- [ ] Each handler either:
  - a) Makes DB call synchronously await-first, OR
  - b) Implements rollback on catch
- [ ] `onDbError` reviewed and confirmed to rollback state where needed
- [ ] No handlers perform navigation on error
- [ ] Tests verify rollback behavior for at least 2 critical mutations
- [ ] Carbon exclusion handler genuinely persists in Supabase mode
