import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_PRIORITY_LABELS,
  EVIDENCE_REQUEST_STATUS_LABELS,
  TARGET_UNAVAILABLE_LABEL,
  isEvidenceRequestOverdue,
  type EvidenceRequestListItem,
  type EvidenceServiceError,
} from '../../../domain/evidenceRequests'
import {
  farmerFilterKey,
  listFarmerEvidenceRequests,
  type FarmerEvidenceRequestFilters,
} from '../../../lib/evidenceRequests'
import { evidenceLoadScopeKey } from '../../../lib/evidenceRequestRoutes'
import { runGuardedLoad } from '../../../lib/asyncLoadGuard'
import { useEvidenceScopeReset } from '../../../lib/useEvidenceScopeReset'

/**
 * Farmer evidence-request list, rendered inside the existing `farmer-requests`
 * page (contract v1.5 §10.5).
 *
 * Three tabs, exactly as specified:
 *   Needs response — open, clarification_requested
 *   Submitted      — farmer_submitted
 *   Closed         — resolved, rejected, cancelled
 *
 * Loading, empty and failure are distinct (§10.5, §9.6). A failed load NEVER
 * shows "No requests" — that would tell a farmer there is nothing to do when the
 * truth is unknown.
 *
 * Visibility is decided entirely by RLS. This component applies no farm filter
 * of its own, because client-side list filtering is not authorization (§8.5,
 * §17.5).
 */

type Tab = 'needs_response' | 'submitted' | 'closed'

const TAB_LABELS: Record<Tab, string> = {
  needs_response: 'Needs response',
  submitted: 'Submitted',
  closed: 'Closed',
}

const TABS: Tab[] = ['needs_response', 'submitted', 'closed']

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; requests: EvidenceRequestListItem[] }
  | { kind: 'failed'; error: EvidenceServiceError }

function ageLabel(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Unknown'
  const days = Math.floor(Math.max(0, now.getTime() - then) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

export default function FarmerEvidenceRequestList({
  currentUserId,
  currentRole,
  onOpenRequest,
}: {
  currentUserId: string | null
  currentRole: string | null
  onOpenRequest: (requestId: string) => void
}) {
  const [tab, setTab] = useState<Tab>('needs_response')
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const filters: FarmerEvidenceRequestFilters = { scope: tab }
  const scopeKey = evidenceLoadScopeKey({
    userId: currentUserId,
    role: currentRole,
    route: { page: 'farmer-requests' },
    filterKey: farmerFilterKey(filters),
  })
  const activeScopeRef = useRef(scopeKey)

  // §9.7: an account, role or tab change clears the previous scope's rows
  // during render. Farmer A's requests can never appear to farmer B, not even
  // for the single frame an effect-based clear would leave visible.
  useEvidenceScopeReset(scopeKey, () => setState({ kind: 'loading' }))

  useEffect(() => {
    activeScopeRef.current = scopeKey

    let isActive = true
    void runGuardedLoad(listFarmerEvidenceRequests({ scope: tab }), () => isActive, {
      onSuccess: result => {
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
            message: 'Your evidence requests could not be loaded.',
            retryable: true,
          },
        })
      },
    })

    return () => {
      isActive = false
    }
  }, [scopeKey, tab, reloadToken])

  const retry = useCallback(() => setReloadToken(t => t + 1), [])
  const now = new Date()

  return (
    <section className="farmer-evidence-requests">
      <h2 className="section-title">Evidence requests from DDP</h2>

      <div className="tab-row" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t}
            className={tab === t ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {state.kind === 'loading' && (
        <div className="loading-panel" role="status">Loading your evidence requests…</div>
      )}

      {/* §10.5: a failed load is a visible failure with retry, never "No requests". */}
      {state.kind === 'failed' && (
        <div className="error-panel" role="alert">
          <strong>Your evidence requests could not be loaded.</strong>
          <p>{state.error.message}</p>
          <button className="btn btn-ghost" onClick={retry}>Retry</button>
        </div>
      )}

      {state.kind === 'loaded' && state.requests.length === 0 && (
        <div className="empty-state-hero">
          <p className="empty-state-message">
            {tab === 'needs_response'
              ? 'No evidence requests are waiting for your response.'
              : tab === 'submitted'
                ? 'You have no responses awaiting review.'
                : 'You have no closed evidence requests.'}
          </p>
        </div>
      )}

      {state.kind === 'loaded' &&
        state.requests.map(request => (
          <article key={request.id} className="request-card">
            <h3>{request.title}</h3>
            <p className="text-muted">
              {EVIDENCE_REQUEST_CATEGORY_LABELS[request.category]} ·{' '}
              {request.targetAvailable
                ? (request.targetLabel ?? TARGET_UNAVAILABLE_LABEL)
                : TARGET_UNAVAILABLE_LABEL}
            </p>
            <p>
              <span className="dv">{EVIDENCE_REQUEST_STATUS_LABELS[request.status]}</span>
              <span className="text-muted">
                {' '}· {EVIDENCE_REQUEST_PRIORITY_LABELS[request.priority]} priority ·{' '}
                {ageLabel(request.statusChangedAt, now)}
              </span>
            </p>
            <p className="text-muted">
              Due {request.dueDate ?? 'not specified'}
              {isEvidenceRequestOverdue(request, now) && (
                <span className="text-missing"> — past due</span>
              )}
            </p>
            <button className="btn btn-ghost" onClick={() => onOpenRequest(request.id)}>
              Open request
            </button>
          </article>
        ))}
    </section>
  )
}
