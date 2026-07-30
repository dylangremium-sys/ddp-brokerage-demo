import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAuthBootstrapGuard, AUTH_BOOTSTRAP_TIMEOUT_MS } from './authBootstrapGuard'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('startAuthBootstrapGuard — the blue-screen guard', () => {
  it('fires when no auth event ever arrives', () => {
    // The reported production symptom: the app sits on "Loading…" forever because
    // setAuthLoading(false) was reachable only from the auth callback.
    const onTimeout = vi.fn()
    startAuthBootstrapGuard(onTimeout)

    vi.advanceTimersByTime(AUTH_BOOTSTRAP_TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire when auth resolves first and the guard is cancelled', () => {
    const onTimeout = vi.fn()
    const cancel = startAuthBootstrapGuard(onTimeout)

    // Auth resolved at 1s; App cancels the guard.
    vi.advanceTimersByTime(1000)
    cancel()

    vi.advanceTimersByTime(AUTH_BOOTSTRAP_TIMEOUT_MS * 10)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('fires exactly once, never repeatedly', () => {
    // A repeating timer here would re-render the app on a loop.
    const onTimeout = vi.fn()
    startAuthBootstrapGuard(onTimeout)
    vi.advanceTimersByTime(AUTH_BOOTSTRAP_TIMEOUT_MS * 5)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('cancel after firing is a no-op and does not throw', () => {
    // React runs effect cleanup on unmount regardless of whether the timer fired.
    const onTimeout = vi.fn()
    const cancel = startAuthBootstrapGuard(onTimeout)
    vi.advanceTimersByTime(AUTH_BOOTSTRAP_TIMEOUT_MS)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(() => cancel()).not.toThrow()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('cancelling twice is safe', () => {
    const onTimeout = vi.fn()
    const cancel = startAuthBootstrapGuard(onTimeout)
    cancel()
    expect(() => cancel()).not.toThrow()
    vi.advanceTimersByTime(AUTH_BOOTSTRAP_TIMEOUT_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('honours an injected timeout, so tests need not wait 8 seconds', () => {
    const onTimeout = vi.fn()
    startAuthBootstrapGuard(onTimeout, 50)
    vi.advanceTimersByTime(50)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})

describe('AUTH_BOOTSTRAP_TIMEOUT_MS', () => {
  it('matches the profile-lookup timeout in services/auth.ts', () => {
    // Both halves of the same "auth is taking too long" budget. If they drift, a
    // visitor on a slow connection can be made to sit through them back to back.
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS).toBe(8000)
  })

  it('is long enough for a slow cold start and short enough not to read as broken', () => {
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThanOrEqual(5000)
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS).toBeLessThanOrEqual(15000)
  })
})
