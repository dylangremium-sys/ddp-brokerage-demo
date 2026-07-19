import { describe, expect, it } from 'vitest'
import { resolvePostLoginDecision } from './postLoginRouting'
import type { UserProfile } from '../services/auth'

/**
 * Operations Desk routing, access and read-only guarantees.
 *
 * This repo's vitest environment is 'node' and the include glob covers only
 * `src/**‍/*.test.ts` — there is no jsdom and .tsx is never rendered under
 * test. Route wiring and the absence of mutation controls are therefore
 * asserted against source text via `import.meta.glob(..., '?raw')`, the
 * existing convention here (see statusPendingClassMapping.test.ts and
 * watchtowerAiSummaryIntegration.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const TYPES_SRC = raw(import.meta.glob('../types.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const NAV_SRC = raw(import.meta.glob('../components/admin/AdminNav.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const SHELL_SRC = raw(import.meta.glob('../components/admin/AdminShell.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const PAGE_SRC = raw(import.meta.glob('../pages/admin/DDPOperationsDesk.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

const PAGE_ID = 'ddp-operations-desk'

describe('Operations Desk — source fixtures are readable', () => {
  it('loads every source under assertion', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
    expect(TYPES_SRC.length).toBeGreaterThan(1000)
    expect(NAV_SRC.length).toBeGreaterThan(500)
    expect(SHELL_SRC.length).toBeGreaterThan(500)
    expect(PAGE_SRC.length).toBeGreaterThan(1000)
  })
})

describe('Operations Desk — routing registration', () => {
  it('declares the page in the Page union', () => {
    expect(TYPES_SRC).toContain(`| '${PAGE_ID}'`)
  })

  it('registers the page in DDP_PAGES so a non-admin gets AccessDenied, not a blank frame', () => {
    const ddpPages = APP_SRC.match(/const DDP_PAGES: Page\[\] = \[[^\]]*\]/)?.[0] ?? ''
    expect(ddpPages).toContain(`'${PAGE_ID}'`)
  })

  it('is NOT registered as a farmer or public page', () => {
    const farmerPages = APP_SRC.match(/const FARMER_PAGES: Page\[\] = \[[\s\S]*?\]/)?.[0] ?? ''
    const publicPages = APP_SRC.match(/const PUBLIC_PAGES: Page\[\] = \[[^\]]*\]/)?.[0] ?? ''
    expect(farmerPages).not.toContain(PAGE_ID)
    expect(publicPages).not.toContain(PAGE_ID)
  })

  it('guards its render block with the same isAdminRole conjunction as every other DDP page', () => {
    // This conjunction — not DDP_PAGES membership — is the actual client guard.
    expect(APP_SRC).toContain(`page === '${PAGE_ID}' && isAdminRole`)
  })

  it('fails closed: the page is never rendered without the admin conjunction', () => {
    const renders = [...APP_SRC.matchAll(new RegExp(`page === '${PAGE_ID}'[^)\\n]*`, 'g'))].map(m => m[0])
    expect(renders.length).toBeGreaterThan(0)
    for (const render of renders) expect(render).toContain('isAdminRole')
  })

  it('adds exactly one admin navigation entry, in both nav variants', () => {
    const occurrences = NAV_SRC.split(`goTo('${PAGE_ID}')`).length - 1
    expect(occurrences).toBe(2) // topbar + sidebar
    expect(NAV_SRC).toContain('Operations Desk')
  })

  it('marks the nav entry as the current page for screen readers', () => {
    expect(NAV_SRC).toContain('isOpsDesk')
    expect(NAV_SRC).toContain(`aria-current={isOpsDesk ? 'page' : undefined}`)
  })

  it('labels the page in the admin shell breadcrumb', () => {
    expect(SHELL_SRC).toContain(`'${PAGE_ID}': 'Operations Desk'`)
  })

  it('leaves existing admin and farmer routes intact', () => {
    for (const page of [
      'ddp-overview', 'ddp-farms', 'ddp-farm-review', 'ddp-inventory', 'ddp-inventory-review',
      'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence',
      'ddp-risk-register', 'ddp-compliance-watchtower',
      'farmer-dashboard', 'farmer-onboarding', 'farmer-my-stock', 'farmer-status',
      'landing', 'login',
    ]) {
      expect(TYPES_SRC).toContain(`| '${page}'`)
      expect(APP_SRC).toContain(`'${page}'`)
    }
  })

  it('does not change the post-login routing policy', () => {
    // Role resolution and its fail-closed default are untouched by this feature.
    expect(resolvePostLoginDecision({ role: 'ddp_admin' } as UserProfile))
      .toEqual({ kind: 'route', page: 'ddp-overview' })
    expect(resolvePostLoginDecision({ role: 'farmer' } as UserProfile))
      .toEqual({ kind: 'route', page: 'farmer-dashboard' })
    expect(resolvePostLoginDecision(null)).toEqual({ kind: 'denied', reason: 'unresolved-role' })
    expect(resolvePostLoginDecision({ role: 'pending' } as unknown as UserProfile))
      .toEqual({ kind: 'denied', reason: 'unresolved-role' })
  })

  it('never routes the operator to the desk automatically — it is opt-in navigation', () => {
    expect(APP_SRC).not.toContain(`setPage('${PAGE_ID}')`)
  })
})

describe('Operations Desk — read-only guarantees', () => {
  it('exposes no mutation or persistence path', () => {
    for (const forbidden of [
      'updateFarmProfileStatus',
      'updateInventoryStatus',
      'patchInventoryBatch',
      'saveProcurementDecision',
      'recordDecision',
      'saveRequirementOverride',
      'saveRiskOverride',
      'createReviewRequest',
      'resolveReviewRequest',
      'localStorage',
      'supabase',
    ]) {
      expect(PAGE_SRC).not.toContain(forbidden)
    }
  })

  it('introduces no Buyer Pack issuance, print, download or copy path', () => {
    for (const forbidden of [
      'createBuyerPackSnapshot',
      'prepareBuyerPackSnapshotInput',
      'issue_buyer_pack_snapshot',
      'buyerPackDownloads',
      'window.print',
      'navigator.clipboard',
    ]) {
      expect(PAGE_SRC).not.toContain(forbidden)
    }
  })

  it('does not re-derive the Buyer Pack gate', () => {
    // The blocking half of that gate is private to DDPBuyerPreview; the desk
    // omits the queue rather than approximating it.
    const AGGREGATOR_SRC = raw(import.meta.glob('./operationsDesk.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    expect(AGGREGATOR_SRC).not.toContain('deriveBuyerApprovalGate')
    expect(AGGREGATOR_SRC).not.toContain('hasBlockingIssues')
    expect(AGGREGATOR_SRC).not.toContain('isHumanApproved')
    expect(PAGE_SRC).not.toContain('isHumanApproved')
  })

  it('introduces no compliance approval or rule-state mutation', () => {
    for (const forbidden of ['activateRule', 'approveRule', 'pauseRule', 'retireRule', 'rejectRule', 'saveRule']) {
      expect(PAGE_SRC).not.toContain(forbidden)
    }
  })

  it('introduces no AI call path', () => {
    // Matched against real AI module/provider markers. A bare 'summarise'
    // would collide with this feature's own summariseOperationsDeskItems,
    // which is a count, not a model call.
    for (const forbidden of [
      'complianceAiSummarisation',
      'complianceAiSummaryClient',
      'aiComplianceProvider',
      'watchtowerAiSummary',
      'serverAiSummary',
      'serverAiProvider',
      'anthropic',
      'openai',
    ]) {
      expect(PAGE_SRC.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('uses no prohibited compliance terminology', () => {
    const combined = `${PAGE_SRC} ${raw(import.meta.glob('./operationsDesk.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)}`.toLowerCase()
    for (const banned of [
      'fully compliant',
      'legally compliant',
      'approved for export',
      'export-ready',
      'verified supplier',
      'verified batch',
      'pharmaceutical approved',
      'certified pharmaceutical',
      'ready to buy',
    ]) {
      expect(combined).not.toContain(banned)
    }
  })

  it('keeps the page presentational — logic lives in the tested lib modules', () => {
    expect(PAGE_SRC).toContain("from '../../lib/operationsDesk'")
    expect(PAGE_SRC).toContain("from '../../lib/operationsDeskFilters'")
    expect(PAGE_SRC).toContain("from '../../lib/operationsDeskPriority'")
  })
})

describe('Operations Desk — accessibility and print contract', () => {
  it('uses a semantic page heading and real table semantics', () => {
    expect(PAGE_SRC).toContain('<h1')
    expect(PAGE_SRC).toContain('<table')
    expect(PAGE_SRC).toContain('scope="col"')
    expect(PAGE_SRC).toContain('<caption')
  })

  it('labels every control', () => {
    for (const id of ['ops-desk-search', 'ops-desk-category', 'ops-desk-priority']) {
      expect(PAGE_SRC).toContain(`htmlFor="${id}"`)
      expect(PAGE_SRC).toContain(`id="${id}"`)
    }
  })

  it('uses buttons rather than clickable divs for actions', () => {
    expect(PAGE_SRC).toContain('type="button"')
    expect(PAGE_SRC).not.toMatch(/<div[^>]*onClick/)
  })

  it('communicates priority with a text label, never colour alone', () => {
    expect(PAGE_SRC).toContain('PRIORITY_LABEL[item.priority]')
  })

  it('announces loading and incomplete states to screen readers', () => {
    expect(PAGE_SRC).toContain('role="status"')
  })

  it('exposes the expandable detail row state', () => {
    expect(PAGE_SRC).toContain('aria-expanded={expanded}')
    expect(PAGE_SRC).toContain('aria-controls={detailId}')
  })

  it('excludes filter chrome from print output', () => {
    expect(PAGE_SRC).toContain('ops-desk-controls no-print')
  })
})

describe('Operations Desk — mobile layout containment', () => {
  // The wide matters table must scroll inside a bounded container so the page
  // root never scrolls sideways on narrow viewports. `.ops-desk-table-scroll`
  // is that container; App.css scopes `overflow-x: auto` + `contain: paint` to
  // it (paint containment stops the scroll container's clipped overflow from
  // leaking into documentElement.scrollWidth). This repo's vitest cannot read
  // .css — `import.meta.glob('../App.css', '?raw')` yields '' — so the CSS half
  // is verified by browser acceptance; the structural half (the wrapper exists
  // and encloses the table) is guarded here against regression.
  it('wraps the matters table in a single desk-scoped scroll container', () => {
    const wrapperMarker = 'className="ops-desk-table-scroll"'
    const tableOpen = '<table className="ops-desk-table"'
    // exactly one wrapper — no accidental duplication or removal
    expect(PAGE_SRC.split(wrapperMarker).length - 1).toBe(1)
    const wrapperIdx = PAGE_SRC.indexOf(wrapperMarker)
    const tableOpenIdx = PAGE_SRC.indexOf(tableOpen)
    const tableCloseIdx = PAGE_SRC.indexOf('</table>')
    expect(wrapperIdx).toBeGreaterThan(-1)
    // the wrapper opens before the table and the table closes after it opens:
    // the table is nested inside the bounded scroll container.
    expect(tableOpenIdx).toBeGreaterThan(wrapperIdx)
    expect(tableCloseIdx).toBeGreaterThan(tableOpenIdx)
  })
})
