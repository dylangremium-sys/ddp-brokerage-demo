import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAuthBootstrapGuard, AUTH_BOOTSTRAP_TIMEOUT_MS } from './authBootstrapGuard'
import { PROFILE_LOOKUP_TIMEOUT_MS } from '../services/auth'

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
  it('EXCEEDS the full two-attempt profile-lookup budget', () => {
    // THE REGRESSION THIS PINS. services/auth.ts makes TWO profile-lookup
    // attempts of PROFILE_LOOKUP_TIMEOUT_MS each. If this guard fired first it
    // would render the signed-out app while the retry was still in flight —
    // logging out an operator whose session was perfectly valid, which is the
    // exact production symptom the retry exists to fix.
    //
    // Strict `>`: equality is not enough, because the guard and the second
    // attempt would then race and the winner would be arbitrary.
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThan(PROFILE_LOOKUP_TIMEOUT_MS * 2)
  })

  it('leaves real headroom, not a single millisecond', () => {
    // Enough slack for the auth event itself, JS parsing and the render before
    // the first attempt even starts.
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS - PROFILE_LOOKUP_TIMEOUT_MS * 2).toBeGreaterThanOrEqual(2000)
  })

  it('is long enough for a slow cold start and short enough not to read as broken', () => {
    // A blue screen is what the visitor actually experiences while this runs, so
    // the ceiling matters as much as the floor.
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThanOrEqual(5000)
    expect(AUTH_BOOTSTRAP_TIMEOUT_MS).toBeLessThanOrEqual(15000)
  })
})

describe('PROFILE_LOOKUP_TIMEOUT_MS', () => {
  it('is short enough that two attempts beat one long wait', () => {
    // The point of halving it was to fit a retry into the SAME worst case the
    // single 8s attempt used to occupy.
    expect(PROFILE_LOOKUP_TIMEOUT_MS * 2).toBeLessThanOrEqual(8000)
  })

  it('is long enough for a normal query on a poor connection', () => {
    expect(PROFILE_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(3000)
  })
})
