import type { Page } from '../../types'

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
      >Farm Profiles</button>
      <button
        className={`nav-btn ddp-nav-btn${page === 'ddp-inventory' || page === 'ddp-inventory-review' ? ' nav-active' : ''}`}
        onClick={() => goTo('ddp-inventory')}
      >Inventory Review</button>
      <button
        className={`nav-btn ddp-nav-btn${page === 'ddp-master' ? ' nav-active' : ''}`}
        onClick={() => goTo('ddp-master')}
      >Master Inventory</button>
      <button
        className={`nav-btn ddp-nav-btn${page === 'ddp-buyer' ? ' nav-active' : ''}`}
        onClick={() => goTo('ddp-buyer')}
      >Buyer Preview</button>
    </div>
  )
}
