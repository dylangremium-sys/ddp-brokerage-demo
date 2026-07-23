import { describe, it, expect } from 'vitest'
import {
  EVIDENCE_REQUEST_PAGE_IDS,
  adminEvidenceRequestCreateRoute,
  adminEvidenceRequestDetailRoute,
  adminEvidenceRequestsRoute,
  evidenceLoadScopeKey,
  farmerEvidenceRequestDetailRoute,
} from './evidenceRequestRoutes'

/**
 * Route payload contract (v1.5 §10.1) and the stale-load / account-switch
 * scoping rule (§9.7).
 */


/**
 * Source text is read with Vite's `?raw` glob rather than node:fs — the repo
 * convention (see operationsDeskRouting.test.ts), and the reason `src` compiles
 * without node type definitions.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const TYPES = raw(import.meta.glob('../types.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const APP = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('canonical page IDs (§10.1)', () => {
  it('defines the four new logical pages', () => {
    expect([...EVIDENCE_REQUEST_PAGE_IDS]).toEqual([
      'admin-evidence-requests',
      'admin-evidence-request-create',
      'admin-evidence-request-detail',
      'farmer-evidence-request-detail',
    ])
  })

  it.each(EVIDENCE_REQUEST_PAGE_IDS)('registers %s in the central Page union', pageId => {
    expect(TYPES).toContain(`'${pageId}'`)
  })

  it('reuses the PRE-EXISTING farmer-requests page as the fifth canonical ID', () => {
    // §10.5 puts the farmer evidence tabs on the existing page rather than
    // introducing a parallel one.
    expect(TYPES).toContain("'farmer-requests'")
  })

  it('introduces no routing library (§19.27)', () => {
    for (const forbidden of ['react-router', 'wouter', 'createBrowserRouter', '@tanstack/router']) {
      expect(APP).not.toContain(forbidden)
    }
  })

  it('files the admin pages as DDP pages and the farmer detail as a farmer page', () => {
    const ddpPages = APP.match(/const DDP_PAGES: Page\[\] = \[[\s\S]*?\]/)?.[0] ?? ''
    const farmerPages = APP.match(/const FARMER_PAGES: Page\[\] = \[[\s\S]*?\]/)?.[0] ?? ''
    expect(ddpPages).toContain("'admin-evidence-requests'")
    expect(ddpPages).toContain("'admin-evidence-request-create'")
    expect(ddpPages).toContain("'admin-evidence-request-detail'")
    expect(farmerPages).toContain("'farmer-evidence-request-detail'")
    // An admin page must never be classified as a farmer page: goTo() redirects
    // admins away from farmer pages, which would make the desk route unreachable.
    expect(farmerPages).not.toContain("'admin-evidence-request-detail'")
  })
})

describe('route constructors validate rather than throw (§10.1)', () => {
  it('builds the plain list route', () => {
    expect(adminEvidenceRequestsRoute()).toEqual({ page: 'admin-evidence-requests' })
  })

  it('builds a detail route from a request id', () => {
    const result = adminEvidenceRequestDetailRoute('req-1')
    expect(result).toEqual({
      ok: true,
      data: { page: 'admin-evidence-request-detail', requestId: 'req-1' },
    })
  })

  it('trims surrounding whitespace from a request id', () => {
    const result = adminEvidenceRequestDetailRoute('  req-1  ')
    expect(result.ok && result.data.requestId).toBe('req-1')
  })

  it.each(['', '   ', '\n\t'])('refuses the blank request id %j', blank => {
    const admin = adminEvidenceRequestDetailRoute(blank)
    const farmer = farmerEvidenceRequestDetailRoute(blank)
    expect(admin.ok).toBe(false)
    expect(farmer.ok).toBe(false)
    expect(admin.ok === false && admin.error.code).toBe('VALIDATION_ERROR')
    expect(admin.ok === false && admin.error.field).toBe('requestId')
  })

  it('builds a blank create route when no target is preselected', () => {
    const result = adminEvidenceRequestCreateRoute()
    expect(result).toEqual({ ok: true, data: { page: 'admin-evidence-request-create' } })
  })

  it('builds a preselected create route from Farm Review (§10.7)', () => {
    const result = adminEvidenceRequestCreateRoute('farm_profile', 'fp-1')
    expect(result).toEqual({
      ok: true,
      data: { page: 'admin-evidence-request-create', targetType: 'farm_profile', targetId: 'fp-1' },
    })
  })

  it('builds a preselected create route from Inventory Review (§10.8)', () => {
    const result = adminEvidenceRequestCreateRoute('inventory_batch', 'batch-1')
    expect(result.ok && result.data.targetType).toBe('inventory_batch')
  })

  it('refuses a half-specified target rather than silently dropping it', () => {
    expect(adminEvidenceRequestCreateRoute('farm_profile', undefined).ok).toBe(false)
    expect(adminEvidenceRequestCreateRoute('farm_profile', '   ').ok).toBe(false)
    expect(adminEvidenceRequestCreateRoute(undefined, 'fp-1').ok).toBe(false)
  })
})

describe('load scope key (§9.7)', () => {
  const base = {
    userId: 'user-a',
    role: 'farmer',
    route: { page: 'farmer-evidence-request-detail', requestId: 'req-1' } as const,
  }

  it('is stable for an unchanged scope', () => {
    expect(evidenceLoadScopeKey(base)).toBe(evidenceLoadScopeKey({ ...base }))
  })

  it('changes when the ACCOUNT changes — farmer A and farmer B never share a key', () => {
    expect(evidenceLoadScopeKey(base)).not.toBe(
      evidenceLoadScopeKey({ ...base, userId: 'user-b' }),
    )
  })

  it('changes when the ROLE changes', () => {
    expect(evidenceLoadScopeKey(base)).not.toBe(
      evidenceLoadScopeKey({ ...base, role: 'ddp_admin' }),
    )
  })

  it('changes when the ROUTE changes', () => {
    expect(evidenceLoadScopeKey(base)).not.toBe(
      evidenceLoadScopeKey({ ...base, route: { page: 'admin-evidence-requests' } }),
    )
  })

  it('changes when the REQUEST ID changes', () => {
    expect(evidenceLoadScopeKey(base)).not.toBe(
      evidenceLoadScopeKey({
        ...base,
        route: { page: 'farmer-evidence-request-detail', requestId: 'req-2' },
      }),
    )
  })

  it('changes when the FILTER changes', () => {
    expect(evidenceLoadScopeKey({ ...base, filterKey: 'active' })).not.toBe(
      evidenceLoadScopeKey({ ...base, filterKey: 'closed' }),
    )
  })

  it('gives a signed-out scope a key that can never match a signed-in one', () => {
    const anonymous = evidenceLoadScopeKey({ ...base, userId: null, role: null })
    expect(anonymous).not.toBe(evidenceLoadScopeKey(base))
    expect(anonymous).toContain('<anonymous>')
  })

  it('distinguishes a preselected create target from a blank one', () => {
    const blank = evidenceLoadScopeKey({
      userId: 'admin',
      role: 'ddp_admin',
      route: { page: 'admin-evidence-request-create' },
    })
    const preselected = evidenceLoadScopeKey({
      userId: 'admin',
      role: 'ddp_admin',
      route: { page: 'admin-evidence-request-create', targetType: 'farm_profile', targetId: 'fp-1' },
    })
    expect(blank).not.toBe(preselected)
  })

  it('does not collide across differently-shaped scopes', () => {
    const keys = new Set([
      evidenceLoadScopeKey({ userId: 'a', role: 'farmer', route: { page: 'farmer-requests' } }),
      evidenceLoadScopeKey({ userId: 'a', role: 'ddp_admin', route: { page: 'farmer-requests' } }),
      evidenceLoadScopeKey({ userId: 'b', role: 'farmer', route: { page: 'farmer-requests' } }),
      evidenceLoadScopeKey({
        userId: 'a',
        role: 'farmer',
        route: { page: 'farmer-evidence-request-detail', requestId: 'r1' },
      }),
    ])
    expect(keys.size).toBe(4)
  })
})
