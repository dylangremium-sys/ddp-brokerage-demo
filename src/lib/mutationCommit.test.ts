import { describe, it, expect, vi } from 'vitest'
import { commitMutation } from './mutationCommit'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('commitMutation — DB-first mutation ordering', () => {
  it('runs onCommitted after a successful write and reports success', async () => {
    const onCommitted = vi.fn(); const onError = vi.fn()
    const ok = await commitMutation(async () => 'written', { onCommitted, onError })
    expect(ok).toBe(true)
    expect(onCommitted).toHaveBeenCalledWith('written')
    expect(onError).not.toHaveBeenCalled()
  })

  it('does NOT run onCommitted while the write is still in flight', async () => {
    // The core of the audit finding: the old code applied state synchronously,
    // so the operator saw success before the database had answered.
    const d = deferred<void>()
    const onCommitted = vi.fn(); const onError = vi.fn()
    const p = commitMutation(() => d.promise, { onCommitted, onError })
    await Promise.resolve() // let the await settle as far as it can
    expect(onCommitted).not.toHaveBeenCalled()
    d.resolve()
    await p
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('a rejected write applies NO visible change and reports the error', async () => {
    // Models: RLS rejects the farm status update. The row must not appear
    // approved, and the operator must not be navigated away as if it had been.
    const d = deferred<void>()
    const onCommitted = vi.fn(); const onError = vi.fn()
    const p = commitMutation(() => d.promise, { onCommitted, onError })
    d.reject(new Error('permission denied for table farms'))
    const ok = await p
    expect(ok).toBe(false)
    expect(onCommitted).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'permission denied for table farms',
    }))
  })

  it('catches a synchronous throw from persist, not just a rejected promise', async () => {
    const onCommitted = vi.fn(); const onError = vi.fn()
    const ok = await commitMutation(() => { throw new Error('boom') }, { onCommitted, onError })
    expect(ok).toBe(false)
    expect(onCommitted).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('does not funnel an onCommitted throw into onError', async () => {
    // A render/state bug must not be reported to the operator as a database
    // failure — that would send them chasing the wrong problem.
    const onCommitted = vi.fn(() => { throw new Error('setState blew up') })
    const onError = vi.fn()
    await expect(commitMutation(async () => undefined, { onCommitted, onError }))
      .rejects.toThrow('setState blew up')
    expect(onError).not.toHaveBeenCalled()
  })

  it('passes the resolved value through to onCommitted', async () => {
    // Used by the COA path, which needs the storage path the write returned.
    const onCommitted = vi.fn(); const onError = vi.fn()
    await commitMutation(async () => ({ storagePath: 'farm/1/coa.pdf' }), { onCommitted, onError })
    expect(onCommitted).toHaveBeenCalledWith({ storagePath: 'farm/1/coa.pdf' })
  })

  it('resolves without a write when persist is a no-op (demo mode)', async () => {
    // db.ts null-guards every write with `if (!supabase) return`, so demo mode
    // resolves immediately — the reordering must not strand demo interactions.
    const onCommitted = vi.fn(); const onError = vi.fn()
    const ok = await commitMutation(async () => undefined, { onCommitted, onError })
    expect(ok).toBe(true)
    expect(onCommitted).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('commitMutation — onBegin handler', () => {
  it('calls onBegin before persisting, and onCommitted after', async () => {
    const order: string[] = []
    const d = deferred<void>()
    const onBegin = vi.fn(() => { order.push('begin') })
    const onCommitted = vi.fn(() => { order.push('committed') })
    const onError = vi.fn()
    const p = commitMutation(() => { order.push('persist'); return d.promise }, { onBegin, onCommitted, onError })
    await Promise.resolve()
    expect(onBegin).toHaveBeenCalledOnce()
    expect(order).toEqual(['begin', 'persist'])
    d.resolve()
    await p
    expect(order).toEqual(['begin', 'persist', 'committed'])
    expect(onError).not.toHaveBeenCalled()
  })

  it('calls onBegin before persisting even when the action fails', async () => {
    const order: string[] = []
    const onBegin = vi.fn(() => { order.push('begin') })
    const onCommitted = vi.fn()
    const onError = vi.fn(() => { order.push('error') })
    await commitMutation(() => { throw new Error('fail') }, { onBegin, onCommitted, onError })
    expect(order).toEqual(['begin', 'error'])
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('works identically when onBegin is omitted (backward compat)', async () => {
    const onCommitted = vi.fn(); const onError = vi.fn()
    const ok = await commitMutation(async () => 'ok', { onCommitted, onError })
    expect(ok).toBe(true)
    expect(onCommitted).toHaveBeenCalledWith('ok')
  })
})
