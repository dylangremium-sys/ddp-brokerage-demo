import type { Page } from '../../types'

const TABS: { pages: Page[]; target: Page; label: string }[] = [
  { pages: ['ddp-inventory', 'ddp-inventory-review'], target: 'ddp-inventory', label: 'Inventory Review' },
  { pages: ['ddp-master'], target: 'ddp-master', label: 'Master Inventory' },
  { pages: ['ddp-missing-documents'], target: 'ddp-missing-documents', label: 'Missing Documents' },
  { pages: ['ddp-coa-intelligence'], target: 'ddp-coa-intelligence', label: 'COA Intelligence' },
  { pages: ['ddp-risk-register'], target: 'ddp-risk-register', label: 'Risk Register' },
  { pages: ['ddp-buyer'], target: 'ddp-buyer', label: 'Buyer Preview' },
]

export default function SupplyLedgerTabs({ page, goTo }: {
  page: Page
  goTo: (p: Page) => void
}) {
  return (
    <div className="seg" role="tablist">
      {TABS.map(t => (
        <button
          key={t.target}
          type="button"
          role="tab"
          className="seg-opt"
          aria-pressed={t.pages.includes(page)}
          aria-selected={t.pages.includes(page)}
          onClick={() => goTo(t.target)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
