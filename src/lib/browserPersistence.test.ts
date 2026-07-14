import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  shouldPersistToBrowser,
  clearSensitiveDdpStorage,
  safeSetItem,
  SENSITIVE_DDP_KEYS,
} from './browserPersistence'

// ─── In-memory storage double ───────────────────────────────────────────────
function makeStore(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v },
    removeItem: (k: string) => { delete data[k] },
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

// ─── Supabase mode must not persist to the browser ──────────────────────────
//
// The defect: persistInventory/persistFarms were write-through on every React
// state change with no environment check, so in production the ENTIRE fetched
// inventory and farm dataset was mirrored into localStorage. The read path was
// already guarded (data.ts returns [] when Supabase is configured), so those
// copies were never read — they were pure leak.
describe('shouldPersistToBrowser — the browser is a store only in demo mode', () => {
  it('DEMO mode (no Supabase): persists — localStorage IS the database', () => {
    expect(shouldPersistToBrowser(false)).toBe(true)
  })

  it('SUPABASE mode: does NOT persist — the database is the system of record', () => {
    expect(shouldPersistToBrowser(true)).toBe(false)
  })
})

// ─── Sign-out must clear sensitive keys, and ONLY those ──────────────────────
describe('clearSensitiveDdpStorage', () => {
  it('removes every sensitive DDP key', () => {
    const seed = Object.fromEntries(SENSITIVE_DDP_KEYS.map(k => [k, 'secret-production-data']))
    const store = makeStore(seed)

    clearSensitiveDdpStorage([store])

    for (const key of SENSITIVE_DDP_KEYS) {
      expect(store.getItem(key), `${key} must be cleared on sign-out`).toBeNull()
    }
  })

  it('leaves UNRELATED keys intact — it is an allowlist, not localStorage.clear()', () => {
    const store = makeStore({
      ddp_inventory: 'production batches',
      ddp_procurement_decisions: 'release decisions',
      'theme': 'dark',                       // user preference — must survive
      'i18nextLng': 'th',                    // language choice — must survive
      'some_other_app_token': 'not ours',    // another app on this origin — must survive
    })

    clearSensitiveDdpStorage([store])

    expect(store.getItem('ddp_inventory')).toBeNull()
    expect(store.getItem('ddp_procurement_decisions')).toBeNull()
    expect(store.getItem('theme')).toBe('dark')
    expect(store.getItem('i18nextLng')).toBe('th')
    expect(store.getItem('some_other_app_token')).toBe('not ours')
  })

  it('clears BOTH local and session storage', () => {
    const local = makeStore({ ddp_farms: 'x' })
    const session = makeStore({ ddp_farms: 'x' })

    clearSensitiveDdpStorage([local, session])

    expect(local.getItem('ddp_farms')).toBeNull()
    expect(session.getItem('ddp_farms')).toBeNull()
  })

  it('one failing removal does not abort the sweep — the rest are still cleared', () => {
    const store = makeStore(Object.fromEntries(SENSITIVE_DDP_KEYS.map(k => [k, 'x'])))
    const realRemove = store.removeItem
    store.removeItem = (k: string) => {
      if (k === 'ddp_inventory') throw new Error('storage blocked')
      realRemove(k)
    }

    expect(() => clearSensitiveDdpStorage([store])).not.toThrow()

    // Every OTHER sensitive key was still removed.
    for (const key of SENSITIVE_DDP_KEYS.filter(k => k !== 'ddp_inventory')) {
      expect(store.getItem(key), `${key} must still be cleared`).toBeNull()
    }
  })

  it('covers the release-decision and buyer-pack evidence keys explicitly', () => {
    // These are the highest-consequence keys: who authorised release of a
    // controlled-substance batch, and the buyer-pack evidence issued off it.
    expect(SENSITIVE_DDP_KEYS).toContain('ddp_procurement_decisions')
    expect(SENSITIVE_DDP_KEYS).toContain('ddp_buyer_pack_snapshots')
    expect(SENSITIVE_DDP_KEYS).toContain('ddp_buyer_pack_audit_trail')
    expect(SENSITIVE_DDP_KEYS).toContain('ddp_inventory')
    expect(SENSITIVE_DDP_KEYS).toContain('ddp_farms')
  })
})

// ─── Storage failures must not crash the app, and must not lie ──────────────
describe('safeSetItem', () => {
  it('writes and reports true on success', () => {
    const store = makeStore()
    expect(safeSetItem('ddp_inventory', '[]', store)).toBe(true)
    expect(store.getItem('ddp_inventory')).toBe('[]')
  })

  it('a QuotaExceededError does NOT throw — it would blank the UI (no error boundary exists)', () => {
    const store = makeStore()
    store.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }

    expect(() => safeSetItem('ddp_inventory', 'x'.repeat(1000), store)).not.toThrow()
  })

  it('reports FALSE when the write failed — it never claims a success it did not achieve', () => {
    const store = makeStore()
    store.setItem = () => { throw new Error('storage disabled') }

    expect(safeSetItem('ddp_inventory', '[]', store)).toBe(false)
    expect(store.getItem('ddp_inventory')).toBeNull()  // and nothing was written
  })

  it('does not leak the value into the error path', () => {
    const store = makeStore()
    let seen: unknown = null
    store.setItem = (_k, v) => { seen = v; throw new Error('boom') }

    expect(safeSetItem('ddp_inventory', 'SENSITIVE', store)).toBe(false)
    // The value reached the storage call (as it must) but the failure is reported
    // as a boolean — no throw, no console dump of the payload.
    expect(seen).toBe('SENSITIVE')
    expect(store.getItem('ddp_inventory')).toBeNull()
  })
})
