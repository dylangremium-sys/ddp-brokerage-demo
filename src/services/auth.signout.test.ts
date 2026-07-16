import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SENSITIVE_DDP_KEYS } from '../lib/browserPersistence'

// ─── Sign-out cleanup must survive a failing Supabase sign-out ───────────────
//
// signOut() (services/auth.ts) clears the sensitive DDP browser keys by calling
// clearSensitiveDdpStorage() from a `finally` block, precisely so the clear still
// runs when supabase.auth.signOut() rejects (network down, session already gone).
// If that cleanup were moved out of `finally` — to a plain call after the await —
// a rejected sign-out would skip it and leave the previous operator's inventory,
// farm profiles and procurement decisions readable from devtools on a shared
// machine. The rest of the suite never exercises signOut(), so nothing guarded that
// contract; this test does.
//
// It uses the REAL clearSensitiveDdpStorage against seeded storage doubles (not a
// spy), so it proves the keys are actually gone, not merely that a function was
// called.

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: signOutMock } },
  isSupabaseConfigured: true,
}))

function makeStorageDouble(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v },
    removeItem: (k: string) => { delete data[k] },
  }
}

describe('signOut — sensitive cleanup runs even when Supabase sign-out fails', () => {
  let local: ReturnType<typeof makeStorageDouble>
  let session: ReturnType<typeof makeStorageDouble>

  beforeEach(() => {
    vi.clearAllMocks()
    const seed = Object.fromEntries(SENSITIVE_DDP_KEYS.map(k => [k, 'previous-operator-data']))
    local = makeStorageDouble(seed)
    session = makeStorageDouble({ ...seed })
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
  })

  it('clears every sensitive key from local AND session storage when signOut() rejects', async () => {
    signOutMock.mockRejectedValueOnce(new Error('network-down'))
    const { signOut } = await import('./auth')

    // An UNRELATED, non-DDP key (a user preference / another app on this origin).
    // Sign-out is an allowlist sweep, not a blanket clear, so it must SURVIVE — even
    // on the failure path. Seeded into both storages alongside the sensitive keys.
    const UNRELATED = 'theme'
    local.setItem(UNRELATED, 'dark')
    session.setItem(UNRELATED, 'dark')

    // Precondition: the keys are actually present, so the post-assertions are not
    // vacuously true against empty storage.
    for (const k of SENSITIVE_DDP_KEYS) {
      expect(local.getItem(k), `${k} should be seeded before sign-out`).not.toBeNull()
      expect(session.getItem(k), `${k} should be seeded before sign-out`).not.toBeNull()
    }

    // signOut() re-propagates the Supabase failure; the contract under test is only
    // that cleanup still happened, so tolerate whatever the promise settles to.
    await signOut().catch(() => {})

    // The failing Supabase call was actually made (we exercised the failure path)…
    expect(signOutMock).toHaveBeenCalledTimes(1)
    // …and every sensitive key is gone from BOTH storages regardless.
    for (const k of SENSITIVE_DDP_KEYS) {
      expect(local.getItem(k), `${k} must be cleared from localStorage on failed sign-out`).toBeNull()
      expect(session.getItem(k), `${k} must be cleared from sessionStorage on failed sign-out`).toBeNull()
    }
    // …while the unrelated key is untouched in BOTH storages.
    expect(local.getItem(UNRELATED), 'unrelated localStorage key must survive sign-out').toBe('dark')
    expect(session.getItem(UNRELATED), 'unrelated sessionStorage key must survive sign-out').toBe('dark')
  })

  it('also clears sensitive keys on a successful sign-out (baseline)', async () => {
    signOutMock.mockResolvedValueOnce({ error: null })
    const { signOut } = await import('./auth')

    await signOut()

    expect(signOutMock).toHaveBeenCalledTimes(1)
    for (const k of SENSITIVE_DDP_KEYS) {
      expect(local.getItem(k)).toBeNull()
      expect(session.getItem(k)).toBeNull()
    }
  })
})
