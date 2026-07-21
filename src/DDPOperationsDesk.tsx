import { useMemo, useState } from 'react'
import type { ComplianceAlert, FarmProfile, InventoryItem, Page, ReviewRequest } from '../../types'
import {
  buildOperationsDeskItems,
  CATEGORY_LABEL,
  OPERATIONS_DESK_CATEGORIES,
  type OperationsDeskCategory,
  type OperationsDeskItem,
} from '../../lib/operationsDesk'
import {
  EMPTY_FILTERS,
  presentOperationsDeskItems,
  summariseOperationsDeskItems,
  type OperationsDeskFilterState,
} from '../../lib/operationsDeskFilters'
import {
  OPERATIONS_DESK_PRIORITIES,
  PRIORITY_LABEL,
  type OperationsDeskPriority,
} from '../../lib/operationsDeskPriority'

/**
 * Operations Desk — an operational index over records that already exist.
 *
 * READ-ONLY BY CONSTRUCTION. This page renders no mutation control of any
 * kind: no approve/reject, no procurement decision, no rule activation, and
 * no Buyer Pack issue/print/download/copy. Every action is a navigation to
 * the authoritative page that owns the decision. The desk never becomes a
 * second place where work is recorded.
 *
 * All classification, filtering and ordering lives in lib/operationsDesk*.ts
 * so it is testable without a DOM (this repo's vitest environment is 'node').
 */
export default function DDPOperationsDesk({
  farms,
  inventory,
  reviewRequests,
  reviewRequestsLoading,
  complianceAlerts,
  complianceLoading,
  onOpenFarm,
  onOpenItem,
  goTo,
}: {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  /** null means the review-request source failed to load — not "no requests". */
  reviewRequests: ReviewRequest[] | null
  reviewRequestsLoading: boolean
  /** null means the compliance source failed to load — not "no alerts". */
  complianceAlerts: ComplianceAlert[] | null
  complianceLoading: boolean
  onOpenFarm: (farmId: string) => void
  onOpenItem: (itemId: string) => void
  goTo: (page: Page) => void
}) {
  const [filters, setFilters] = useState<OperationsDeskFilterState>(EMPTY_FILTERS)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const result = useMemo(
    () => buildOperationsDeskItems({ farms, inventory, reviewRequests, complianceAlerts }),
    [farms, inventory, reviewRequests, complianceAlerts],
  )

  const visible = useMemo(
    () => presentOperationsDeskItems(result.items, filters),
    [result.items, filters],
  )

  const summary = useMemo(() => summariseOperationsDeskItems(result.items), [result.items])

  const isFiltered =
    filters.search.trim() !== '' || filters.category !== 'all' || filters.priority !== 'all'

  function openItem(item: OperationsDeskItem) {
    const farmId = item.destinationParams?.farmId
    const itemId = item.destinationParams?.itemId
    if (item.destinationPage === 'ddp-farm-review' && farmId) { onOpenFarm(farmId); return }
    if (item.destinationPage === 'ddp-inventory-review' && itemId) { onOpenItem(itemId); return }
    goTo(item.destinationPage)
  }

  return (
    <div className="page-wrap ddp-wrap ops-desk">
      <header className="ops-desk-head">
        <h1 className="ops-desk-title">Operations Desk</h1>
        <p className="ops-desk-standfirst">
          The matters requiring review, decision, or follow-up across DDP Brokerage.
        </p>
      </header>

      {/* Partial-failure notice. A queue that could not be built is stated
          plainly — an incomplete desk is never presented as an all-clear. */}
      {result.failures.length > 0 && (
        <div className="ops-desk-notice" role="status">
          <strong>This view is incomplete.</strong>
          <ul>
            {result.failures.map(failure => (
              <li key={`${failure.category}:${failure.message}`}>
                {CATEGORY_LABEL[failure.category]}: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reviewRequestsLoading && (
        <p className="ops-desk-loading" role="status">Loading follow-up requests…</p>
      )}

      {complianceLoading && (
        <p className="ops-desk-loading" role="status">Loading compliance matters…</p>
      )}

      <dl className="ops-desk-summary">
        {summary.map(group => (
          <div className="ops-desk-summary-cell" key={group.key}>
            <dt>{group.label}</dt>
            <dd>{group.count}</dd>
          </div>
        ))}
      </dl>

      <div className="ops-desk-controls no-print">
        <div className="ops-desk-field">
          <label htmlFor="ops-desk-search">Search matters</label>
          <input
            id="ops-desk-search"
            type="search"
            value={filters.search}
            placeholder="Farm, batch, reason…"
            onChange={e => setFilters({ ...filters, search: e.target.value })}
          />
        </div>
        <div className="ops-desk-field">
          <label htmlFor="ops-desk-category">Category</label>
          <select
            id="ops-desk-category"
            value={filters.category}
            onChange={e =>
              setFilters({ ...filters, category: e.target.value as OperationsDeskCategory | 'all' })
            }
          >
            <option value="all">All categories</option>
            {OPERATIONS_DESK_CATEGORIES.map(category => (
              <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>
            ))}
          </select>
        </div>
        <div className="ops-desk-field">
          <label htmlFor="ops-desk-priority">Priority</label>
          <select
            id="ops-desk-priority"
            value={filters.priority}
            onChange={e =>
              setFilters({ ...filters, priority: e.target.value as OperationsDeskPriority | 'all' })
            }
          >
            <option value="all">All priorities</option>
            {OPERATIONS_DESK_PRIORITIES.map(priority => (
              <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* The wide table scrolls inside this bounded container so the page/root
          never scrolls sideways. The container establishes a horizontal scroll
          context (min-content 0), which stops the table's nowrap min-content
          from widening the flex .main-content ancestor on narrow viewports. */}
      <div className="ops-desk-table-scroll">
        <table className="ops-desk-table">
          <caption className="ops-desk-caption">
          {visible.length} matter{visible.length === 1 ? '' : 's'} shown
          {isFiltered ? ` of ${result.items.length} total` : ''}. Priority is a display-only
          indication of order of attention and is not a recorded status.
        </caption>
        <thead>
          <tr>
            <th scope="col">Priority</th>
            <th scope="col">Matter</th>
            <th scope="col">Entity</th>
            <th scope="col">Reason</th>
            <th scope="col">Status</th>
            <th scope="col">Age</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="ops-desk-empty">
                {result.failures.length > 0
                  ? 'No matters could be listed. Some sources failed to load — see the notice above.'
                  : isFiltered
                    ? 'No matters match the current filters.'
                    : 'Nothing is currently awaiting review, decision, or follow-up.'}
              </td>
            </tr>
          )}

          {visible.map(item => {
            const expanded = expandedId === item.id
            const detailId = `ops-detail-${item.id}`
            return [
              <tr key={item.id} className={`ops-desk-row ops-desk-row--${item.priority}`}>
                <td>
                  {/* Text label, never colour alone. */}
                  <span className={`ops-desk-priority ops-desk-priority--${item.priority}`}>
                    {PRIORITY_LABEL[item.priority]}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="ops-desk-matter"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                  >
                    {item.title}
                  </button>
                  <span className="ops-desk-category">{CATEGORY_LABEL[item.category]}</span>
                </td>
                <td>{item.entityLabel}</td>
                <td className="ops-desk-reason">{item.reason}</td>
                <td>{item.statusLabel}</td>
                <td>
                  {item.ageInDays === undefined
                    ? <span className="ops-desk-muted">No recorded date</span>
                    : `${item.ageInDays} day${item.ageInDays === 1 ? '' : 's'}`}
                </td>
                <td>
                  <button
                    type="button"
                    className="ops-desk-action"
                    onClick={() => openItem(item)}
                  >
                    {item.actionLabel}
                    <span className="sr-only"> — {item.title}, {item.entityLabel}</span>
                  </button>
                </td>
              </tr>,
              expanded ? (
                <tr key={`${item.id}:detail`} className="ops-desk-detail-row">
                  <td colSpan={7} id={detailId}>
                    <dl className="ops-desk-detail">
                      <dt>Why this needs attention</dt>
                      <dd>{item.reason}</dd>
                      <dt>Source record</dt>
                      <dd>{item.sourceEntityType} · {item.sourceEntityId}</dd>
                      {item.occurredAt && (<><dt>Recorded</dt><dd>{item.occurredAt}</dd></>)}
                      <dt>Resolve at</dt>
                      <dd>
                        This matter is decided on the authoritative page — the Operations Desk
                        records nothing.
                      </dd>
                    </dl>
                  </td>
                </tr>
              ) : null,
            ]
          })}
        </tbody>
        </table>
      </div>

      <p className="ops-desk-footnote">
        Read-only index. Nothing is approved, issued, or recorded here. Document and risk
        overrides are stored in this browser, so those entries reflect this workstation rather
        than an organisation-wide view. Buyer Pack matters are not listed — that gate is owned
        by Buyer Preview and is not yet available as a shared source.
      </p>
    </div>
  )
}
