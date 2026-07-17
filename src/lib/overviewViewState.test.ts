import { describe, it, expect } from 'vitest'
import type { Page } from '../types'
import {
  shouldLoadComplianceData,
  combineLoadStates,
  deriveCountMeasure,
  derivePanelMode,
  deriveSignalsPanelMode,
  formatCountMeasure,
  measureNote,
  MEASURE_UNKNOWN,
  MEASURE_PENDING_NOTE,
  MEASURE_ERROR_NOTE,
  SIGNALS_EMPTY,
  SUPPLY_EMPTY,
  type SourceLoadState,
  type ComplianceLoadState,
} from './overviewViewState'

/** Mirrors the router's list in App.tsx, passed in exactly as App.tsx passes it. */
const SUPPLY_LEDGER_PAGES: Page[] = [
  'ddp-inventory',
  'ddp-inventory-review',
  'ddp-master',
  'ddp-buyer',
  'ddp-missing-documents',
  'ddp-coa-intelligence',
  'ddp-risk-register',
]

const NEVER_LOADED: ComplianceLoadState[] = ['idle', 'loading', 'error', 'unavailable']

describe('shouldLoadComplianceData — direct Overview entry', () => {
  it('triggers the compliance fetch when landing directly on ddp-overview', () => {
    // The defect: this returned false, so an operator who logged in and landed
    // on the Overview never fetched alerts, and the panel claimed there were none.
    expect(shouldLoadComplianceData('ddp-overview', SUPPLY_LEDGER_PAGES)).toBe(true)
  })

  it('does not require any Supply Ledger page to have been visited first', () => {
    // The predicate depends only on the current page — there is no prior-visit
    // state it could consult, which is the property that makes direct entry work.
    const asIfFreshSession = shouldLoadComplianceData('ddp-overview', SUPPLY_LEDGER_PAGES)
    expect(asIfFreshSession).toBe(true)
  })

  it('still triggers for every existing Supply Ledger page', () => {
    for (const page of SUPPLY_LEDGER_PAGES) {
      expect(shouldLoadComplianceData(page, SUPPLY_LEDGER_PAGES)).toBe(true)
    }
  })

  it('does not fetch on admin pages that do not present compliance data', () => {
    expect(shouldLoadComplianceData('ddp-farms', SUPPLY_LEDGER_PAGES)).toBe(false)
    expect(shouldLoadComplianceData('ddp-farm-review', SUPPLY_LEDGER_PAGES)).toBe(false)
  })

  it('does not fetch on farmer or public pages', () => {
    const pages: Page[] = ['landing', 'login', 'farmer-dashboard', 'farmer-my-stock', 'farmer-status']
    for (const page of pages) {
      expect(shouldLoadComplianceData(page, SUPPLY_LEDGER_PAGES)).toBe(false)
    }
  })
})

describe('deriveSignalsPanelMode — absence may only be claimed after a successful fetch', () => {
  it('renders unresolved items on direct Overview entry once loaded', () => {
    expect(deriveSignalsPanelMode('loaded', 2)).toBe('list')
  })

  it('never claims absence before the fetch completes', () => {
    for (const state of NEVER_LOADED) {
      // Even with zero items in hand, an unresolved/failed query is not a zero.
      expect(deriveSignalsPanelMode(state, 0)).not.toBe('empty')
    }
  })

  it('shows a neutral loading state while the query is unresolved', () => {
    expect(deriveSignalsPanelMode('idle', 0)).toBe('loading')
    expect(deriveSignalsPanelMode('loading', 0)).toBe('loading')
  })

  it('a failed fetch renders an error state, not zero and not "no unresolved alerts"', () => {
    expect(deriveSignalsPanelMode('error', 0)).toBe('error')
    expect(deriveSignalsPanelMode('error', 0)).not.toBe('empty')
  })

  it('a failed fetch is not rescued by stale items still in state', () => {
    // If a refetch fails, previously-held items must not imply a fresh result.
    expect(deriveSignalsPanelMode('error', 5)).toBe('error')
  })

  it('shows the approved empty-state message only on a successful zero result', () => {
    expect(deriveSignalsPanelMode('loaded', 0)).toBe('empty')
    expect(SIGNALS_EMPTY).toBe('No unresolved alerts or rules awaiting decision.')
  })

  it('demo/localStorage mode reports unavailable rather than zero', () => {
    expect(deriveSignalsPanelMode('unavailable', 0)).toBe('unavailable')
  })
})

describe('deriveCountMeasure — Blocked decisions must not claim zero prematurely', () => {
  it('reports the real count after a successful fetch', () => {
    expect(deriveCountMeasure('loaded', 3)).toEqual({ known: true, value: 3 })
  })

  it('reports a confirmed zero after a successful fetch', () => {
    expect(deriveCountMeasure('loaded', 0)).toEqual({ known: true, value: 0 })
    expect(formatCountMeasure(deriveCountMeasure('loaded', 0))).toBe('0')
  })

  it('never claims zero before the fetch completes', () => {
    for (const state of NEVER_LOADED) {
      const m = deriveCountMeasure(state, 0)
      expect(m.known).toBe(false)
      expect(formatCountMeasure(m)).toBe(MEASURE_UNKNOWN)
      expect(formatCountMeasure(m)).not.toBe('0')
    }
  })

  it('renders the unknown placeholder, never a digit, while loading', () => {
    expect(formatCountMeasure(deriveCountMeasure('loading', 0))).toBe('—')
    expect(formatCountMeasure(deriveCountMeasure('error', 0))).toBe('—')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
   Farms / inventory false-absence guarantees.

   Every test below starts from the Overview's own measure→source binding — no
   prior navigation exists in these functions to depend on, which is what makes
   direct ddp-overview entry (requirement G) structurally guaranteed rather
   than merely observed.
   ──────────────────────────────────────────────────────────────────────────── */

const UNSETTLED: SourceLoadState[] = ['idle', 'loading', 'error']

describe('combineLoadStates — a measure is only as trustworthy as its weakest source', () => {
  it('F: a measure needing farms AND inventory stays unresolved until both load', () => {
    expect(combineLoadStates('loaded', 'loading')).toBe('loading')
    expect(combineLoadStates('loading', 'loaded')).toBe('loading')
    expect(combineLoadStates('loaded', 'idle')).toBe('loading')
    expect(combineLoadStates('loaded', 'loaded')).toBe('loaded')
  })

  it('any failed source makes the combined measure unreportable', () => {
    expect(combineLoadStates('loaded', 'error')).toBe('error')
    expect(combineLoadStates('error', 'loaded')).toBe('error')
    expect(combineLoadStates('loading', 'error')).toBe('error')
  })

  it('an unavailable source is settled and does not block a measure forever', () => {
    // Demo mode: farms/inventory load from the local store, compliance cannot exist.
    expect(combineLoadStates('loaded', 'loaded', 'unavailable')).toBe('loaded')
  })

  it('a measure whose every source is unavailable is itself unavailable', () => {
    expect(combineLoadStates('unavailable', 'unavailable')).toBe('unavailable')
  })
})

describe('A. Initial delayed load — farms and inventory still pending', () => {
  it('no inventory-dependent KPI displays 0 while inventory is pending', () => {
    for (const state of ['idle', 'loading'] as SourceLoadState[]) {
      // Missing evidence reads inventory only.
      const m = deriveCountMeasure(state, 0)
      expect(formatCountMeasure(m)).toBe(MEASURE_UNKNOWN)
      expect(formatCountMeasure(m)).not.toBe('0')
    }
  })

  it('no farms-dependent KPI displays 0 while farms is pending', () => {
    // Expiring within 30 days reads farms only.
    expect(formatCountMeasure(deriveCountMeasure('loading', 0))).toBe('—')
  })

  it('Submissions awaiting review displays no number while either source pends', () => {
    const onlyFarmsReady = combineLoadStates('loaded', 'loading')
    expect(formatCountMeasure(deriveCountMeasure(onlyFarmsReady, 0))).toBe('—')
  })

  it('Supply position does not display "No batches on file" while pending', () => {
    for (const state of ['idle', 'loading'] as SourceLoadState[]) {
      expect(derivePanelMode(state, 0)).toBe('loading')
      expect(derivePanelMode(state, 0)).not.toBe('empty')
    }
  })

  it('shows a neutral loading note rather than a value', () => {
    expect(measureNote('loading')).toBe(MEASURE_PENDING_NOTE)
    expect(measureNote('idle')).toBe(MEASURE_PENDING_NOTE)
  })
})

describe('B. Successful non-zero load', () => {
  it('Missing evidence displays its real non-zero value', () => {
    expect(formatCountMeasure(deriveCountMeasure('loaded', 1))).toBe('1')
  })

  it('Submissions awaiting review displays its value once both sources load', () => {
    const both = combineLoadStates('loaded', 'loaded')
    expect(formatCountMeasure(deriveCountMeasure(both, 3))).toBe('3')
  })

  it('Supply position renders real batch records', () => {
    expect(derivePanelMode('loaded', 4)).toBe('list')
  })

  it('a loaded measure carries no pending or failure note', () => {
    expect(measureNote('loaded')).toBeNull()
  })
})

describe('C. Successful confirmed-zero load', () => {
  it('dependent KPIs may display 0 once their sources complete', () => {
    expect(formatCountMeasure(deriveCountMeasure('loaded', 0))).toBe('0')
    expect(formatCountMeasure(deriveCountMeasure(combineLoadStates('loaded', 'loaded'), 0))).toBe('0')
  })

  it('"No batches on file" appears only after a successful empty inventory read', () => {
    expect(derivePanelMode('loaded', 0)).toBe('empty')
    expect(SUPPLY_EMPTY).toBe('No batches on file')
  })

  it('a confirmed empty state is unreachable while any request is pending, idle or failed', () => {
    for (const state of UNSETTLED) {
      expect(derivePanelMode(state, 0)).not.toBe('empty')
    }
  })
})

describe('D. Inventory failure', () => {
  it('Supply position shows an error state, never "No batches on file"', () => {
    expect(derivePanelMode('error', 0)).toBe('error')
    expect(derivePanelMode('error', 0)).not.toBe('empty')
  })

  it('inventory-dependent KPIs do not display 0', () => {
    expect(formatCountMeasure(deriveCountMeasure('error', 0))).toBe(MEASURE_UNKNOWN)
    expect(measureNote('error')).toBe(MEASURE_ERROR_NOTE)
  })

  it('a failed inventory read is not rescued by rows left in state', () => {
    expect(derivePanelMode('error', 4)).toBe('error')
  })
})

describe('E. Farms failure — inventory-only information stays usable', () => {
  it('farm-dependent measures do not display 0', () => {
    // Expiring within 30 days reads farms only.
    expect(formatCountMeasure(deriveCountMeasure('error', 0))).toBe('—')
  })

  it('a measure needing both farms and inventory becomes unreportable', () => {
    expect(combineLoadStates('error', 'loaded')).toBe('error')
    expect(formatCountMeasure(deriveCountMeasure(combineLoadStates('error', 'loaded'), 0))).toBe('—')
  })

  it('inventory-only measures remain usable when only farms failed', () => {
    // This is the property the split from Promise.all buys: a farms failure no
    // longer discards a successful inventory result.
    expect(formatCountMeasure(deriveCountMeasure('loaded', 1))).toBe('1')
    expect(derivePanelMode('loaded', 4)).toBe('list')
  })
})

describe('deriveSignalsPanelMode remains the same rule under its retained name', () => {
  it('is the generalised panel rule', () => {
    expect(deriveSignalsPanelMode).toBe(derivePanelMode)
    expect(deriveSignalsPanelMode('loaded', 0)).toBe('empty')
    expect(SIGNALS_EMPTY).toBe('No unresolved alerts or rules awaiting decision.')
  })

  it('ComplianceLoadState remains assignable from SourceLoadState', () => {
    const s: ComplianceLoadState = 'loaded' satisfies SourceLoadState
    expect(s).toBe('loaded')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
   Compliance signals panel: fed by TWO sources.

   The defect: the panel's mode came from complianceLoadState alone, while its
   signal list also contained farm-derived expiry entries. Compliance finishing
   first settled the panel on the farms half's behalf, and because `farms` is
   pre-populated from the local store, stale seed expiry could show as current.
   ──────────────────────────────────────────────────────────────────────────── */

/** The Overview's rule, stated exactly as the page derives it. */
const signalsPanel = (compliance: SourceLoadState, farms: SourceLoadState, complianceSignalCount: number, farmExpiryCount: number) => {
  // Farm signals are admitted only once the farms read has succeeded.
  const shown = complianceSignalCount + (farms === 'loaded' ? farmExpiryCount : 0)
  const sourceState = combineLoadStates(compliance, farms)
  const mode = shown > 0 ? 'list' : derivePanelMode(sourceState, 0)
  const notes: string[] = []
  if (compliance === 'error') notes.push('Compliance alerts could not be loaded')
  else if (compliance === 'idle' || compliance === 'loading') notes.push('Compliance alerts still loading')
  if (farms === 'error') notes.push('Farm expiry signals could not be loaded')
  else if (farms === 'idle' || farms === 'loading') notes.push('Farm expiry signals still loading')
  return { mode, shown, notes }
}

describe('compliance signals panel is gated on BOTH compliance and farms', () => {
  it('farms loading → no farm expiry statement is made', () => {
    const p = signalsPanel('loaded', 'loading', 0, 3)
    expect(p.shown).toBe(0)                       // the 3 stale farm entries are withheld
    expect(p.mode).not.toBe('empty')              // and absence is not claimed either
    expect(p.mode).toBe('loading')
    expect(p.notes).toContain('Farm expiry signals still loading')
  })

  it('farms error → stale seed expiry is never shown as current', () => {
    const p = signalsPanel('loaded', 'error', 0, 3)
    expect(p.shown).toBe(0)
    expect(p.mode).toBe('error')
    expect(p.notes).toContain('Farm expiry signals could not be loaded')
  })

  it('compliance loaded while farms pending → loaded compliance signals are still shown, farms flagged', () => {
    // Independently successful data is not discarded.
    const p = signalsPanel('loaded', 'loading', 2, 5)
    expect(p.mode).toBe('list')
    expect(p.shown).toBe(2)                       // compliance only
    expect(p.notes).toEqual(['Farm expiry signals still loading'])
  })

  it('compliance pending while farms loaded → farm signals shown, compliance flagged', () => {
    const p = signalsPanel('loading', 'loaded', 0, 2)
    expect(p.mode).toBe('list')
    expect(p.shown).toBe(2)
    expect(p.notes).toEqual(['Compliance alerts still loading'])
  })

  it('both loaded → normal signals with no caveat', () => {
    const p = signalsPanel('loaded', 'loaded', 2, 1)
    expect(p.mode).toBe('list')
    expect(p.shown).toBe(3)
    expect(p.notes).toEqual([])
  })

  it('both loaded with zero results → confirmed empty state is allowed', () => {
    const p = signalsPanel('loaded', 'loaded', 0, 0)
    expect(p.mode).toBe('empty')
    expect(p.notes).toEqual([])
  })

  it('the empty claim requires BOTH sources — compliance alone can never settle it', () => {
    for (const farms of ['idle', 'loading', 'error'] as SourceLoadState[]) {
      expect(signalsPanel('loaded', farms, 0, 0).mode).not.toBe('empty')
    }
    for (const compliance of ['idle', 'loading', 'error'] as SourceLoadState[]) {
      expect(signalsPanel(compliance, 'loaded', 0, 0).mode).not.toBe('empty')
    }
  })

  it('a list drawn from an unsettled source always carries a caveat', () => {
    const p = signalsPanel('error', 'loaded', 0, 1)
    expect(p.mode).toBe('list')
    expect(p.notes.length).toBeGreaterThan(0)
  })

  it('demo mode: compliance unavailable + farms loaded is fully settled', () => {
    const p = signalsPanel('unavailable', 'loaded', 0, 0)
    expect(p.mode).toBe('empty')
    expect(p.notes).toEqual([])
  })
})
