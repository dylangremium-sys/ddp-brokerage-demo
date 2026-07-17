import type { Page } from '../../types'

const SUPPLY_LEDGER_PAGES: Page[] = ['ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer', 'ddp-missing-documents', 'ddp-coa-intelligence', 'ddp-risk-register']

/** Which presentation this instance renders. */
export type AdminNavVariant = 'sidebar' | 'topbar'

/**
 * Admin navigation.
 *
 * Appearance only. The four destinations, their labels and their active
 * conditions are exactly those of origin/main — no route is added, removed or
 * re-targeted. Only the elements and class names differ, plus aria-current,
 * which mirrors the active state already expressed visually.
 *
 * `variant` is explicit because the two contexts need different markup: the
 * editorial sidebar is only correct inside AdminShell, while demo mode (no
 * Supabase) keeps the existing 56px top navbar and renders this beside
 * FarmerNav, where full-width stacked rows would overflow and cover the page.
 */
export default function AdminNav({ page, goTo, variant = 'sidebar' }: {
  page: Page
  goTo: (p: Page) => void
  variant?: AdminNavVariant
}) {
  const isOverview = page === 'ddp-overview'
  const isFarms = page === 'ddp-farms' || page === 'ddp-farm-review'
  const isSupply = SUPPLY_LEDGER_PAGES.includes(page)
  const isWatchtower = page === 'ddp-compliance-watchtower'

  if (variant === 'topbar') {
    return (
      <div className="nav-group">
        <span className="nav-group-label ddp-label">DDP</span>
        <button
          className={`nav-btn ddp-nav-btn${isOverview ? ' nav-active' : ''}`}
          aria-current={isOverview ? 'page' : undefined}
          onClick={() => goTo('ddp-overview')}
        >Overview</button>
        <button
          className={`nav-btn ddp-nav-btn${isFarms ? ' nav-active' : ''}`}
          aria-current={isFarms ? 'page' : undefined}
          onClick={() => goTo('ddp-farms')}
        >Compliance</button>
        <button
          className={`nav-btn ddp-nav-btn${isSupply ? ' nav-active' : ''}`}
          aria-current={isSupply ? 'page' : undefined}
          onClick={() => goTo('ddp-master')}
        >Supply Ledger</button>
        <button
          className={`nav-btn ddp-nav-btn${isWatchtower ? ' nav-active' : ''}`}
          aria-current={isWatchtower ? 'page' : undefined}
          onClick={() => goTo('ddp-compliance-watchtower')}
        >Compliance Watchtower</button>
      </div>
    )
  }

  return (
    <div className="eo-nav-scroll">
      <div className="eo-nav-label">DDP</div>
      <button
        className={`eo-nav-item${isOverview ? ' eo-nav-item--active' : ''}`}
        aria-current={isOverview ? 'page' : undefined}
        onClick={() => goTo('ddp-overview')}
      >Overview</button>
      <button
        className={`eo-nav-item${isFarms ? ' eo-nav-item--active' : ''}`}
        aria-current={isFarms ? 'page' : undefined}
        onClick={() => goTo('ddp-farms')}
      >Compliance</button>
      <button
        className={`eo-nav-item${isSupply ? ' eo-nav-item--active' : ''}`}
        aria-current={isSupply ? 'page' : undefined}
        onClick={() => goTo('ddp-master')}
      >Supply Ledger</button>
      <button
        className={`eo-nav-item${isWatchtower ? ' eo-nav-item--active' : ''}`}
        aria-current={isWatchtower ? 'page' : undefined}
        onClick={() => goTo('ddp-compliance-watchtower')}
      >Compliance Watchtower</button>
    </div>
  )
}
