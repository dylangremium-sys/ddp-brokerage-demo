import { describe, it, expect } from 'vitest'
import type { Page } from '../../types'
import { contentVariantClass } from './adminPresentation'

/**
 * Guards the gutter regression: AdminShell routes every admin page through
 * `.eo-content`, which has no padding of its own. Only the redesigned Overview
 * carries `.eo-page` padding, so the remaining admin routes — which start at
 * `.page-wrap` (width, no padding) — rendered flush against the shell edges.
 */

/** Every admin route in the router, from App.tsx DDP_PAGES. */
const DDP_PAGES: Page[] = [
  'ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review',
  'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence',
  'ddp-risk-register', 'ddp-compliance-watchtower',
]

describe('contentVariantClass — Overview is not double-padded', () => {
  it('gives the Overview the canvas variant only', () => {
    expect(contentVariantClass('ddp-overview')).toBe('eo-content-canvas')
  })

  it('never gives the Overview the legacy gutter — .eo-page already pads it', () => {
    expect(contentVariantClass('ddp-overview')).not.toBe('eo-content-legacy')
  })
})

describe('contentVariantClass — legacy admin pages regain their gutter', () => {
  const legacyPages = DDP_PAGES.filter(p => p !== 'ddp-overview')

  it('gives every non-Overview admin route the legacy gutter', () => {
    for (const page of legacyPages) {
      expect(contentVariantClass(page)).toBe('eo-content-legacy')
    }
  })

  it('covers the pages named in the review', () => {
    // Farm Profiles, Supply Ledger / Master Inventory, Inventory Review,
    // Compliance Watchtower, Buyer Pack Preview.
    for (const page of ['ddp-farms', 'ddp-master', 'ddp-inventory', 'ddp-compliance-watchtower', 'ddp-buyer'] as Page[]) {
      expect(contentVariantClass(page)).toBe('eo-content-legacy')
    }
  })

  it('covers handler-routed review pages too', () => {
    expect(contentVariantClass('ddp-farm-review')).toBe('eo-content-legacy')
    expect(contentVariantClass('ddp-inventory-review')).toBe('eo-content-legacy')
  })

  it('assigns exactly one variant per route — never both, never neither', () => {
    for (const page of DDP_PAGES) {
      const c = contentVariantClass(page)
      expect(['eo-content-canvas', 'eo-content-legacy']).toContain(c)
    }
  })
})
