import { describe, it, expect } from 'vitest'
import { deriveCountMeasure, derivePanelMode, formatCountMeasure, type SourceLoadState } from './overviewViewState'

/**
 * Session boundary for the admin data reads.
 *
 * The defect: when an admin signed out and another signed in without reloading
 * the SPA, the new reads started while farmsLoadState / inventoryLoadState could
 * still be 'loaded' from the previous identity and the row arrays were retained.
 * Until the new reads settled the Overview presented the previous snapshot as
 * authoritative — and if a read then failed, it had already exposed those
 * actionable rows.
 *
 * Mirrors App.tsx: the authenticated user id is the boundary, and the reset runs
 * during render, before the reads are launched.
 */

interface Session {
  loadedFor: string | null
  farmsLoadState: SourceLoadState
  inventoryLoadState: SourceLoadState
  complianceLoadState: SourceLoadState
  farms: string[]
  inventory: string[]
}

const session = (o: Partial<Session> = {}): Session => ({
  loadedFor: 'admin-a',
  farmsLoadState: 'loaded',
  inventoryLoadState: 'loaded',
  complianceLoadState: 'loaded',
  farms: ['farm-a1', 'farm-a2'],
  inventory: ['batch-a1'],
  ...o,
})

/** App.tsx's render-time reset, verbatim in shape. */
function applySessionBoundary(s: Session, identity: string | null): Session {
  if (identity === s.loadedFor) return s
  return {
    loadedFor: identity,
    farmsLoadState: 'idle',
    inventoryLoadState: 'idle',
    complianceLoadState: 'idle',
    farms: [],
    inventory: [],
  }
}

describe('admin identity change resets the source states', () => {
  it('resets every load state when a different admin signs in', () => {
    const next = applySessionBoundary(session(), 'admin-b')
    expect(next.farmsLoadState).toBe('idle')
    expect(next.inventoryLoadState).toBe('idle')
    expect(next.complianceLoadState).toBe('idle')
  })

  it('drops the previous identity’s rows', () => {
    const next = applySessionBoundary(session(), 'admin-b')
    expect(next.farms).toEqual([])
    expect(next.inventory).toEqual([])
  })

  it('resets on sign-out too, so no rows outlive the session', () => {
    const next = applySessionBoundary(session(), null)
    expect(next.farms).toEqual([])
    expect(next.inventory).toEqual([])
    expect(next.farmsLoadState).toBe('idle')
  })

  it('reset happens before the new reads — the states are idle, not loaded', () => {
    const next = applySessionBoundary(session(), 'admin-b')
    expect(next.farmsLoadState).not.toBe('loaded')
  })
})

describe('the previous session’s rows never present as current', () => {
  it('the Overview shows neutral loading, not the old snapshot', () => {
    const next = applySessionBoundary(session(), 'admin-b')
    // Supply position is driven by the inventory load state.
    expect(derivePanelMode(next.inventoryLoadState, next.inventory.length)).toBe('loading')
    // ...and never the confirmed-empty claim either.
    expect(derivePanelMode(next.inventoryLoadState, next.inventory.length)).not.toBe('empty')
  })

  it('no KPI reports a number carried over from the previous admin', () => {
    const next = applySessionBoundary(session(), 'admin-b')
    expect(formatCountMeasure(deriveCountMeasure(next.inventoryLoadState, next.inventory.length))).toBe('—')
    expect(formatCountMeasure(deriveCountMeasure(next.farmsLoadState, next.farms.length))).toBe('—')
  })

  it('a failed new-session read exposes no rows retained from the previous one', () => {
    const reset = applySessionBoundary(session(), 'admin-b')
    const failed: Session = { ...reset, inventoryLoadState: 'error' }
    // Rows were already dropped at the boundary, and error never lists them.
    expect(failed.inventory).toEqual([])
    expect(derivePanelMode(failed.inventoryLoadState, failed.inventory.length)).toBe('error')
    expect(derivePanelMode(failed.inventoryLoadState, failed.inventory.length)).not.toBe('list')
  })

  it('an independently successful source still renders for the new session', () => {
    const reset = applySessionBoundary(session(), 'admin-b')
    const partial: Session = { ...reset, inventoryLoadState: 'loaded', inventory: ['batch-b1', 'batch-b2'] }
    expect(derivePanelMode(partial.inventoryLoadState, partial.inventory.length)).toBe('list')
    // Farms is still unresolved for this identity, and says so.
    expect(formatCountMeasure(deriveCountMeasure(partial.farmsLoadState, 0))).toBe('—')
  })
})

describe('the boundary does not fire when it should not', () => {
  it('same-session navigation does not clear valid data', () => {
    const s = session()
    // Navigating does not change the identity, so the boundary is a no-op —
    // asserted by object identity: nothing was reset or re-created.
    expect(applySessionBoundary(s, 'admin-a')).toBe(s)
    expect(applySessionBoundary(s, 'admin-a').farms).toEqual(['farm-a1', 'farm-a2'])
  })

  it('repeated renders within one session keep the loaded data', () => {
    let s = session()
    for (let i = 0; i < 5; i++) s = applySessionBoundary(s, 'admin-a')
    expect(s.farmsLoadState).toBe('loaded')
    expect(s.farms).toHaveLength(2)
  })

  it('demo mode has a constant identity, so its local data is never cleared', () => {
    const demo = session({ loadedFor: '__demo__' })
    expect(applySessionBoundary(demo, '__demo__')).toBe(demo)
    expect(applySessionBoundary(demo, '__demo__').inventory).toEqual(['batch-a1'])
  })
})

describe('an old request cannot commit into a newer session', () => {
  /** Mirrors the effect's `cancelled` flag, set by cleanup when identity changes. */
  function read(commit: (rows: string[]) => void) {
    let cancelled = false
    return {
      cleanup: () => { cancelled = true },
      settle: (rows: string[]) => { if (cancelled) return; commit(rows) },
    }
  }

  it('a response from the previous admin is discarded after the identity changed', () => {
    let committed: string[] | null = null
    const a = read(rows => { committed = rows })
    a.cleanup()                 // admin A signs out → effect cleanup runs
    a.settle(['farm-a1'])       // A's in-flight response lands late
    expect(committed).toBeNull()
  })

  it('the new session’s own response commits normally', () => {
    let committed: string[] | null = null
    const b = read(rows => { committed = rows })
    b.settle(['farm-b1'])
    expect(committed).toEqual(['farm-b1'])
  })

  it('a late failure from the old session cannot mark the new one errored', () => {
    let state: SourceLoadState = 'idle'
    const a = read(() => { state = 'error' })
    a.cleanup()
    a.settle([])
    expect(state).toBe('idle')
  })
})
