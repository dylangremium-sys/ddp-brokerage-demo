import type { Page } from '../../types'

/**
 * How the admin shell presents itself: which navigation markup a session gets,
 * and which content treatment a routed page gets.
 *
 * These live outside the component files because they are data and rules, not
 * components — and because both are worth testing directly. Two regressions are
 * pinned here:
 *
 *   - Demo mode renders AdminNav inside the 56px `.navbar` beside FarmerNav.
 *     The editorial sidebar's stacked 44px rows overflow it and cover the page,
 *     so that context needs its own compact markup.
 *   - AdminShell routes every page through `.eo-content`, which has no padding.
 *     Only the Overview supplies its own via `.eo-page`; the rest would render
 *     flush against the shell edges without a restored gutter.
 */

/** Minimal outlined icon paths — 16px box, stroked with currentColor. */
export const ICON = {
  overview: 'M2 9.5 8 3l6 6.5M3.5 8v5h9V8',
  suppliers: 'M2 13V6l4-3 4 3v7M10 13V8h4v5M2 13h12M5 9.5h2',
  supply: 'M2 5.5 8 2.5l6 3v5l-6 3-6-3zM2 5.5 8 8.5m0 0 6-3M8 8.5v5',
  evidence: 'M9.5 2H4v12h8V4.5zM9.5 2v2.5H12M6 8.5h4M6 11h3',
  buyer: 'M3 5.5h10l-.8 8H3.8zM5.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5',
  audit: 'M8 3.5v4.5l3 1.5M8 14A6 6 0 1 1 8 2a6 6 0 0 1 0 12z',
  compliance: 'M8 2 3 4v4.5c0 3 2.1 5.2 5 5.5 2.9-.3 5-2.5 5-5.5V4z',
} as const

/**
 * Pages the legacy "Supply Ledger" top-navbar button represents. Retained from
 * the original navbar so its active state is unchanged in demo mode.
 */
const SUPPLY_LEDGER_PAGES: Page[] = ['ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register']

export interface NavEntry {
  target: Page
  label: string
  icon: string
  /** Which routes light this entry up. Shared by both variants. */
  isActive: (page: Page) => boolean
}

export interface NavSection {
  label?: string
  entries: NavEntry[]
}

/** Which presentation an AdminNav instance renders. */
export type AdminNavVariant = 'sidebar' | 'topbar'

/**
 * The sidebar's grouping of existing admin destinations. Every target is a Page
 * already present in the router — no route is invented, added or removed.
 */
export const SIDEBAR_SECTIONS: NavSection[] = [
  {
    entries: [
      { target: 'ddp-overview', label: 'Overview', icon: ICON.overview, isActive: p => p === 'ddp-overview' },
    ],
  },
  {
    label: 'Suppliers',
    entries: [
      { target: 'ddp-farms', label: 'Farm profiles', icon: ICON.suppliers, isActive: p => p === 'ddp-farms' || p === 'ddp-farm-review' },
    ],
  },
  {
    label: 'Supply',
    entries: [
      { target: 'ddp-master', label: 'Supply ledger', icon: ICON.supply, isActive: p => p === 'ddp-master' },
      { target: 'ddp-inventory', label: 'Inventory review', icon: ICON.supply, isActive: p => p === 'ddp-inventory' || p === 'ddp-inventory-review' },
    ],
  },
  {
    label: 'Evidence',
    entries: [
      { target: 'ddp-missing-documents', label: 'Missing documents', icon: ICON.evidence, isActive: p => p === 'ddp-missing-documents' },
      { target: 'ddp-coa-intelligence', label: 'COA intelligence', icon: ICON.evidence, isActive: p => p === 'ddp-coa-intelligence' },
    ],
  },
  {
    label: 'Reviews',
    entries: [
      { target: 'ddp-risk-register', label: 'Risk register', icon: ICON.audit, isActive: p => p === 'ddp-risk-register' },
      { target: 'ddp-compliance-watchtower', label: 'Compliance watchtower', icon: ICON.compliance, isActive: p => p === 'ddp-compliance-watchtower' },
    ],
  },
  {
    label: 'Buyer dossiers',
    entries: [
      { target: 'ddp-buyer', label: 'Buyer pack preview', icon: ICON.buyer, isActive: p => p === 'ddp-buyer' },
    ],
  },
]

/**
 * The legacy top-navbar destinations, exactly as they were before the editorial
 * redesign. Demo mode keeps this compact set; its Supply Ledger sub-pages stay
 * reachable through SupplyLedgerTabs, unchanged.
 */
export const TOPBAR_ENTRIES: NavEntry[] = [
  { target: 'ddp-overview', label: 'Overview', icon: ICON.overview, isActive: p => p === 'ddp-overview' },
  { target: 'ddp-farms', label: 'Compliance', icon: ICON.suppliers, isActive: p => p === 'ddp-farms' || p === 'ddp-farm-review' },
  { target: 'ddp-master', label: 'Supply Ledger', icon: ICON.supply, isActive: p => SUPPLY_LEDGER_PAGES.includes(p) },
  { target: 'ddp-compliance-watchtower', label: 'Compliance Watchtower', icon: ICON.compliance, isActive: p => p === 'ddp-compliance-watchtower' },
]

/** The destinations each variant offers. */
export const ADMIN_NAV_TARGETS: Record<AdminNavVariant, Page[]> = {
  sidebar: SIDEBAR_SECTIONS.flatMap(s => s.entries.map(e => e.target)),
  topbar: TOPBAR_ENTRIES.map(e => e.target),
}

/**
 * Which content treatment a routed admin page gets inside the shell.
 *
 * The Overview supplies its own editorial padding through `.eo-page`, so it
 * takes the canvas variant alone — adding a gutter here would double it. Every
 * other admin route begins at `.page-wrap`, which sets width but no padding;
 * before the shell those pages inherited their gutter from `.main-content`.
 * The legacy variant restores exactly that spacing.
 */
export function contentVariantClass(page: Page): 'eo-content-canvas' | 'eo-content-legacy' {
  return page === 'ddp-overview' ? 'eo-content-canvas' : 'eo-content-legacy'
}
