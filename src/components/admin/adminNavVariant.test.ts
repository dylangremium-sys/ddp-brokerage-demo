import { describe, it, expect } from 'vitest'
import type { Page } from '../../types'
import { ADMIN_NAV_TARGETS, type AdminNavVariant } from './adminPresentation'

/**
 * Which AdminNav presentation each session gets.
 *
 * Mirrors App.tsx exactly:
 *   showFarmerNav      = isDemo || isFarmerRole
 *   showDDPNav         = isAdminRole  (= isDemo || role === 'ddp_admin')
 *   useEditorialShell  = showDDPNav && !showFarmerNav
 *
 * The regression this guards: in demo mode useEditorialShell is false, so
 * AdminNav renders inside the 56px `.navbar` beside FarmerNav. Feeding it the
 * sidebar's stacked 44px rows overflowed the navbar and covered the page.
 *
 * This asserts the selection rule, not styling — the variant is the decision
 * that determines which markup ships.
 */
function session({ supabase, role }: { supabase: boolean; role?: 'ddp_admin' | 'farmer' | null }) {
  const isDemo = !supabase
  const isAdminRole = isDemo || role === 'ddp_admin'
  const isFarmerRole = !isDemo && role === 'farmer'
  const showFarmerNav = isDemo || isFarmerRole
  const showDDPNav = isAdminRole
  const useEditorialShell = showDDPNav && !showFarmerNav
  return {
    showFarmerNav,
    showDDPNav,
    useEditorialShell,
    adminNavVariant: (useEditorialShell ? 'sidebar' : 'topbar') as AdminNavVariant,
  }
}

describe('demo mode (no Supabase) keeps the compact top navbar', () => {
  const s = session({ supabase: false })

  it('does not use the editorial shell', () => {
    expect(s.useEditorialShell).toBe(false)
  })

  it('renders AdminNav as the compact topbar, never the sidebar', () => {
    expect(s.adminNavVariant).toBe('topbar')
    expect(s.adminNavVariant).not.toBe('sidebar')
  })

  it('renders AdminNav and FarmerNav together, as it did before the redesign', () => {
    expect(s.showDDPNav).toBe(true)
    expect(s.showFarmerNav).toBe(true)
  })

  it('offers the same four destinations the original navbar had', () => {
    // Compact by construction: four buttons fit a 56px navbar beside FarmerNav.
    expect(ADMIN_NAV_TARGETS.topbar).toEqual([
      'ddp-overview',
      'ddp-farms',
      'ddp-master',
      'ddp-compliance-watchtower',
    ])
  })
})

describe('signed-in Supabase admin uses the editorial sidebar', () => {
  const s = session({ supabase: true, role: 'ddp_admin' })

  it('uses the editorial shell', () => {
    expect(s.useEditorialShell).toBe(true)
  })

  it('renders AdminNav as the sidebar', () => {
    expect(s.adminNavVariant).toBe('sidebar')
  })

  it('does not render the farmer navigation beside it', () => {
    expect(s.showFarmerNav).toBe(false)
  })
})

describe('farmer navigation is unaffected', () => {
  const s = session({ supabase: true, role: 'farmer' })

  it('never shows admin navigation to a farmer', () => {
    expect(s.showDDPNav).toBe(false)
  })

  it('keeps the farmer top navbar and never the editorial shell', () => {
    expect(s.showFarmerNav).toBe(true)
    expect(s.useEditorialShell).toBe(false)
  })
})

describe('an unauthenticated Supabase session gets no admin navigation', () => {
  const s = session({ supabase: true, role: null })

  it('shows neither admin nav nor the editorial shell', () => {
    expect(s.showDDPNav).toBe(false)
    expect(s.useEditorialShell).toBe(false)
  })
})

describe('destinations', () => {
  /** Every admin route in the router, from App.tsx DDP_PAGES. */
  const DDP_PAGES: Page[] = [
    'ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review',
    'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence',
    'ddp-risk-register', 'ddp-compliance-watchtower',
  ]
  /** Reached through a handler rather than a nav button, before and after. */
  const HANDLER_ROUTED: Page[] = ['ddp-farm-review', 'ddp-inventory-review']

  it('the sidebar exposes every admin destination that is not handler-routed', () => {
    const expected = DDP_PAGES.filter(p => !HANDLER_ROUTED.includes(p))
    expect([...ADMIN_NAV_TARGETS.sidebar].sort()).toEqual([...expected].sort())
  })

  it('every variant target is a real route in the router', () => {
    for (const variant of ['sidebar', 'topbar'] as AdminNavVariant[]) {
      for (const target of ADMIN_NAV_TARGETS[variant]) {
        expect(DDP_PAGES).toContain(target)
      }
    }
  })

  it('the topbar invents no destination the sidebar lacks', () => {
    for (const target of ADMIN_NAV_TARGETS.topbar) {
      expect(ADMIN_NAV_TARGETS.sidebar).toContain(target)
    }
  })

  it('no destination is duplicated within a variant', () => {
    for (const variant of ['sidebar', 'topbar'] as AdminNavVariant[]) {
      const t = ADMIN_NAV_TARGETS[variant]
      expect(new Set(t).size).toBe(t.length)
    }
  })
})
