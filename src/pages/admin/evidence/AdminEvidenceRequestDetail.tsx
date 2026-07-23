import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_PRIORITY_LABELS,
  EVIDENCE_REQUEST_STATUS_LABELS,
  EVIDENCE_TEXT_LIMITS,
  TARGET_UNAVAILABLE_LABEL,
  adminActionsForEvidenceStatus,
  isEvidenceRequestOverdue,
  isTrimmedLengthWithin,
  type AdminEvidenceAction,
  type EvidenceRequestDetail,
  type EvidenceServiceError,
} from '../../../domain/evidenceRequests'
import {
  cancelEvidenceRequest,
  getEvidenceAttachmentSignedUrl,
  getEvidenceRequest,
  rejectEvidenceResponse,
  requestEvidenceClarification,
  resolveEvidenceRequest,
} from '../../../lib/evidenceRequests'
import { evidenceLoadScopeKey } from '../../../lib/evidenceRequestRoutes'
import { runGuardedLoad } from '../../../lib/asyncLoadGuard'
import { useEvidenceScopeReset } from '../../../lib/useEvidenceScopeReset'
import { EvidenceHistoryList, EvidenceSubmittedThread } from '../../../components/shared/EvidenceThread'

/**
 * Administrator detail and review page (contract v1.5 §10.4).
 *
 * The authoritative place where an evidence request is reviewed. Rules:
 *
 * - Actions are offered strictly per §10.4's status table; a terminal request
 *   offers none (§4.7). The database enforces the same matrix, so a button is a
 *   convenience and never the authorization.
 * - Every review action requires an EXPLICIT confirmation section and a
 *   MANDATORY note (§10.4, §5.3 lengths).
 * - Buttons disable while a mutation is pending (§10.4), which also prevents a
 *   double click issuing two decisions.
 * - A CONFLICT reloads the authoritative request and does NOT silently re-apply
 *   the prior action (§5.4). The administrator must look again and re-decide.
 * - A target-unavailable request stays reviewable for cancellation and history
 *   inspection (§10.4, §11.4).
 * - The administrator cannot edit farmer response text or attachments and cannot
 *   upload evidence as the farmer (§10.4, §17.10). There is no control here that
 *   does any of those things.
 */

const ACTION_LABELS: Record<AdminEvidenceAction, string> = {
  clarify: 'Request clarification',
  resolve: 'Mark reviewed and resolve',
  reject: 'Reject evidence',
  cancel: 'Cancel request',
}

const ACTION_NOTE_LABELS: Record<AdminEvidenceAction, string> = {
  clarify: 'What the farmer must clarify or provide',
  resolve: 'Resolution note',
  reject: 'Why the evidence is rejected',
  cancel: 'Why the request is being cancelled',
}

const ACTION_LIMITS: Record<AdminEvidenceAction, { min: number; max: number }> = {
  clarify: EVIDENCE_TEXT_LIMITS.clarificationReason,
  resolve: EVIDENCE_TEXT_LIMITS.resolutionNote,
  reject: EVIDENCE_TEXT_LIMITS.rejectionReason,
  cancel: EVIDENCE_TEXT_LIMITS.cancellationReason,
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; detail: EvidenceRequestDetail }
  | { kind: 'failed'; error: EvidenceServiceError }

export default function AdminEvidenceRequestDetail({
  requestId,
  currentUserId,
  currentRole,
  onBack,
}: {
  requestId: string
  currentUserId: string | null
  currentRole: string | null
  onBack: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [action, setAction] = useState<AdminEvidenceAction | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<EvidenceServiceError | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const scopeKey = evidenceLoadScopeKey({
    userId: currentUserId,
    role: currentRole,
    route: { page: 'admin-evidence-request-detail', requestId },
  })
  const activeScopeRef = useRef(scopeKey)

  // §9.7: clear protected data BEFORE the new load, during render. A previous
  // request's detail — and any half-typed review decision against it — must
  // never be rendered while a different request is loading.
  useEvidenceScopeReset(scopeKey, () => {
    setState({ kind: 'loading' })
    setAction(null)
    setNote('')
    setActionError(null)
  })

  useEffect(() => {
    activeScopeRef.current = scopeKey

    let isActive = true
    void runGuardedLoad(getEvidenceRequest(requestId), () => isActive, {
      onSuccess: result => {
        if (activeScopeRef.current !== scopeKey) return
        if (result.ok) setState({ kind: 'loaded', detail: result.data })
        else setState({ kind: 'failed', error: result.error })
      },
      onError: () => {
        if (activeScopeRef.current !== scopeKey) return
        setState({
          kind: 'failed',
          error: { code: 'DATA_UNAVAILABLE', message: 'This request could not be loaded.', retryable: true },
        })
      },
    })

    return () => {
      isActive = false
    }
  }, [scopeKey, requestId, reloadToken])

  const reload = useCallback(() => setReloadToken(t => t + 1), [])

  async function openAttachment(bucket: string | null, path: string | null) {
    if (!bucket || !path) return
    const result = await getEvidenceAttachmentSignedUrl({ bucket, path })
    // The bucket is private (§7.1): access is a short-lived signed URL issued
    // under the caller's own RLS. There is no public URL path.
    if (result.ok) window.open(result.data, '_blank', 'noopener,noreferrer')
    else setActionError(result.error)
  }

  async function runAction() {
    if (state.kind !== 'loaded' || action === null || pending) return
    const { detail } = state
    const trimmed = note.trim()
    if (!isTrimmedLengthWithin(note, ACTION_LIMITS[action])) return

    // §5.1: clarification, resolution and rejection all act on the CURRENT
    // submitted response. An older response id is refused by the database.
    const latestSubmitted = [...detail.responses]
      .filter(r => r.state === 'submitted')
      .sort((a, b) => a.responseNumber - b.responseNumber)
      .at(-1)

    if (action !== 'cancel' && !latestSubmitted) {
      setActionError({
        code: 'INVALID_TRANSITION',
        message: 'There is no submitted response to review.',
        retryable: false,
      })
      return
    }

    setPending(true)
    setActionError(null)

    const revision = detail.request.revision
    const result =
      action === 'cancel'
        ? await cancelEvidenceRequest({
            requestId,
            cancellationReason: trimmed,
            expectedRequestRevision: revision,
          })
        : action === 'clarify'
          ? await requestEvidenceClarification({
              requestId,
              reviewedResponseId: latestSubmitted!.id,
              reason: trimmed,
              expectedRequestRevision: revision,
            })
          : action === 'resolve'
            ? await resolveEvidenceRequest({
                requestId,
                reviewedResponseId: latestSubmitted!.id,
                resolutionNote: trimmed,
                expectedRequestRevision: revision,
              })
            : await rejectEvidenceResponse({
                requestId,
                reviewedResponseId: latestSubmitted!.id,
                rejectionReason: trimmed,
                expectedRequestRevision: revision,
              })

    setPending(false)

    if (result.ok) {
      // §9.5: the returned authoritative detail REPLACES prior state.
      setState({ kind: 'loaded', detail: result.data })
      setAction(null)
      setNote('')
      return
    }

    setActionError(result.error)
    if (result.error.code === 'CONFLICT') {
      // §5.4: reload the authoritative request and do NOT retry the decision.
      // The confirmation section closes so the action must be chosen again.
      setAction(null)
      setNote('')
      reload()
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="page-wrap ddp-wrap">
        <div className="loading-panel" role="status">Loading request…</div>
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className="page-wrap ddp-wrap">
        <div className="error-panel" role="alert">
          <strong>This request could not be loaded.</strong>
          <p>{state.error.message}</p>
          <button className="btn btn-ghost" onClick={reload}>Retry</button>
          <button className="btn btn-ghost" onClick={onBack}>Back to evidence requests</button>
        </div>
      </div>
    )
  }

  const { detail } = state
  const { request } = detail
  const actions = adminActionsForEvidenceStatus(request.status)
  const noteValid = action !== null && isTrimmedLengthWithin(note, ACTION_LIMITS[action])

  return (
    <div className="page-wrap ddp-wrap" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <button className="btn btn-ghost" onClick={onBack}>← Evidence requests</button>
        <h1 className="page-title">{request.title}</h1>
        <p className="page-desc">{EVIDENCE_REQUEST_STATUS_LABELS[request.status]}</p>
      </div>

      <section className="detail-block">
        <div className="detail-row"><span className="dl">Category</span><span className="dv">{EVIDENCE_REQUEST_CATEGORY_LABELS[request.category]}</span></div>
        <div className="detail-row">
          <span className="dl">Target</span>
          {/* §10.4/§11.4: a lost target does not remove the request from review. */}
          <span className={detail.targetAvailable ? 'dv' : 'dv text-missing'}>
            {detail.targetAvailable ? detail.targetLabel : TARGET_UNAVAILABLE_LABEL}
          </span>
        </div>
        <div className="detail-row"><span className="dl">Priority</span><span className="dv">{EVIDENCE_REQUEST_PRIORITY_LABELS[request.priority]}</span></div>
        <div className="detail-row">
          <span className="dl">Due date</span>
          <span className="dv">
            {request.dueDate ?? '—'}
            {isEvidenceRequestOverdue(request, new Date()) && (
              <span className="text-missing"> (past due)</span>
            )}
          </span>
        </div>
        <div className="detail-row"><span className="dl">Instructions to the farmer</span><span className="dv">{request.explanation}</span></div>
      </section>

      <section className="detail-block">
        <h2>Farmer responses</h2>
        {/* Read-only. There is deliberately no control here to edit farmer text,
            add, replace or remove farmer evidence, or submit on their behalf. */}
        <EvidenceSubmittedThread
          detail={detail}
          onOpenAttachment={a => void openAttachment(a.storageBucket, a.storageObjectPath)}
        />
      </section>

      <section className="detail-block">
        <h2>Review</h2>
        {actions.length === 0 ? (
          <p className="text-muted">
            This request is closed. Closed requests are not reopened — create a new
            request if further evidence is needed.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {actions.map(a => (
                <button
                  key={a}
                  className={action === a ? 'btn btn-primary' : 'btn btn-ghost'}
                  disabled={pending}
                  onClick={() => {
                    setAction(prev => (prev === a ? null : a))
                    setNote('')
                    setActionError(null)
                  }}
                >
                  {ACTION_LABELS[a]}
                </button>
              ))}
            </div>

            {/* §10.4: an explicit confirmation section with a mandatory note.
                No action can be issued from the button row alone. */}
            {action !== null && (
              <div className="confirm-panel" style={{ marginTop: 16 }}>
                <h3>{ACTION_LABELS[action]}</h3>
                <label>
                  <span className="dl">{ACTION_NOTE_LABELS[action]}</span>
                  <textarea
                    rows={4}
                    value={note}
                    disabled={pending}
                    maxLength={ACTION_LIMITS[action].max}
                    onChange={e => setNote(e.target.value)}
                  />
                </label>
                {!noteValid && note !== '' && (
                  <span className="text-missing">
                    Between {ACTION_LIMITS[action].min} and {ACTION_LIMITS[action].max} characters.
                  </span>
                )}
                <p className="text-muted">
                  This records a human review decision on this request only. It makes no
                  compliance, certification or export finding.
                </p>
                <div style={{ display: 'flex', gap: 12 }}>
                  <button
                    className="btn btn-primary"
                    disabled={!noteValid || pending}
                    onClick={() => void runAction()}
                  >
                    {pending ? 'Working…' : `Confirm — ${ACTION_LABELS[action].toLowerCase()}`}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={pending}
                    onClick={() => { setAction(null); setNote('') }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {actionError && (
          <div className="error-panel" role="alert" style={{ marginTop: 16 }}>
            <strong>The action was not applied.</strong>
            <p>{actionError.message}</p>
            {actionError.code === 'CONFLICT' && (
              <p>This request has been reloaded. Review it again before deciding.</p>
            )}
          </div>
        )}
      </section>

      <section className="detail-block">
        <h2>History</h2>
        <EvidenceHistoryList history={detail.history} />
      </section>
    </div>
  )
}
