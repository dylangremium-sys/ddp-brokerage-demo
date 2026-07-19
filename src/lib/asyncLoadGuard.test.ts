import { describe, it, expect, vi } from 'vitest'
import { runGuardedLoad } from './asyncLoadGuard'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('runGuardedLoad — active-scope load guard', () => {
  it('applies a fresh (still-active) success', async () => {
    const d = deferred<number[]>()
    const onSuccess = vi.fn(); const onError = vi.fn()
    const p = runGuardedLoad(d.promise, () => true, { onSuccess, onError })
    d.resolve([1, 2])
    await p
    expect(onSuccess).toHaveBeenCalledWith([1, 2])
    expect(onError).not.toHaveBeenCalled()
  })

  it('a result that resolves AFTER being superseded is dropped (success path)', async () => {
    // Models: farmer load in flight → session switches to admin (active=false) →
    // the stale farmer result resolves afterward. It must not be applied.
    const d = deferred<number[]>()
    let active = true
    const onSuccess = vi.fn(); const onError = vi.fn()
    const p = runGuardedLoad(d.promise, () => active, { onSuccess, onError })
    active = false // session changed before the load settled
    d.resolve([9, 9, 9])
    await p
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('a rejection AFTER being superseded is dropped (failure path)', async () => {
    // Models: stale farmer rejection after admin success — must NOT set failed
    // or otherwise disturb the active (admin) state.
    const d = deferred<number[]>()
    let active = true
    const onSuccess = vi.fn(); const onError = vi.fn()
    const p = runGuardedLoad(d.promise, () => active, { onSuccess, onError })
    active = false
    d.reject(new Error('stale'))
    await p
    expect(onError).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('a fresh error is handled', async () => {
    const d = deferred<number[]>()
    const onSuccess = vi.fn(); const onError = vi.fn()
    const p = runGuardedLoad(d.promise, () => true, { onSuccess, onError })
    d.reject(new Error('boom'))
    await p
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('two racing loads: only the one still active when it settles applies', async () => {
    // Farmer load (becomes stale) resolves AFTER the admin load (active) applies.
    const farmer = deferred<string>()
    const admin = deferred<string>()
    let farmerActive = true
    const adminActive = true
    const applied: string[] = []
    const pFarmer = runGuardedLoad(farmer.promise, () => farmerActive, {
      onSuccess: v => applied.push(`farmer:${v}`), onError: () => {},
    })
    const pAdmin = runGuardedLoad(admin.promise, () => adminActive, {
      onSuccess: v => applied.push(`admin:${v}`), onError: () => {},
    })
    // admin settles and applies first…
    admin.resolve('all-requests')
    await pAdmin
    // …then the superseded farmer load settles and must be ignored.
    farmerActive = false
    farmer.resolve('scoped-requests')
    await pFarmer
    expect(applied).toEqual(['admin:all-requests'])
  })

  it('a Promise.all where one load rejects routes to onError (whole-batch failure)', async () => {
    // Generic runGuardedLoad contract: a rejecting inner promise reaches onError.
    // (The admin farm/inventory load uses allSettled so it can keep the good half
    // — see adminDataLoad.test.ts — but the guard's reject path is exercised here.)
    const onSuccess = vi.fn(); const onError = vi.fn()
    await runGuardedLoad(
      Promise.all([Promise.resolve(['farms']), Promise.reject(new Error('inventory failed'))]),
      () => true,
      { onSuccess, onError },
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('the still-active current load applies normally, including an empty result', async () => {
    const d = deferred<number[]>()
    const onSuccess = vi.fn()
    const p = runGuardedLoad(d.promise, () => true, { onSuccess, onError: () => {} })
    d.resolve([]) // [] must still replace prior data for the active scope
    await p
    expect(onSuccess).toHaveBeenCalledWith([])
  })
})
