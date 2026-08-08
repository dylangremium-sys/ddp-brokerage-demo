import { useCallback, useEffect, useMemo, useState } from 'react'
import { runGuardedLoad } from '../../lib/asyncLoadGuard'
import {
  loadFarmerDocuments,
  setDocumentReviewStatus,
  getCoaSignedUrl,
} from '../../lib/db'
import type { FarmerDocument, DocumentReviewStatus } from '../../types'

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
  accepted: 'Accepted',
  rejected: 'Rejected',
}

const TYPE_LABEL: Record<string, string> = {
  coa: 'Certificate of analysis',
  licence: 'Licence',
  photo: 'Photograph',
  other: 'Other',
}

function formatWhen(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
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

  useEffect(() => {
    let active = true
    void runGuardedLoad(
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
    )
    return () => { active = false }
  }, [reloadToken])

  const refresh = useCallback(() => setReloadToken(t => t + 1), [])

  const decide = useCallback(async (doc: FarmerDocument, status: DocumentReviewStatus) => {
    setBusyId(doc.id)
    setActionError(null)
    try {
      await setDocumentReviewStatus(doc.id, status)
      // Reload rather than patching local state: reviewed_by and reviewed_at are
      // written by a database trigger, so the authoritative values only exist
      // after a read. Patching optimistically here would display a decision with
      // no reviewer — the exact thing migration 64 exists to prevent.
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The decision could not be recorded.')
    } finally {
      setBusyId(null)
    }
  }, [refresh])

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

  const visible = useMemo(
    () => (docs ?? []).filter(d => showDecided || d.reviewStatus === 'pending'),
    [docs, showDecided],
  )
  const pendingCount = useMemo(
    () => (docs ?? []).filter(d => d.reviewStatus === 'pending').length,
    [docs],
  )

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — EVIDENCE</div>
        <h1 className="page-title">Evidence review</h1>
        <p className="page-desc">
          Documents uploaded by farms, with the fingerprint recorded when each one arrived.
          {loadState === 'ready' && ` ${pendingCount} awaiting review.`}
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
            : 'No documents are awaiting review. Tick “Show documents already decided” to see the rest.'}
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
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!doc.storagePath}
                  onClick={() => { void openDocument(doc) }}
                >
                  Open document
                </button>

                {doc.reviewStatus !== 'accepted' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyId === doc.id}
                    onClick={() => { void decide(doc, 'accepted') }}
                  >
                    {busyId === doc.id ? 'Recording…' : 'Accept'}
                  </button>
                )}

                {doc.reviewStatus !== 'rejected' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === doc.id}
                    onClick={() => { void decide(doc, 'rejected') }}
                  >
                    {busyId === doc.id ? 'Recording…' : 'Reject'}
                  </button>
                )}

                {doc.reviewStatus !== 'pending' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === doc.id}
                    // Returning a document to the queue clears its reviewer, so
                    // nobody stays named as responsible for a decision that no
                    // longer stands. Migration 64's trigger does that clearing.
                    onClick={() => { void decide(doc, 'pending') }}
                  >
                    Return to queue
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
