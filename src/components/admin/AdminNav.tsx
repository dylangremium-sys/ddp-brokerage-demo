import type { Page } from '../../types'

/** Minimal outlined icons — currentColor, 1.5 stroke, no colour of their own. */
function Icon({ d }: { d: string }) {
  return (
    <svg
      className="eo-nav-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  )
}

const ICON = {
  overview: 'M2 9.5 8 3l6 6.5M3.5 8v5h9V8',
  suppliers: 'M2 13V6l4-3 4 3v7M10 13V8h4v5M2 13h12M5 9.5h2',
  supply: 'M2 5.5 8 2.5l6 3v5l-6 3-6-3zM2 5.5 8 8.5m0 0 6-3M8 8.5v5',
  evidence: 'M9.5 2H4v12h8V4.5zM9.5 2v2.5H12M6 8.5h4M6 11h3',
  buyer: 'M3 5.5h10l-.8 8H3.8zM5.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5',
  audit: 'M8 3.5v4.5l3 1.5M8 14A6 6 0 1 1 8 2a6 6 0 0 1 0 12z',
  compliance: 'M8 2 3 4v4.5c0 3 2.1 5.2 5 5.5 2.9-.3 5-2.5 5-5.5V4z',
} as const

/**
 * Editorial Operations side navigation.
 *
 * Groups the *existing* admin destinations under semantic sections. No route is
 * invented, added or removed — every entry targets a Page already present in the
 * router. The Supply Ledger sub-pages were previously reachable only through
 * SupplyLedgerTabs; that tab bar is untouched and still renders in-section.
 *
 * The ddp-farms entry is relabelled "Farm profiles" (it renders DDPFarmProfiles).
 * Label only — the route is unchanged. Its previous label, "Compliance",
 * collided with the separate Compliance Watchtower destination.
 */
export default function AdminNav({ page, goTo }: {
  page: Page
  goTo: (p: Page) => void
}) {
  const item = (target: Page, label: string, icon: string, active: boolean) => (
    <button
      className="eo-nav-item"
      aria-current={active ? 'page' : undefined}
      onClick={() => goTo(target)}
    >
      <Icon d={icon} />
      <span>{label}</span>
    </button>
  )

  return (
    <div className="eo-nav-scroll">
      <div className="eo-nav-section">
        {item('ddp-overview', 'Overview', ICON.overview, page === 'ddp-overview')}
      </div>

      <div className="eo-nav-section">
        <div className="eo-nav-section-label">Suppliers</div>
        {item('ddp-farms', 'Farm profiles', ICON.suppliers, page === 'ddp-farms' || page === 'ddp-farm-review')}
      </div>

      <div className="eo-nav-section">
        <div className="eo-nav-section-label">Supply</div>
        {item('ddp-master', 'Supply ledger', ICON.supply, page === 'ddp-master')}
        {item('ddp-inventory', 'Inventory review', ICON.supply, page === 'ddp-inventory' || page === 'ddp-inventory-review')}
      </div>

      <div className="eo-nav-section">
        <div className="eo-nav-section-label">Evidence</div>
        {item('ddp-missing-documents', 'Missing documents', ICON.evidence, page === 'ddp-missing-documents')}
        {item('ddp-coa-intelligence', 'COA intelligence', ICON.evidence, page === 'ddp-coa-intelligence')}
      </div>

      <div className="eo-nav-section">
        <div className="eo-nav-section-label">Reviews</div>
        {item('ddp-risk-register', 'Risk register', ICON.audit, page === 'ddp-risk-register')}
        {item('ddp-compliance-watchtower', 'Compliance watchtower', ICON.compliance, page === 'ddp-compliance-watchtower')}
      </div>

      <div className="eo-nav-section">
        <div className="eo-nav-section-label">Buyer dossiers</div>
        {item('ddp-buyer', 'Buyer pack preview', ICON.buyer, page === 'ddp-buyer')}
      </div>
    </div>
  )
}
