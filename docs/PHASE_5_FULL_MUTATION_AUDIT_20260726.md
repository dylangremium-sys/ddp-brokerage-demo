# Phase 5: Complete Mutation Truthfulness Audit (AUDIT-016)

**Date:** 2026-07-26  
**Status:** Extends Phase 4 findings with deeper investigation  
**Risk Level:** Critical (affects all business-sensitive operations)

---

## Executive Summary

Phase 4 identified 2 immediately unsafe mutations and flagged 3 for follow-up. Phase 5 extends this audit to examine the root cause pattern and quantify exposure.

**Root Cause Discovered:** The `onDbError()` helper function (line 549–553 in App.tsx) does NOT rollback state. It only logs and shows an error toast.

```typescript
function onDbError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('Supabase error:', msg)
  setDbError(msg)  // ← Shows error message ONLY; state unchanged
}
```

This enables a critical antipattern across all mutation handlers:
1. State is committed optimistically (synchronous)
2. DB request fires asynchronously
3. If DB fails, `onDbError` is called
4. User sees error toast but UI remains in "success" state
5. Subsequent navigation preserves the false state

---

## Detailed Audit Results

### Unsafe Pattern 1: Optimistic Update + Fire-and-Forget DB Call

**Location:** `src/App.tsx` line 742–745 (farm status)

```typescript
setFarms(prev => prev.map(f => f.id === farmId ? { ...f, status: newStatus } : f))
updateFarmProfileStatus(...).catch(onDbError)  // No await, no rollback
goTo('ddp-farms')
```

**Impact:** Farm status appears changed immediately; if DB call fails, UI state persists but database is unchanged.

**Severity:** P0 — Farm status is used for downstream procurement decisions

---

### Unsafe Pattern 2: Local-Only State Change

**Location:** `src/App.tsx` line 748–752 (carbon exclusion)

```typescript
setFarms(prev => prev.map(f => f.id === farmId ? { ...f, carbonProgrammeStatus: newStatus } : f))
if (isSupabaseConfigured) {
  console.warn('Carbon exclusion: Production persistence requires approved SQL/RLS...')
}
// NO DB call made
```

**Impact:** Farm carbon status changed in UI with no DB persistence attempt. In Supabase mode, the change is never saved.

**Severity:** P0 — Carbon programme status affects compliance scoring

---

### Unsafe Pattern 3: Inventory Submission

**Location:** `src/App.tsx` line 605–648 (`handleInventorySubmit`)

```typescript
// STEP 1: State updated immediately
setInventory(prev => {
  const exists = prev.some(i => i.id === item.id)
  return exists ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev]
})

// STEP 2: DB call is awaited but in try/catch
try {
  await createInventoryBatch(item, currentProfile?.id)  // ✓ Awaited
} catch (err) {
  onDbError(err)  // ✗ No rollback
  return
}

// STEP 3: Another state update (COA file metadata)
try {
  // ... upload and patch ...
  setInventory(prev => prev.map(i =>
    i.id === item.id ? { ...i, certFileName: coaFile.name, ... } : i
  ))
} catch (err) {
  onDbError(err)  // ✗ No rollback on second failure
}
```

**Issues:**
- Initial inventory creation awaits DB but doesn't rollback on failure
- COA file patch is not awaited, fires asynchronously
- If COA patch fails, inventory state shows file attached but database has no record

**Severity:** P0 — Inventory submission is the primary farmer workflow

---

### Unsafe Pattern 4: Inventory Action (Approval/Rejection)

**Location:** `src/App.tsx` line 762–775 (`handleInventoryAction`)

```typescript
// STEP 1: State changed immediately
const oldStatus = inventory.find(i => i.id === itemId)?.status
setInventory(prev => prev.map(i => i.id === itemId ? { ...i, status: newStatus } : i))

// STEP 2: DB update fired asynchronously
updateInventoryStatus(itemId, newStatus, oldStatus, currentProfile?.id).catch(onDbError)

// STEP 3: Navigation happens immediately after state change
goTo('ddp-inventory')
```

**Impact:**
- Inventory status (Approved/Rejected/Missing Document) is shown changed immediately
- If DB call fails, error toast appears but status remains in "changed" state
- User navigates away seeing approved status; database never recorded it

**Severity:** P0 — Inventory approval is critical to downstream buyer pack generation

**Verification:** Checked `updateInventoryStatus` definition; it does NOT have its own error recovery.

---

### Additional Mutations Requiring Full Investigation

The following mutations follow similar patterns but require deeper investigation:

| Handler | File | Lines | Status | Note |
|---------|------|-------|--------|------|
| `handleSendReviewRequest` | App.tsx | 671–680 | NEEDS_AUDIT | Creates review request with optimistic state; patches inventory status separately |
| `handleCoaUpload` | App.tsx | 650–669 | NEEDS_AUDIT | File upload + DB patch in sequence; patch is not awaited |
| Farm membership mutations | Unknown | TBD | NEEDS_AUDIT | No obvious handlers in App.tsx; may be in other components |
| Role changes | Unknown | TBD | NEEDS_AUDIT | Role selection/assignment logic not yet traced |
| Procurement decisions | Unknown | TBD | NEEDS_AUDIT | No mutations found in main audit scope |

---

## Root Cause Analysis

### Why `onDbError()` Cannot Roll Back

The `onDbError` function is designed as a generic error display handler. It:
- Accepts only the error (not the item ID, previous state, or state setter)
- Cannot access component state to rollback
- Is used across many unrelated mutations

To make rollback possible, error handlers would need:
1. Reference to the previous state before mutation
2. State setter function for that specific state
3. Knowledge of which state variable was mutated

---

## Remediation Strategy

### Pattern A: Wait-Then-Update (Safest)

**When to use:** Mutations where DB latency is acceptable (most operations)

```typescript
async function handleInventoryApproval(itemId: string) {
  const item = inventory.find(i => i.id === itemId)
  const oldStatus = item?.status
  
  try {
    await updateInventoryStatus(itemId, 'Approved', oldStatus, currentProfile?.id)
    // Only update UI after DB confirms success
    setInventory(prev => prev.map(i => 
      i.id === itemId ? { ...i, status: 'Approved' } : i
    ))
  } catch (err) {
    onDbError(err)
    return  // Don't navigate on failure
  }
  goTo('ddp-inventory')
}
```

**Pros:**
- UI state always matches database
- No rollback logic needed
- Clear error path prevents navigation

**Cons:**
- DB latency visible to user (acceptable for most workflows)

---

### Pattern B: Optimistic Update + Rollback (For High-Latency Concerns)

**When to use:** Rapid-fire operations where latency creates UX friction

```typescript
async function handleInventoryApproval(itemId: string) {
  const item = inventory.find(i => i.id === itemId)
  const oldStatus = item?.status ?? 'Unknown'
  
  // Update UI optimistically
  setInventory(prev => prev.map(i => 
    i.id === itemId ? { ...i, status: 'Approved' } : i
  ))
  
  try {
    await updateInventoryStatus(itemId, 'Approved', oldStatus, currentProfile?.id)
    // Success: UI already updated, just navigate
  } catch (err) {
    // ROLLBACK: Revert to old state
    setInventory(prev => prev.map(i =>
      i.id === itemId ? { ...i, status: oldStatus } : i
    ))
    onDbError(err)
    return  // Don't navigate on failure
  }
  goTo('ddp-inventory')
}
```

**Pros:**
- UI feels responsive
- User sees immediate feedback

**Cons:**
- More complex code
- Potential UI flicker if rollback happens
- Requires capturing previous state

---

### Pattern C: Hybrid for Multi-Step Operations

**When to use:** Operations with multiple DB calls (e.g., inventory + COA upload)

```typescript
async function handleInventorySubmitWithCoa(item: InventoryItem, coaFile: File | null) {
  try {
    // Step 1: Create batch (error-first pattern)
    await createInventoryBatch(item, currentProfile?.id)
    
    // Step 1 succeeded; now update UI
    setInventory(prev => {
      const exists = prev.some(i => i.id === item.id)
      return exists ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev]
    })
    
    // Step 2: Upload COA if present (optional, separate error handling)
    if (coaFile) {
      try {
        const { storagePath } = await uploadCoaFile(coaFile, ...)
        await patchInventoryBatch(item.id, { coa_file_name: coaFile.name, coa_storage_path: storagePath })
        
        // Update UI only if both upload + patch succeeded
        setInventory(prev => prev.map(i =>
          i.id === item.id ? { ...i, coaStoragePath: storagePath, ... } : i
        ))
      } catch (coaErr) {
        // COA upload failed; inventory exists but file didn't attach
        // Show specific COA error, but don't rollback batch creation
        onDbError({ coaUploadFailed: true, message: coaErr.message })
      }
    }
  } catch (batchErr) {
    // Batch creation failed; don't update UI at all
    onDbError(batchErr)
    return
  }
  goTo('ddp-inventory')
}
```

**Pros:**
- Separates independent concerns (batch creation vs COA)
- Partial success is possible and reported

**Cons:**
- Most complex pattern
- Requires careful error messaging for partial failures

---

## Mutation Wrapper Utility (Post-Pilot)

To ensure consistency across all mutations, propose a wrapper utility:

```typescript
type MutationHandler<T, U> = (item: T) => Promise<U>
type StateUpdater<T> = (fn: (prev: T) => T) => void

interface MutationOptions {
  shouldNavigate?: boolean
  targetPage?: string
  errorMessage?: string
}

async function executeOptimisticMutation<T, U>(
  item: T,
  oldState: T[],
  stateUpdater: StateUpdater<T[]>,
  handler: MutationHandler<T, U>,
  options: MutationOptions = {}
) {
  const { shouldNavigate = true, targetPage = null, errorMessage = 'Operation failed' } = options
  
  // Update UI optimistically
  stateUpdater(prev => [...prev].map(p => p.id === item.id ? item : p))
  
  try {
    // Execute DB operation
    await handler(item)
    
    // Navigate only on success
    if (shouldNavigate && targetPage) goTo(targetPage)
    return { ok: true }
  } catch (err) {
    // ROLLBACK
    stateUpdater(prev => [...prev].map(p => p.id === item.id ? oldState.find(s => s.id === item.id) : p))
    onDbError(err)
    return { ok: false, error: err }
  }
}
```

**Usage:**
```typescript
const result = await executeOptimisticMutation(
  newInventoryItem,
  oldInventory,
  setInventory,
  item => createInventoryBatch(item, currentProfile?.id),
  { shouldNavigate: true, targetPage: 'ddp-inventory' }
)
```

---

## Verification Checklist

For each mutation identified in "Additional Mutations Requiring Investigation":

- [ ] Locate handler function
- [ ] Identify state update(s)
- [ ] Identify DB call(s)
- [ ] Determine if DB call is awaited
- [ ] Check if error handler rolls back state
- [ ] Verify navigation happens AFTER error handling
- [ ] Document pattern (Pattern A/B/C or other)
- [ ] Flag severity (P0/P1/P2)
- [ ] Plan remediation

---

## Recommended Next Steps

### Immediate (Phase 5 Follow-up)

1. **High-value mutations:** Audit and fix the 4 critical patterns (farm status, carbon exclusion, inventory submit, inventory action)
2. **Complete the checklist:** Finish investigation of farm membership, role changes, procurement decisions
3. **Add rollback logic:** Implement Pattern A (wait-first) for critical paths; Pattern B for high-latency concerns

### Medium-term (Post-pilot)

1. **Create mutation wrapper:** Implement `executeOptimisticMutation` utility to standardize error handling
2. **Refactor mutations:** Migrate existing handlers to use the wrapper
3. **Add integration tests:** Test failure scenarios for each critical mutation

### Long-term

1. **Consider form library:** Evaluate react-hook-form or Formik to centralize form state + async validation
2. **Implement optimistic updates at sync layer:** Rather than component-level state, handle optimism in data fetching (e.g., via Apollo, TanStack Query)

---

## Files Modified

- `docs/PHASE_5_FULL_MUTATION_AUDIT_20260726.md` (this file)

## Files Requiring Changes (Next Phase)

- `src/App.tsx` — All handler functions identified above
- `src/data.ts` — DB mutation wrappers may need error recovery
- (New) `src/lib/mutations.ts` — Proposed utility for consistent error handling

---

## Risk Classification

| Mutation | Severity | Lives In | Impact |
|----------|----------|----------|--------|
| Farm status change | **P0** | App.tsx:742–745 | Affects downstream procurement scoring |
| Carbon exclusion | **P0** | App.tsx:748–752 | Compliance scoring, no DB persistence |
| Inventory submission | **P0** | App.tsx:605–648 | Primary farmer workflow |
| Inventory approval | **P0** | App.tsx:762–775 | Buyer pack generation gate |
| (Review request) | P1 | App.tsx:671–680 | Needs investigation |
| (COA upload) | P1 | App.tsx:650–669 | Secondary to batch creation |

---

**Author:** Copilot  
**Session:** AUDIT-016  
**Status:** Complete investigation phase; awaiting remediation implementation
