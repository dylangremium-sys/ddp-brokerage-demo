import { useCallback, useEffect, useMemo, useState } from 'react'
import { runGuardedLoad } from '../../lib/asyncLoadGuard'
import {
  loadFarmerDocuments,
  setDocumentReviewStatus,
  loadDocumentReviewEvents,
  getCoaSignedUrl,
} from '../../lib/db'
import type { FarmerDocument, DocumentReviewStatus, DocumentReviewEvent } from '../../types'

/**
 * Evidence review — the administrator's queue for documents farms have uploaded.
 *
 * WHAT THIS CLOSES. public.farmer_documents, its sha256 index and its RLS were
 * built by migrations 15, 22, 28 and 42 and never read by anything: certificates
 * sat in storage against zero register rows. PR #180 gave the register a write
 * path. This is the read-and-decide half — without it the register accumulates
 * rows nobody looks at, which is only marginally better than not having them.
 *
 * WHAT A DECISION HERE MEANS. Accepting a document records that a named
 * administrator looked at it and was satisfied. `reviewed_by` is set by
 * migration 64's trigger from the session, never from this page, so an operator
 * cannot attribute a decision to a colleague — and the database refuses to leave
 * a decided document unattributed at all.
 *
 * WHAT IT DOES NOT MEAN, and the screen says so rather than leaving it implied:
 * the digest proves the stored bytes are the bytes DDP received. It says nothing
 * about whether the certificate is genuine or whether the laboratory named on it
 * issued it. That is the single easiest false claim in this product to make by
 * accident, and this is the screen where an operator would most naturally make
 * it.
 */

const STATUS_LABEL: Record<DocumentReviewStatus, string> = {
  pending: 'Awaiting review',
  awaiting_clarification: 'Awaiting clarification',
  accepted: 'Accepted',
  rejected: 'Rejected',
}

/**
 * What each decision means, shown next to the control that records it.
 *
 * The awaiting-clarification wording is deliberately restrained. It says the
 * document was examined and that one specific thing is unresolved. It does not
 * say the document is invalid, and it must never be read as a weaker accept.
 */
const STATUS_MEANING: Record<DocumentReviewStatus, string> = {
  pending: 'Not yet reviewed by anyone.',
  awaiting_clarification:
    'The document was reviewed, but its relationship to a specific batch has not been established.',
  accepted: 'A named administrator examined this document and was satisfied by it.',
  rejected: 'A named administrator examined this document and will not rely on it.',
}

/** A note of only whitespace is not a reason. Mirrors the database's test exactly. */
function isBlank(note: string): boolean {
  return !/[^\s]/.test(note ?? '')
}

const TYPE_LABEL: Record<string, string> = {
  coa: 'Certificate of analysis',
  licence: 'Licence',
  photo: 'Photograph',
  other: 'Other',
}

function formatWhen(iso?: string): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}

export default function DDPDocumentReview({ adminNames }: { adminNames?: Map<string, string> }) {
  // null means "no successful load yet" — distinct from [], so an empty queue is
  // never shown before a load has actually succeeded. "Nothing to review" and
  // "we could not find out" are different statements.
  const [docs, setDocs] = useState<FarmerDocument[] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showDecided, setShowDecided] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  // The reason the administrator is about to record, per document. Cleared on a
  // successful decision so the next one starts from an empty box rather than
  // inheriting a justification written for a different decision.
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [history, setHistory] = useState<Record<string, DocumentReviewEvent[]>>({})
  const [historyError, setHistoryError] = useState<Record<string, string>>({})
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let active = true
    // NOT the `void` idiom: runGuardedLoad catches internally and cannot
    // reject, so an explicit no-op catch states that rather than suppressing an
    // unknown. Same choice, and same reason, as DDPAccessRequests.tsx.
    runGuardedLoad(
      loadFarmerDocuments(),
      () => active,
      {
        onSuccess: rows => {
          setDocs(rows)
          setLoadState('ready')
          setLoadError(null)
        },
        onError: err => {
          setLoadState('failed')
          setLoadError(err instanceof Error ? err.message : 'The evidence register could not be loaded.')
        },
      },
    ).catch(() => undefined)
    return () => { active = false }
  }, [reloadToken])

  const refresh = useCallback(() => setReloadToken(t => t + 1), [])

  const loadHistory = useCallback(async (documentId: string) => {
    try {
      const events = await loadDocumentReviewEvents(documentId)
      setHistory(h => ({ ...h, [documentId]: events }))
      setHistoryError(e => ({ ...e, [documentId]: '' }))
    } catch (err) {
      // Surfaced per document rather than swallowed. On an audit trail, "no
      // history" and "we could not read the history" must not look the same.
      setHistoryError(e => ({
        ...e,
        [documentId]: err instanceof Error ? err.message : 'The review history could not be read.',
      }))
    }
  }, [])

  const toggleHistory = useCallback(async (documentId: string) => {
    const nowOpen = !historyOpen[documentId]
    setHistoryOpen(o => ({ ...o, [documentId]: nowOpen }))
    if (nowOpen) await loadHistory(documentId)
  }, [historyOpen, loadHistory])

  const decide = useCallback(async (doc: FarmerDocument, status: DocumentReviewStatus) => {
    const note = notes[doc.id] ?? ''
    if (isBlank(note)) {
      // Enforced in the database too, in a trigger and a constraint. This check
      // exists to say so before a round trip, not instead of one.
      setActionError('Enter the reason for this decision before recording it.')
      return
    }
    setBusyId(doc.id)
    setActionError(null)
    try {
      await setDocumentReviewStatus(doc.id, status, note)
      setNotes(n => ({ ...n, [doc.id]: '' }))
      // Reload rather than patching local state: reviewed_by and reviewed_at are
      // written by a database trigger, so the authoritative values only exist
      // after a read. Patching optimistically here would display a decision with
      // no reviewer — the exact thing migration 64 exists to prevent.
      refresh()
      // The transition just appended an event. If the operator has the history
      // open, refetch it so what they are looking at is not one decision stale.
      if (historyOpen[doc.id]) await loadHistory(doc.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The decision could not be recorded.')
    } finally {
      setBusyId(null)
    }
  }, [notes, refresh, historyOpen, loadHistory])

  const openDocument = useCallback(async (doc: FarmerDocument) => {
    setActionError(null)
    if (!doc.storagePath) {
      setActionError('This register entry has no stored file to open.')
      return
    }
    const url = await getCoaSignedUrl(doc.storagePath)
    if (!url) {
      setActionError('A link to that document could not be generated. It may have been removed from storage.')
      return
    }
    // noopener/noreferrer: the signed URL is a credential for the duration of
    // its life, and must not be handed to an opener via window.opener.
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  // 'awaiting_clarification' stays in the default view alongside 'pending'.
  // Both are UNRESOLVED — the difference is only whether anyone has looked yet.
  // Filing a document away because a decision was recorded would hide the one
  // state that exists precisely to say "this still needs something".
  const visible = useMemo(
    () => (docs ?? []).filter(
      d => showDecided || d.reviewStatus === 'pending' || d.reviewStatus === 'awaiting_clarification',
    ),
    [docs, showDecided],
  )
  const pendingCount = useMemo(
    () => (docs ?? []).filter(d => d.reviewStatus === 'pending').length,
    [docs],
  )
  const clarificationCount = useMemo(
    () => (docs ?? []).filter(d => d.reviewStatus === 'awaiting_clarification').length,
    [docs],
  )

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — EVIDENCE</div>
        <h1 className="page-title">Evidence review</h1>
        <p className="page-desc">
          Documents uploaded by farms, with the fingerprint recorded when each one arrived.
          {loadState === 'ready' && ` ${pendingCount} awaiting review`}
          {loadState === 'ready' && clarificationCount > 0 && `, ${clarificationCount} awaiting clarification`}
          {loadState === 'ready' && '.'}
        </p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>NOTE</span>
        <div>
          The fingerprint shows that a stored file has not changed since DDP received it.
          It does <strong>not</strong> show that the document is genuine, or that the laboratory or
          authority named on it issued it. Accepting a document records only that a named DDP
          administrator examined it and was satisfied — open the file and read it before deciding.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', margin: '16px 0' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={showDecided}
            onChange={e => setShowDecided(e.target.checked)}
          />
          Show documents already decided
        </label>
        <button type="button" onClick={refresh}>Refresh</button>
      </div>

      {actionError && (
        <div role="alert" className="notice notice-error" style={{ marginBottom: 16 }}>
          {actionError}
        </div>
      )}

      {loadState === 'loading' && <p className="muted">Loading the evidence register…</p>}

      {loadState === 'failed' && (
        <div role="alert" className="notice notice-error">
          <strong>The evidence register could not be read.</strong>
          <p style={{ marginBottom: 0 }}>
            {loadError} Nothing is shown below, because an empty list here would say there is
            nothing to review — which is not something this screen currently knows.
          </p>
        </div>
      )}

      {loadState === 'ready' && visible.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          {showDecided
            ? 'No documents have been uploaded yet.'
            : 'Nothing is awaiting review or clarification. Tick “Show documents already decided” to see the rest.'}
        </div>
      )}

      {loadState === 'ready' && visible.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
          {visible.map(doc => (
            <li key={doc.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <strong>{doc.fileName || '(file name not recorded)'}</strong>
                  <div className="muted">
                    {TYPE_LABEL[doc.documentType] ?? doc.documentType}
                    {' · uploaded '}{formatWhen(doc.uploadedAt)}
                  </div>
                </div>
                <div className="muted">{STATUS_LABEL[doc.reviewStatus]}</div>
              </div>

              <div className="muted" style={{ marginTop: 10, fontSize: '0.85em' }}>
                {doc.sha256Hex ? (
                  <>
                    Fingerprint <code style={{ fontFamily: 'monospace' }}>{doc.sha256Hex.slice(0, 16)}…</code>
                    {' recorded '}{formatWhen(doc.sha256RecordedAt)}
                  </>
                ) : (
                  // Said plainly rather than shown as a blank. A register entry
                  // with no digest cannot support an integrity claim, and an
                  // operator deciding on it should know that before they do.
                  <em>No fingerprint was recorded for this entry, so no integrity claim can be made about it.</em>
                )}
              </div>

              {doc.reviewStatus !== 'pending' && (
                <div className="muted" style={{ marginTop: 6, fontSize: '0.85em' }}>
                  {STATUS_LABEL[doc.reviewStatus]} by{' '}
                  {doc.reviewedBy
                    ? (adminNames?.get(doc.reviewedBy) ?? doc.reviewedBy)
                    : 'an unrecorded reviewer'}
                  {' on '}{formatWhen(doc.reviewedAt)}
                  <div style={{ marginTop: 4 }}>{STATUS_MEANING[doc.reviewStatus]}</div>
                  {doc.reviewNote && (
                    <div style={{ marginTop: 4 }}>
                      Reason given: <q>{doc.reviewNote}</q>
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <label htmlFor={`note-${doc.id}`} style={{ display: 'block', fontSize: '0.85em', fontWeight: 600 }}>
                  Reason for your decision (required)
                </label>
                <textarea
                  id={`note-${doc.id}`}
                  rows={2}
                  style={{ width: '100%', marginTop: 4 }}
                  placeholder="State what you checked and what, if anything, is unresolved."
                  value={notes[doc.id] ?? ''}
                  onChange={e => setNotes(n => ({ ...n, [doc.id]: e.target.value }))}
                />
                <div className="muted" style={{ fontSize: '0.8em' }}>
                  Recorded permanently against this document, with your name and the time. Every
                  decision needs one — including returning a document to the queue.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!doc.storagePath}
                  onClick={() => { openDocument(doc).catch(() => undefined) }}
                >
                  Open document
                </button>

                {doc.reviewStatus !== 'accepted' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyId === doc.id || isBlank(notes[doc.id] ?? '')}
                    onClick={() => { decide(doc, 'accepted').catch(() => undefined) }}
                  >
                    {busyId === doc.id ? 'Recording…' : 'Accept'}
                  </button>
                )}

                {doc.reviewStatus !== 'awaiting_clarification' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === doc.id || isBlank(notes[doc.id] ?? '')}
                    // The reasoned non-decision. Before migration 65 an
                    // administrator who could responsibly neither accept nor
                    // reject had no way to record that they had looked at all.
                    title={STATUS_MEANING.awaiting_clarification}
                    onClick={() => { decide(doc, 'awaiting_clarification').catch(() => undefined) }}
                  >
                    {busyId === doc.id ? 'Recording…' : 'Awaiting clarification'}
                  </button>
                )}

                {doc.reviewStatus !== 'rejected' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === doc.id || isBlank(notes[doc.id] ?? '')}
                    onClick={() => { decide(doc, 'rejected').catch(() => undefined) }}
                  >
                    {busyId === doc.id ? 'Recording…' : 'Reject'}
                  </button>
                )}

                {doc.reviewStatus !== 'pending' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === doc.id || isBlank(notes[doc.id] ?? '')}
                    // Returning a document to the queue clears its CURRENT
                    // reviewer, so nobody stays named as responsible for a
                    // decision that no longer stands. It does not erase the
                    // history: migration 65 records the return as its own event,
                    // with its own reason and its own named actor.
                    onClick={() => { decide(doc, 'pending').catch(() => undefined) }}
                  >
                    Return to queue
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { toggleHistory(doc.id).catch(() => undefined) }}
                >
                  {historyOpen[doc.id] ? 'Hide review history' : 'Show review history'}
                </button>
              </div>

              {historyOpen[doc.id] && (
                <div style={{ marginTop: 12, fontSize: '0.85em' }}>
                  {historyError[doc.id] ? (
                    <div role="alert" className="notice notice-error">
                      <strong>The review history could not be read.</strong> {historyError[doc.id]}
                    </div>
                  ) : (history[doc.id] ?? []).length === 0 ? (
                    <p className="muted">No decision has been recorded against this document yet.</p>
                  ) : (
                    <ol style={{ paddingLeft: 18, display: 'grid', gap: 6 }}>
                      {(history[doc.id] ?? []).map(ev => (
                        <li key={ev.id}>
                          <strong>{STATUS_LABEL[ev.newStatus]}</strong>
                          {' — from '}{STATUS_LABEL[ev.previousStatus]}
                          {' by '}
                          {adminNames?.get(ev.reviewedBy) ?? ev.reviewedBy}
                          {' on '}{formatWhen(ev.reviewedAt)}
                          <div className="muted"><q>{ev.reviewNote}</q></div>
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
                    This history is append-only. It cannot be edited or deleted by anyone,
                    administrators included.
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
