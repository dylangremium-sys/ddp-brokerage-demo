import type { Page } from '../../types'

const SUPPLY_LEDGER_PAGES: Page[] = ['ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register']

/**
 * Admin navigation, restyled as the editorial sidebar.
 *
 * Appearance only. The four destinations, their labels and their active
 * conditions are exactly those of the previous top-navbar markup — no route is
 * added, removed or re-targeted. Only the elements and class names changed, plus
 * aria-current, which mirrors the active state already expressed visually.
 */
export default function AdminNav({ page, goTo }: {
  page: Page
  goTo: (p: Page) => void
}) {
  return (
    <div className="eo-nav-scroll">
      <div className="eo-nav-label">DDP</div>
      <button
        className={`eo-nav-item${page === 'ddp-overview' ? ' eo-nav-item--active' : ''}`}
        aria-current={page === 'ddp-overview' ? 'page' : undefined}
        onClick={() => goTo('ddp-overview')}
      >Overview</button>
      <button
        className={`eo-nav-item${page === 'ddp-farms' || page === 'ddp-farm-review' ? ' eo-nav-item--active' : ''}`}
        aria-current={page === 'ddp-farms' || page === 'ddp-farm-review' ? 'page' : undefined}
        onClick={() => goTo('ddp-farms')}
      >Compliance</button>
      <button
        className={`eo-nav-item${SUPPLY_LEDGER_PAGES.includes(page) ? ' eo-nav-item--active' : ''}`}
        aria-current={SUPPLY_LEDGER_PAGES.includes(page) ? 'page' : undefined}
        onClick={() => goTo('ddp-master')}
      >Supply Ledger</button>
      <button
        className={`eo-nav-item${page === 'ddp-compliance-watchtower' ? ' eo-nav-item--active' : ''}`}
        aria-current={page === 'ddp-compliance-watchtower' ? 'page' : undefined}
        onClick={() => goTo('ddp-compliance-watchtower')}
      >Compliance Watchtower</button>
    </div>
  )
}
