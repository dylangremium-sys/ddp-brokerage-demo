import type { Page } from '../../types'

const SUPPLY_LEDGER_PAGES: Page[] = ['ddp-inventory', 'ddp-inventory-review', 'ddp-master', 'ddp-buyer']

export default function AdminNav({ page, goTo }: {
  page: Page
  goTo: (p: Page) => void
}) {
  return (
    <div className="nav-group">
      <span className="nav-group-label ddp-label">DDP</span>
      <button
        className={`nav-btn ddp-nav-btn${page === 'ddp-overview' ? ' nav-active' : ''}`}
        onClick={() => goTo('ddp-overview')}
      >Overview</button>
      <button
        className={`nav-btn ddp-nav-btn${page === 'ddp-farms' || page === 'ddp-farm-review' ? ' nav-active' : ''}`}
        onClick={() => goTo('ddp-farms')}
      >Compliance</button>
      <button
        className={`nav-btn ddp-nav-btn${SUPPLY_LEDGER_PAGES.includes(page) ? ' nav-active' : ''}`}
        onClick={() => goTo('ddp-master')}
      >Supply Ledger</button>
    </div>
  )
}
