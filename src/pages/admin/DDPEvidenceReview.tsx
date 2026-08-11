import { useCallback, useEffect, useMemo, useState } from 'react'
import { runGuardedLoad } from '../../lib/asyncLoadGuard'
import {
  loadFarmerDocuments, setDocumentReviewStatus, loadDocumentReviewEvents,
  getCoaSignedUrl, recordDocumentOpen, loadMyDocumentOpens, createReviewRequest,
} from '../../lib/db'
import {
  loadReviewerDirectory, reviewerLabel, reviewerRole,
  type ReviewerDirectory,
} from '../../lib/reviewerDirectory'
import { isSubstantiveReason, resolveEvidenceGate } from '../../lib/evidenceGate'
import { formatDate } from '../../lib/formatDate'
import type {
  DocumentReviewEvent, DocumentReviewStatus, FarmerDocument, InventoryItem,
} from '../../types'
import '../../styles/evidenceReview.css'

/**
 * Evidence review — handoff screen 5.
 *
 * THIS SCREEN IS THE CHAIN OF CUSTODY. A regulator or a buyer's compliance
 * officer will one day ask who looked at this document, what they checked, when,
 * and what they concluded. Every decision below exists to make that answerable,
 * and where appearance and the record disagreed, the record won.
 *
 * WHAT THE GATE IS. Accept and Reject unlock only when the document has been
 * opened — recorded in farmer_document_opens, not merely clicked — and a reason
 * of substance has been written. Both are enforced by a trigger (migration 66),
 * so a decision arriving from psql, the REST endpoint or a future screen is
 * refused the same way. The disabled buttons explain the refusal before the
 * round trip; they are not the refusal.
 *
 * TWO THINGS THIS SCREEN REFUSES TO SAY.
 *
 * It does not claim the document is genuine. The fingerprint proves the stored
 * bytes are the bytes DDP received and nothing more, and the screen says that
 * in those words rather than letting "verified" do quiet work.
 *
 * It does not report reading progress. The prototype showed "Opened · page 1 of
 * 4 read"; a PDF in a frame reports nothing about pages read, so that number
 * could only have been invented. On the screen that constitutes chain of
 * custody, a fabricated claim is worse than a smaller true one — so it shows
 * "Opened · 12:31", which comes from the record. True page tracking needs a
 * PDF renderer and is deliberately not bundled in here.
 */

const STATUS_LABEL: Record<DocumentReviewStatus, string> = {
  pending: 'Awaiting review',
  awaiting_clarification: 'Awaiting clarification',
  accepted: 'Accepted',
  rejected: 'Rejected',
}

const STATUS_MEANING: Record<DocumentReviewStatus, string> = {
  pending: 'Not yet reviewed by anyone.',
  awaiting_clarification:
    'The document was reviewed, but its relationship to a specific batch has not been established.',
  accepted: 'A named administrator examined this document and was satisfied by it.',
  rejected: 'A named administrator examined this document and will not rely on it.',
}

/**
 * What the farm is told, wrapping the reviewer's verbatim reason.
 *
 * English only for now, and that is a gap rather than a decision: the farmer's
 * own screens localise through T[lang], but a request created here is stored as
 * one string and read by whoever opens it. Localising the wrapper properly means
 * storing the kind and rendering it on the farmer's side — worth doing, and not
 * bundled into this change.
 */
const REJECTED_PREFIX =
  'DDP has reviewed a document you sent and will not rely on it. The reviewer wrote:'
const RETURNED_PREFIX =
  'DDP has returned a document you sent to its review queue. The reviewer wrote:'

const TYPE_LABEL: Record<string, string> = {
  coa: 'Certificate of analysis',
  licence: 'Licence',
  photo: 'Photograph',
  other: 'Other',
}

/** Standing rule 9: 8 Aug 2026, 12:30 — never 08/08/2026, 12:30:08. */
function when(iso?: string | null): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '—'
  return `${formatDate(iso, 'en')}, ${parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/** Just the clock, for "Opened · 12:31". */
function atTime(iso?: string | null): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/**
 * A human title for the record.
 *
 * The live screen titles this with the raw upload filename —
 * "602918346421698884_RP-E2602-0197_EX26-0191_Calli Krush Co.,LTD (1).pdf".
 * A filename is a fact about a file, not a name for a record. The type and the
 * laboratory are what a reviewer is actually looking at, and the filename stays
 * directly beneath as metadata, in mono, where it can still be searched for.
 */
function recordTitle(doc: FarmerDocument): string {
  const kind = TYPE_LABEL[doc.documentType] ?? doc.documentType
  const who = (doc.labName ?? '').trim()
  // Omitted entirely rather than joined to an em dash: a separator with nothing
  // after it is the shape of missing data, not a title.
  return who ? `${kind} · ${who}` : kind
}

export default function DDPEvidenceReview({ inventory = [] }: { inventory?: InventoryItem[] }) {
  const [docs, setDocs] = useState<FarmerDocument[] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [directory, setDirectory] = useState<ReviewerDirectory | null>(null)
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set())
  const [openedAt, setOpenedAt] = useState<Record<string, string>>({})
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [showFullHash, setShowFullHash] = useState(false)
  const [history, setHistory] = useState<DocumentReviewEvent[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    let active = true
    runGuardedLoad(loadFarmerDocuments(), () => active, {
      onSuccess: rows => { setDocs(rows); setLoadState('ready'); setLoadError(null) },
      onError: err => {
        setLoadState('failed')
        setLoadError(err instanceof Error ? err.message : 'The evidence register could not be loaded.')
      },
    }).catch(() => undefined)
    return () => { active = false }
  }, [reloadToken])

  // The directory and the opens are loaded once. A reviewer who reopens this
  // screen mid-task has already opened the document; the record says so, and
  // asking them to read it again would be the screen disbelieving its own log.
  useEffect(() => {
    let active = true
    loadReviewerDirectory().then(d => { if (active) setDirectory(d) }).catch(() => undefined)
    loadMyDocumentOpens().then(s => { if (active) setOpenedIds(s) }).catch(() => undefined)
    return () => { active = false }
  }, [reloadToken])

  const queue = useMemo(
    () => (docs ?? []).filter(d => d.reviewStatus === 'pending' || d.reviewStatus === 'awaiting_clarification'),
    [docs],
  )
  const selected = useMemo(
    () => (docs ?? []).find(d => d.id === selectedId) ?? queue[0] ?? (docs ?? [])[0] ?? null,
    [docs, queue, selectedId],
  )

  const gate = resolveEvidenceGate({
    hasStoredFile: Boolean(selected?.storagePath),
    opened: selected ? openedIds.has(selected.id) : false,
    reason,
    recording: busyId === selected?.id,
  })

  /** The batch this document is filed against, for the discrepancy row. */
  const attachedBatch = useMemo(() => {
    if (!selected?.batchId) return null
    return inventory.find(i => i.id === selected.batchId) ?? null
  }, [selected, inventory])

  const openDocument = useCallback(async (doc: FarmerDocument) => {
    setActionError(null)
    if (!doc.storagePath) { setActionError('This register entry has no stored file to open.'); return }
    const url = await getCoaSignedUrl(doc.storagePath)
    if (!url) {
      setActionError('A link to that document could not be generated. It may have been removed from storage.')
      return
    }
    // Recorded only after the URL resolved: a failed signing attempt must not
    // unlock a decision. The write is awaited because migration 66 refuses the
    // decision without it — an open that silently failed would present a live
    // Accept button that the database then rejects.
    try {
      await recordDocumentOpen(doc.id, doc.sha256Hex ?? null)
    } catch (err) {
      setActionError(
        `The document opened, but the record of you opening it could not be written, so a decision will be refused. ${
          err instanceof Error ? err.message : ''}`.trim(),
      )
      return
    }
    setPreviewUrl(url)
    setOpenedIds(prev => new Set(prev).add(doc.id))
    setOpenedAt(prev => ({ ...prev, [doc.id]: new Date().toISOString() }))
  }, [])

  const decide = useCallback(async (doc: FarmerDocument, status: DocumentReviewStatus) => {
    if (!isSubstantiveReason(reason)) {
      setActionError('Write what you checked before recording a decision.')
      return
    }
    setBusyId(doc.id)
    setActionError(null)
    try {
      await setDocumentReviewStatus(doc.id, status, reason)

      // The farm learns of a refusal, through the same path the Operations Desk
      // chases them by — a farm-scoped request that appears on their own
      // "Requests from DDP" screen.
      //
      // TWO DELIBERATE CHOICES.
      //
      // The wrapper is localised; the REASON IS NOT. A reviewer's reason is the
      // verbatim contents of an immutable record. Machine-translating it would
      // put a second, differently-worded version of that record in front of the
      // farm, and only one of the two could be the one that was recorded.
      //
      // 'awaiting_clarification' is NOT notified here: the farm already sees
      // that state on its own evidence screen, and sending a request as well
      // would tell them the same thing twice through two different channels.
      if ((status === 'rejected' || status === 'pending') && doc.farmId) {
        try {
          await createReviewRequest({
            farmProfileId: doc.farmId,
            requestType: 'coa',
            message: `${status === 'rejected' ? REJECTED_PREFIX : RETURNED_PREFIX}\n\n${reason}`,
            status: 'open',
            createdBy: '',
          })
        } catch {
          // The decision is recorded and stands. Say the notification failed
          // rather than implying the farm has been told.
          setActionError(
            'The decision was recorded, but the farm could not be notified. Tell them another way.',
          )
        }
      }

      setReason('')
      setReloadToken(t => t + 1)
      setHistory(null)
    } catch (err) {
      // The database refuses with its own words. Showing them beats a generic
      // failure: "this document has not been opened by you" tells the reviewer
      // what to do, and proves the gate is not merely the button.
      setActionError(err instanceof Error ? err.message : 'The decision could not be recorded.')
    } finally {
      setBusyId(null)
    }
  }, [reason])

  const toggleHistory = useCallback(async () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (!next || !selected) return
    try {
      setHistory(await loadDocumentReviewEvents(selected.id))
      setHistoryError(null)
    } catch (err) {
      // "No history" and "we could not read the history" must not look the same
      // on an audit trail.
      setHistoryError(err instanceof Error ? err.message : 'The review history could not be read.')
    }
  }, [historyOpen, selected])

  if (loadState === 'loading') {
    return <div className="organic-scope"><div className="ev"><p className="ev-muted">Loading the evidence register…</p></div></div>
  }

  if (loadState === 'failed') {
    return (
      <div className="organic-scope"><div className="ev">
        <div role="alert" className="ev-alert">
          <strong>The evidence register could not be read.</strong>
          <p>{loadError} Nothing is shown, because an empty list here would say there is nothing to
            review — which is not something this screen currently knows.</p>
        </div>
      </div></div>
    )
  }

  if (!selected) {
    return (
      <div className="organic-scope"><div className="ev">
        <p className="ev-muted">
          Nothing is awaiting review. That is the healthy state, not a missing feed.
        </p>
      </div></div>
    )
  }

  const opened = openedIds.has(selected.id)
  const sampleName = (selected.sampleName ?? '').trim()
  const batchLabel = attachedBatch
    ? `${attachedBatch.productName}${attachedBatch.batchNumber ? ` · ${attachedBatch.batchNumber}` : ''}`
    : null
  const discrepancy = Boolean(sampleName && batchLabel && !batchLabel.toLowerCase().includes(sampleName.toLowerCase()))

  return (
    <div className="organic-scope">
      <div className="ev">
        {/* ── Header ────────────────────────────────────────────────────────── */}
        <header className="ev-head">
          <div className="ev-head-text">
            <p className="ev-eyebrow">
              Evidence · {queue.length} awaiting {queue.length === 1 ? 'a decision' : 'decisions'}
            </p>
            <h1 className="ev-title">{recordTitle(selected)}</h1>
            {/* The filename is metadata, not the name of the record. */}
            <p className="ev-filename">{selected.fileName || 'no file name recorded'}</p>
          </div>
          <span className={`tag ${selected.reviewStatus === 'pending' ? 'tag-neutral' : 'tag-accent'}`}>
            {STATUS_LABEL[selected.reviewStatus]}
          </span>
        </header>

        <div className="ev-grid">
          {/* ── The document leads ──────────────────────────────────────────── */}
          <section className="ev-preview">
            <div className="ev-preview-body">
              {opened && previewUrl ? (
                <iframe className="ev-frame" src={previewUrl} title={recordTitle(selected)} />
              ) : (
                <div className="ev-preview-empty">
                  {opened ? (
                    <p className="ev-muted">
                      You opened this document at {atTime(openedAt[selected.id])}. Open it again to read it now.
                    </p>
                  ) : (
                    <p className="ev-muted">The document has not been opened.</p>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!selected.storagePath}
                    onClick={() => { openDocument(selected).catch(() => undefined) }}
                  >
                    {opened ? 'Open the document again' : 'Open and read the document'}
                  </button>
                </div>
              )}
            </div>

            {opened && (
              <p className="ev-opened">Opened · {atTime(openedAt[selected.id])}</p>
            )}

            <div className="ev-preview-foot">
              {selected.sha256Hex ? (
                <span>
                  Fingerprint{' '}
                  <code>{showFullHash ? selected.sha256Hex : `${selected.sha256Hex.slice(0, 16)}…`}</code>
                  <button type="button" className="ev-link" onClick={() => setShowFullHash(v => !v)}>
                    {showFullHash ? 'Hide' : 'Show full hash'}
                  </button>
                </span>
              ) : (
                <em>No fingerprint was recorded, so no integrity claim can be made about this entry.</em>
              )}
              <button type="button" className="ev-link" onClick={() => { toggleHistory().catch(() => undefined) }}>
                {historyOpen ? 'Hide review history' : 'Review history'}
              </button>
            </div>

            {historyOpen && (
              <div className="ev-history">
                {historyError && <p role="alert" className="ev-alert-inline">{historyError}</p>}
                {history && history.length === 0 && <p className="ev-muted">No decision has been recorded yet.</p>}
                {history?.map(ev => (
                  <div className="ev-history-row" key={ev.id}>
                    <span>
                      <strong>{STATUS_LABEL[ev.newStatus]}</strong> by {reviewerLabel(ev.reviewedBy, directory)}
                    </span>
                    <span className="ev-stamp">{when(ev.reviewedAt)}</span>
                    {ev.reviewNote && <q className="ev-quote">{ev.reviewNote}</q>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="ev-rail">
            {/* ── What this document is ─────────────────────────────────────── */}
            <section className="ev-card">
              <h2 className="ev-card-head">What this document is</h2>
              <Fact label="Document type" value={TYPE_LABEL[selected.documentType] ?? selected.documentType} />
              <Fact label="Laboratory" value={selected.labName} />
              <Fact label="Report number" value={selected.reportNumber} mono />
              <Fact label="Sample named on report" value={selected.sampleName} />
              <Fact label="Attached batch" value={batchLabel} mono />
              <Fact label="Received" value={when(selected.uploadedAt)} />
              {selected.reviewStatus !== 'pending' && (
                <Fact
                  label={STATUS_LABEL[selected.reviewStatus]}
                  hint={STATUS_MEANING[selected.reviewStatus]}
                  value={`${reviewerLabel(selected.reviewedBy, directory)}${
                    reviewerRole(selected.reviewedBy, directory) ? `, ${reviewerRole(selected.reviewedBy, directory)}` : ''
                  } · ${when(selected.reviewedAt)}`}
                />
              )}
            </section>

            {/* ── The reason it is in the queue ──────────────────────────────── */}
            {discrepancy && (
              <section className="ev-question">
                <p className="ev-question-label">The open question</p>
                <p className="ev-question-body">
                  The report names its sample <strong>{sampleName}</strong>, but this document is filed
                  against <strong>{batchLabel}</strong>. Until that is explained, the certificate cannot be
                  said to describe the batch it is attached to.
                </p>
                <p className="ev-caveat">
                  The fingerprint proves the stored file has not changed since DDP received it. It does not
                  show the document is genuine, or that the laboratory named on it issued it.
                </p>
              </section>
            )}

            {/* ── Decision ──────────────────────────────────────────────────── */}
            <section className="ev-card">
              <h2 className="ev-card-head">Your decision</h2>
              <label htmlFor="ev-reason" className="ev-label">Reason for your decision (required)</label>
              <textarea
                id="ev-reason"
                className="ev-textarea"
                rows={3}
                placeholder="State what you checked and what, if anything, is unresolved."
                value={reason}
                onChange={e => setReason(e.target.value)}
              />

              {/* Equal weight, side by side: neither is the default. */}
              <div className="ev-decide">
                <button
                  type="button"
                  className="ev-accept"
                  disabled={!gate.allowed}
                  onClick={() => { decide(selected, 'accepted').catch(() => undefined) }}
                >
                  {busyId === selected.id ? 'Recording…' : 'Accept'}
                </button>
                <button
                  type="button"
                  className="ev-reject"
                  disabled={!gate.allowed}
                  onClick={() => { decide(selected, 'rejected').catch(() => undefined) }}
                >
                  {busyId === selected.id ? 'Recording…' : 'Reject'}
                </button>
              </div>

              <p className="ev-gate" aria-live="polite">{gate.note}</p>

              {actionError && <p role="alert" className="ev-alert-inline">{actionError}</p>}

              {/* Demoted to text: the two decisions above are the point. */}
              <div className="ev-links">
                {selected.reviewStatus !== 'pending' && (
                  <button type="button" className="ev-link" onClick={() => { decide(selected, 'pending').catch(() => undefined) }}>
                    Return to queue
                  </button>
                )}
                <button
                  type="button"
                  className="ev-link"
                  disabled={!gate.allowed}
                  onClick={() => { decide(selected, 'awaiting_clarification').catch(() => undefined) }}
                >
                  Ask the farm for clarification
                </button>
              </div>
            </section>
          </div>
        </div>

        {queue.length > 1 && (
          <nav className="ev-queue" aria-label="Documents awaiting a decision">
            {queue.map(d => (
              <button
                key={d.id}
                type="button"
                className={`ev-queue-item${d.id === selected.id ? ' is-current' : ''}`}
                onClick={() => { setSelectedId(d.id); setReason(''); setPreviewUrl(null); setHistoryOpen(false) }}
              >
                <span>{recordTitle(d)}</span>
                <span className="ev-queue-meta">{when(d.uploadedAt)}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

/** Absent is an em dash in a labelled field — the field exists, the value does not. */
function Fact({ label, value, mono, hint }: {
  label: string; value?: string | null; mono?: boolean; hint?: string
}) {
  const shown = (value ?? '').trim()
  return (
    <div className="ev-fact">
      <span className="ev-fact-label">
        {label}
        {/* What the recorded state actually means, next to the state itself —
            "accepted" is a claim about a person, not about the document. */}
        {hint && <span className="ev-fact-hint">{hint}</span>}
      </span>
      <span className={`ev-fact-value${mono ? ' ev-mono' : ''}`}>{shown || '—'}</span>
    </div>
  )
}
