import type { Page } from '../../types'

const TABS: { pages: Page[]; target: Page; label: string }[] = [
  { pages: ['ddp-inventory', 'ddp-inventory-review'], target: 'ddp-inventory', label: 'Inventory Review' },
  { pages: ['ddp-master'], target: 'ddp-master', label: 'Master Inventory' },
  { pages: ['ddp-buyer'], target: 'ddp-buyer', label: 'Buyer Preview' },
]

export default function SupplyLedgerTabs({ page, goTo }: {
  page: Page
  goTo: (p: Page) => void
}) {
  return (
    <div className="filter-tabs supply-ledger-tabs">
      {TABS.map(t => (
        <button
          key={t.target}
          className={`filter-tab${t.pages.includes(page) ? ' filter-active' : ''}`}
          onClick={() => goTo(t.target)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
