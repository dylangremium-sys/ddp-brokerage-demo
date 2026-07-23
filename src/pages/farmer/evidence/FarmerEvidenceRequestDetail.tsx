import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EVIDENCE_MAX_READY_ATTACHMENTS_PER_RESPONSE,
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_STATUS_LABELS,
  EVIDENCE_TEXT_LIMITS,
  TARGET_UNAVAILABLE_LABEL,
  canSubmitEvidenceResponse,
  isActiveEvidenceAttachment,
  isFarmerActionableEvidenceRequestStatus,
  type EvidenceRequestDetail,
  type EvidenceResponseDraft,
  type EvidenceServiceError,
} from '../../../domain/evidenceRequests'
import {
  finalizeEvidenceAttachment,
  getEvidenceAttachmentSignedUrl,
  getEvidenceRequest,
  getOrCreateEvidenceResponseDraft,
  linkExistingEvidenceDocument,
  listLinkableEvidenceDocuments,
  removeDraftEvidenceAttachment,
  reserveEvidenceAttachment,
  saveEvidenceResponseDraft,
  submitEvidenceResponse,
  uploadReservedEvidenceObject,
  type LinkableEvidenceDocument,
} from '../../../lib/evidenceRequests'
import { evidenceLoadScopeKey } from '../../../lib/evidenceRequestRoutes'
import { runGuardedLoad } from '../../../lib/asyncLoadGuard'
import { useEvidenceScopeReset } from '../../../lib/useEvidenceScopeReset'
import { sha256Hex, validateEvidenceUploadCandidate } from '../../../lib/evidenceRequestStorage'
import {
  EvidenceAttachmentList,
  EvidenceHistoryList,
  EvidenceSubmittedThread,
} from '../../../components/shared/EvidenceThread'

/**
 * Farmer detail and response page (contract v1.5 §10.6).
 *
 * Editable ONLY when the request is `open` or `clarification_requested`.
 * Read-only in `farmer_submitted`, `resolved`, `rejected` and `cancelled` — and
 * read-only means no draft controls are rendered at all, not merely disabled
 * ones (§10.6, §6.3 "Submitted response: fully immutable").
 *
 * The upload sequence follows §7.4 exactly: reserve -> upload to the reserved
 * path -> compute SHA-256 over the bytes actually uploaded -> finalize. A failed
 * upload leaves the attachment `pending_upload`, and `submit_evidence_response`
 * refuses a response with any pending upload, so a failed upload can never
 * become submitted evidence.
 *
 * Client-side format and size checks (§7.3) exist so a farmer is told
 * immediately. They are NOT the boundary — the reserve and finalize RPCs
 * re-validate MIME, extension and size server-side (§17.13).
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; detail: EvidenceRequestDetail }
  | { kind: 'failed'; error: EvidenceServiceError }

export default function FarmerEvidenceRequestDetail({
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
  const [draft, setDraft] = useState<EvidenceResponseDraft | null>(null)
  const [draftText, setDraftText] = useState('')
  const [busy, setBusy] = useState<null | string>(null)
  const [error, setError] = useState<EvidenceServiceError | null>(null)
  const [linkable, setLinkable] = useState<LinkableEvidenceDocument[] | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const scopeKey = evidenceLoadScopeKey({
    userId: currentUserId,
    role: currentRole,
    route: { page: 'farmer-evidence-request-detail', requestId },
  })
  const activeScopeRef = useRef(scopeKey)

  // §9.7: clear every piece of protected state during render, before a new
  // scope loads — including the draft body and any linkable-document list,
  // which are farm-scoped and must not survive an account change.
  useEvidenceScopeReset(scopeKey, () => {
    setState({ kind: 'loading' })
    setDraft(null)
    setDraftText('')
    setLinkable(null)
    setError(null)
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

  /** Re-reads the authoritative detail after any mutation (§9.5). */
  async function refreshDetail() {
    const result = await getEvidenceRequest(requestId)
    if (activeScopeRef.current !== scopeKey) return
    if (result.ok) setState({ kind: 'loaded', detail: result.data })
    else setState({ kind: 'failed', error: result.error })
  }

  async function startDraft() {
    if (state.kind !== 'loaded' || busy) return
    setBusy('draft')
    setError(null)
    const result = await getOrCreateEvidenceResponseDraft({
      requestId,
      expectedRequestRevision: state.detail.request.revision,
    })
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      // A stale revision means the request moved underneath us (§5.4).
      if (result.error.code === 'CONFLICT') reload()
      return
    }
    setDraft(result.data)
    setDraftText(result.data.response.responseText ?? '')
  }

  async function saveDraft() {
    if (!draft || busy) return
    setBusy('save')
    setError(null)
    const result = await saveEvidenceResponseDraft({
      requestId,
      responseId: draft.response.id,
      responseText: draftText,
    })
    setBusy(null)
    if (result.ok) setDraft(result.data)
    else setError(result.error)
  }

  async function addUpload(file: File) {
    if (state.kind !== 'loaded' || !draft || busy) return
    const category = state.detail.request.category

    // §7.3 pre-flight, mirroring the database. The RPCs re-check everything.
    const check = validateEvidenceUploadCandidate({
      category,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    })
    if (!check.ok) {
      setError({ code: check.code, message: check.message, retryable: false })
      return
    }

    setBusy('upload')
    setError(null)

    const reservation = await reserveEvidenceAttachment({
      requestId,
      responseId: draft.response.id,
      originalFilename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    })
    if (!reservation.ok) {
      setBusy(null)
      setError(reservation.error)
      return
    }

    const upload = await uploadReservedEvidenceObject({
      bucket: reservation.data.storageBucket,
      path: reservation.data.storageObjectPath,
      file,
      contentType: file.type,
    })
    if (!upload.ok) {
      setBusy(null)
      // The reservation stays `pending_upload`; submission will refuse it until
      // it is finalized or removed. Nothing partial becomes evidence (§7.4).
      setError(upload.error)
      await refreshDraft()
      return
    }

    // §7.4 step 5: the digest is computed over the exact bytes uploaded. This is
    // an integrity digest, NOT a malware scan — no scanning claim is made.
    const digest = await sha256Hex(await file.arrayBuffer())

    const finalize = await finalizeEvidenceAttachment({
      requestId,
      responseId: draft.response.id,
      attachmentId: reservation.data.attachment.id,
      sha256Hex: digest,
      actualSizeBytes: file.size,
      actualMimeType: file.type,
    })
    setBusy(null)
    if (!finalize.ok) setError(finalize.error)
    // A finalized upload writes an `attachment_uploaded` history event (§12.1),
    // so the authoritative detail is re-read too, not just the draft.
    await Promise.all([refreshDraft(), refreshDetail()])
  }

  async function refreshDraft() {
    if (state.kind !== 'loaded') return
    const result = await getOrCreateEvidenceResponseDraft({
      requestId,
      expectedRequestRevision: state.detail.request.revision,
    })
    if (result.ok) setDraft(result.data)
  }

  async function removeAttachment(attachmentId: string, path: string | null) {
    if (!draft || busy) return
    setBusy('remove')
    setError(null)
    const result = await removeDraftEvidenceAttachment({
      requestId,
      responseId: draft.response.id,
      attachmentId,
      storageObjectPath: path,
    })
    setBusy(null)
    if (!result.ok) setError(result.error)
    await refreshDraft()
  }

  async function loadLinkable() {
    if (state.kind !== 'loaded') return
    const { request } = state.detail
    const result = await listLinkableEvidenceDocuments({
      farmId: request.farmId,
      category: request.category,
      inventoryBatchId:
        request.target.type === 'inventory_batch' ? request.target.inventoryBatchId : null,
    })
    // A failed lookup is reported, never shown as "no documents" (§9.6).
    if (result.ok) setLinkable(result.data)
    else setError(result.error)
  }

  async function linkDocument(document: LinkableEvidenceDocument) {
    if (!draft || busy) return
    setBusy('link')
    setError(null)
    const result = await linkExistingEvidenceDocument({
      requestId,
      responseId: draft.response.id,
      origin: document.origin,
      ...(document.origin === 'existing_farm_document'
        ? { farmerDocumentId: document.id }
        : { inventoryDocumentId: document.id }),
    })
    setBusy(null)
    if (!result.ok) setError(result.error)
    // Linking writes an `existing_document_linked` history event (§12.1).
    await Promise.all([refreshDraft(), refreshDetail()])
  }

  async function submit() {
    if (state.kind !== 'loaded' || !draft || busy) return
    setBusy('submit')
    setError(null)
    const result = await submitEvidenceResponse({
      requestId,
      responseId: draft.response.id,
      expectedRequestRevision: state.detail.request.revision,
    })
    setBusy(null)
    if (result.ok) {
      setState({ kind: 'loaded', detail: result.data })
      setDraft(null)
      setDraftText('')
      return
    }
    setError(result.error)
    if (result.error.code === 'CONFLICT') reload()
  }

  async function openAttachment(bucket: string | null, path: string | null) {
    if (!bucket || !path) return
    const result = await getEvidenceAttachmentSignedUrl({ bucket, path })
    if (result.ok) window.open(result.data, '_blank', 'noopener,noreferrer')
    else setError(result.error)
  }

  if (state.kind === 'loading') {
    return (
      <div className="page-wrap" style={{ maxWidth: 680 }}>
        <div className="loading-panel" role="status">Loading request…</div>
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className="page-wrap" style={{ maxWidth: 680 }}>
        <div className="error-panel" role="alert">
          <strong>This request could not be loaded.</strong>
          <p>{state.error.message}</p>
          <button className="btn btn-ghost" onClick={reload}>Retry</button>
          <button className="btn btn-ghost" onClick={onBack}>Back to requests</button>
        </div>
      </div>
    )
  }

  const { detail } = state
  const { request } = detail
  const editable = isFarmerActionableEvidenceRequestStatus(request.status)

  // §10.6 clarification display: the administrator's reason must be prominent.
  const latestClarification = [...detail.history]
    .filter(e => e.eventType === 'clarification_requested')
    .at(-1)

  const liveDraftAttachments = draft?.attachments.filter(a => a.removalRequestedAt === null) ?? []
  const readyCount = liveDraftAttachments.filter(isActiveEvidenceAttachment).length
  const canAddMore = readyCount < EVIDENCE_MAX_READY_ATTACHMENTS_PER_RESPONSE

  return (
    <div className="page-wrap" style={{ maxWidth: 680 }}>
      <div className="page-header farmer-header">
        <button className="btn btn-ghost" onClick={onBack}>← Requests</button>
        <h1 className="page-title">{request.title}</h1>
        <p className="page-desc">{EVIDENCE_REQUEST_STATUS_LABELS[request.status]}</p>
      </div>

      {request.status === 'clarification_requested' && latestClarification?.note && (
        <div className="notice-panel" role="status">
          <strong>DDP has asked for clarification.</strong>
          <p>{latestClarification.note}</p>
        </div>
      )}

      <section className="detail-block">
        <div className="detail-row"><span className="dl">Category</span><span className="dv">{EVIDENCE_REQUEST_CATEGORY_LABELS[request.category]}</span></div>
        <div className="detail-row">
          <span className="dl">Concerns</span>
          <span className={detail.targetAvailable ? 'dv' : 'dv text-missing'}>
            {detail.targetAvailable ? detail.targetLabel : TARGET_UNAVAILABLE_LABEL}
          </span>
        </div>
        <div className="detail-row"><span className="dl">Due date</span><span className="dv">{request.dueDate ?? '—'}</span></div>
        <div className="detail-row"><span className="dl">What DDP needs</span><span className="dv">{request.explanation}</span></div>
      </section>

      <section className="detail-block">
        <h2>Your previous responses</h2>
        {/* Submitted responses and their evidence remain visible and immutable
            after clarification, rejection, resolution or cancellation (§6.3). */}
        <EvidenceSubmittedThread
          detail={detail}
          onOpenAttachment={a => void openAttachment(a.storageBucket, a.storageObjectPath)}
        />
      </section>

      {editable ? (
        <section className="detail-block">
          <h2>{request.status === 'clarification_requested' ? 'New response' : 'Your response'}</h2>

          {!draft ? (
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => void startDraft()}>
              {busy === 'draft' ? 'Preparing…' : 'Start a response'}
            </button>
          ) : (
            <>
              <label>
                <span className="dl">Your explanation</span>
                <textarea
                  rows={5}
                  value={draftText}
                  disabled={busy !== null}
                  maxLength={EVIDENCE_TEXT_LIMITS.responseText.max}
                  onChange={e => setDraftText(e.target.value)}
                  onBlur={() => void saveDraft()}
                />
              </label>
              <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void saveDraft()}>
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </button>

              <h3>Evidence attached to this response</h3>
              <EvidenceAttachmentList
                attachments={liveDraftAttachments}
                onOpen={a => void openAttachment(a.storageBucket, a.storageObjectPath)}
              />

              {/* A pending upload is shown explicitly so the farmer understands
                  why submission is blocked, rather than a silently disabled button. */}
              {liveDraftAttachments.some(
                a => a.origin === 'request_upload' && a.uploadState === 'pending_upload',
              ) && (
                <p className="text-missing">
                  An upload did not finish. Remove it or try again before submitting.
                </p>
              )}

              <ul className="evidence-draft-controls">
                {liveDraftAttachments.map(a => (
                  <li key={a.id}>
                    {a.originalFilename}
                    <button
                      className="btn btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void removeAttachment(a.id, a.storageObjectPath)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>

              {canAddMore ? (
                <label>
                  <span className="dl">Upload evidence</span>
                  <input
                    type="file"
                    disabled={busy !== null}
                    onChange={e => {
                      const file = e.target.files?.[0]
                      // Reset so re-selecting the same file fires change again.
                      e.target.value = ''
                      if (file) void addUpload(file)
                    }}
                  />
                </label>
              ) : (
                <p className="text-muted">
                  A response can carry at most {EVIDENCE_MAX_READY_ATTACHMENTS_PER_RESPONSE} files.
                </p>
              )}

              <div>
                <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void loadLinkable()}>
                  Link a document you already uploaded
                </button>
                {linkable !== null && linkable.length === 0 && (
                  <p className="text-muted">No existing documents can be linked to this request.</p>
                )}
                {linkable !== null && linkable.length > 0 && (
                  <ul>
                    {linkable.map(doc => (
                      <li key={`${doc.origin}:${doc.id}`}>
                        {doc.label}
                        <button
                          className="btn btn-ghost"
                          disabled={busy !== null}
                          onClick={() => void linkDocument(doc)}
                        >
                          Link
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || !canSubmitEvidenceResponse(draft)}
                  onClick={() => void submit()}
                >
                  {busy === 'submit' ? 'Submitting…' : 'Submit for review'}
                </button>
                {!canSubmitEvidenceResponse(draft) && (
                  <p className="text-muted">
                    Add an explanation or at least one file before submitting.
                  </p>
                )}
                <p className="text-muted">
                  A DDP reviewer will look at this. Submitting does not approve anything.
                </p>
              </div>
            </>
          )}
        </section>
      ) : (
        <section className="detail-block">
          <p className="text-muted">
            {request.status === 'farmer_submitted'
              ? 'Your response has been submitted and is awaiting human review. It cannot be changed.'
              : 'This request is closed. Your submitted evidence is kept and cannot be changed.'}
          </p>
        </section>
      )}

      {error && (
        <div className="error-panel" role="alert">
          <strong>That did not work.</strong>
          <p>{error.message}</p>
          {error.code === 'CONFLICT' && <p>This request has been reloaded. Check it and try again.</p>}
        </div>
      )}

      <section className="detail-block">
        <h2>History</h2>
        <EvidenceHistoryList history={detail.history} />
      </section>
    </div>
  )
}
