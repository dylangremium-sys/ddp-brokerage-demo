import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EVIDENCE_REQUEST_CATEGORIES,
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_PRIORITY_LABELS,
  EVIDENCE_REQUEST_STATUS_LABELS,
  EVIDENCE_REQUEST_TARGET_TYPES,
  EVIDENCE_REQUEST_TARGET_TYPE_LABELS,
  TARGET_UNAVAILABLE_LABEL,
  isEvidenceRequestOverdue,
  type EvidenceRequestCategory,
  type EvidenceRequestListItem,
  type EvidenceRequestPriority,
  type EvidenceRequestTargetType,
  type EvidenceServiceError,
} from '../../../domain/evidenceRequests'
import {
  adminFilterKey,
  listAdminEvidenceRequests,
  type AdminEvidenceRequestFilters,
} from '../../../lib/evidenceRequests'
import { evidenceLoadScopeKey } from '../../../lib/evidenceRequestRoutes'
import { runGuardedLoad } from '../../../lib/asyncLoadGuard'
import { useEvidenceScopeReset } from '../../../lib/useEvidenceScopeReset'

/**
 * Administrator evidence-request list and archive (contract v1.5 §10.2).
 *
 * Loading, empty, and failure are THREE DISTINCT states (§9.6, §17.14). A failed
 * load is never rendered as "No requests" — the panel says the data could not be
 * loaded and offers retry. "No evidence requests" appears only after a
 * successful load returned zero rows.
 *
 * There is no inline status mutation here (§10.2 "No inline status mutation").
 * Every decision happens on the detail page.
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; requests: EvidenceRequestListItem[] }
  | { kind: 'failed'; error: EvidenceServiceError }

export default function AdminEvidenceRequests({
  currentUserId,
  currentRole,
  onOpenRequest,
  onCreateRequest,
}: {
  currentUserId: string | null
  currentRole: string | null
  onOpenRequest: (requestId: string) => void
  onCreateRequest: () => void
}) {
  const [scope, setScope] = useState<'active' | 'closed' | 'all'>('active')
  const [priority, setPriority] = useState<EvidenceRequestPriority | 'all'>('all')
  const [category, setCategory] = useState<EvidenceRequestCategory | 'all'>('all')
  const [targetType, setTargetType] = useState<EvidenceRequestTargetType | 'all'>('all')
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const filters = useMemo<AdminEvidenceRequestFilters>(
    () => ({
      scope,
      ...(priority !== 'all' ? { priority } : {}),
      ...(category !== 'all' ? { category } : {}),
      ...(targetType !== 'all' ? { targetType } : {}),
    }),
    [scope, priority, category, targetType],
  )

  // §9.7: the load is scoped by user + role + route + filters. When the key
  // changes, protected data is CLEARED to the loading state before the new load
  // starts, so no previous scope's rows are ever rendered as current.
  const scopeKey = evidenceLoadScopeKey({
    userId: currentUserId,
    role: currentRole,
    route: { page: 'admin-evidence-requests' },
    filterKey: adminFilterKey(filters),
  })

  const activeScopeRef = useRef(scopeKey)

  // §9.7: clear during render, so no frame ever paints the previous scope's
  // rows as if they were current.
  useEvidenceScopeReset(scopeKey, () => setState({ kind: 'loading' }))

  useEffect(() => {
    activeScopeRef.current = scopeKey

    let isActive = true
    void runGuardedLoad(listAdminEvidenceRequests(filters), () => isActive, {
      onSuccess: result => {
        // Second guard: a late response from a superseded scope is discarded
        // even if the effect cleanup has not run yet.
        if (activeScopeRef.current !== scopeKey) return
        if (result.ok) setState({ kind: 'loaded', requests: result.data })
        else setState({ kind: 'failed', error: result.error })
      },
      onError: () => {
        if (activeScopeRef.current !== scopeKey) return
        setState({
          kind: 'failed',
          error: {
            code: 'DATA_UNAVAILABLE',
            message: 'Evidence requests could not be loaded.',
            retryable: true,
          },
        })
      },
    })

    return () => {
      isActive = false
    }
  }, [scopeKey, filters, reloadToken])

  const retry = useCallback(() => setReloadToken(t => t + 1), [])
  const now = new Date()

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 className="page-title">Evidence requests</h1>
            <p className="page-desc">
              Evidence requested from farmers, and the archive of closed requests.
              Every decision is recorded on the request itself.
            </p>
          </div>
          <button className="btn btn-primary" onClick={onCreateRequest}>
            Create request
          </button>
        </div>
      </div>

      <div className="filter-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <label>
          <span className="dl">Status</span>
          <select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          <span className="dl">Priority</span>
          <select value={priority} onChange={e => setPriority(e.target.value as typeof priority)}>
            <option value="all">All priorities</option>
            {EVIDENCE_REQUEST_PRIORITIES.map(p => (
              <option key={p} value={p}>{EVIDENCE_REQUEST_PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="dl">Category</span>
          <select value={category} onChange={e => setCategory(e.target.value as typeof category)}>
            <option value="all">All categories</option>
            {EVIDENCE_REQUEST_CATEGORIES.map(c => (
              <option key={c} value={c}>{EVIDENCE_REQUEST_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="dl">Target</span>
          <select value={targetType} onChange={e => setTargetType(e.target.value as typeof targetType)}>
            <option value="all">All targets</option>
            {EVIDENCE_REQUEST_TARGET_TYPES.map(t => (
              <option key={t} value={t}>{EVIDENCE_REQUEST_TARGET_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>
      </div>

      {state.kind === 'loading' && (
        <div className="loading-panel" role="status">
          Loading evidence requests…
        </div>
      )}

      {/* §10.2 / §9.6: a failure is a persistent panel with retry. It is never
          collapsed into an empty list, and it carries no all-clear language. */}
      {state.kind === 'failed' && (
        <div className="error-panel" role="alert">
          <strong>Evidence requests could not be loaded.</strong>
          <p>{state.error.message}</p>
          <button className="btn btn-ghost" onClick={retry}>Retry</button>
        </div>
      )}

      {state.kind === 'loaded' && state.requests.length === 0 && (
        <div className="empty-state-hero">
          <p className="empty-state-message">
            No evidence requests match this view.
          </p>
        </div>
      )}

      {state.kind === 'loaded' && state.requests.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Target</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Due</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.requests.map(request => (
              <tr key={request.id}>
                <td>{request.title}</td>
                <td>{EVIDENCE_REQUEST_CATEGORY_LABELS[request.category]}</td>
                {/* §10.2 partial target failure: the row STAYS, labelled. */}
                <td className={request.targetAvailable ? undefined : 'text-missing'}>
                  {request.targetAvailable
                    ? (request.targetLabel ?? TARGET_UNAVAILABLE_LABEL)
                    : TARGET_UNAVAILABLE_LABEL}
                </td>
                <td>{EVIDENCE_REQUEST_STATUS_LABELS[request.status]}</td>
                <td>{EVIDENCE_REQUEST_PRIORITY_LABELS[request.priority]}</td>
                <td>
                  {request.dueDate ?? <span className="text-muted">—</span>}
                  {/* §3.2: overdue is a derived display condition only. */}
                  {isEvidenceRequestOverdue(request, now) && (
                    <span className="text-missing"> (past due)</span>
                  )}
                </td>
                <td>
                  <button className="btn btn-ghost" onClick={() => onOpenRequest(request.id)}>
                    Open request
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
