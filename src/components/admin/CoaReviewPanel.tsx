import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  COA_DECISIONS,
  CoaReviewError,
  extractCoa,
  listCoaDocuments,
  loadAuditEvents,
  loadCoaFields,
  loadCoaFindings,
  loadDecisions,
  loadLatestSourceVersion,
  loadSuggestions,
  recordCoaDecision,
  retrieveOfficialSourceFor,
  type CoaAuditEventView,
  type CoaDecisionView,
  type CoaDocumentSummary,
  type CoaSourceVersionView,
  type CoaSuggestionView,
} from '../../lib/coaReviewClient'
import type { CoaExtractedField } from '../../lib/coaTnrAdapter'
import type { CoaFinding } from '../../lib/coaFindings'

// ─── Source-bound COA review — admin panel (Gate P0, issue #77) ──────────────
//
// One end-to-end review inside the real Watchtower:
//
//   supplied COA -> server-side extraction with page provenance
//                -> deterministic findings
//                -> freshly retrieved official source
//                -> source-bound preliminary suggestion
//                -> administrator decision -> audit record
//
// The panel holds no business logic. It parses no PDF, fetches no regulatory
// site, evaluates no threshold and reaches no conclusion — extraction and
// retrieval happen server-side, and everything shown is read back from the
// database, so a page refresh reproduces the same state.
//
// Two display rules are load-bearing:
//   * every extracted value shows the PDF page it came from;
//   * a suggestion is shown as guidance ONLY when its stored state is 'bound'.
//     A quarantined or absent suggestion is shown as an explicit UNVERIFIED
//     state instead, never as advice.

interface Props {
  isSupabaseConfigured: boolean
  isAdmin: boolean
}

type Message = { type: 'success' | 'error' | 'info'; text: string }

const SEVERITY_ORDER: Record<CoaFinding['severity'], number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
}

function severityClass(severity: CoaFinding['severity']): string {
  switch (severity) {
    case 'critical': case 'high': return 'status-missing'
    case 'medium': return 'status-claimed'
    default: return 'status-hold'
  }
}

function fieldStatusClass(status: CoaExtractedField['status']): string {
  switch (status) {
    case 'extracted': return 'status-verified'
    case 'unreadable': return 'status-missing'
    default: return 'status-hold'
  }
}

function short(fingerprint: string | null, length = 16): string {
  if (!fingerprint) return '—'
  return fingerprint.length <= length ? fingerprint : `${fingerprint.slice(0, length)}…`
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export function CoaReviewPanel({ isSupabaseConfigured, isAdmin }: Props) {
  const [documents, setDocuments] = useState<CoaDocumentSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fields, setFields] = useState<CoaExtractedField[]>([])
  const [findings, setFindings] = useState<CoaFinding[]>([])
  const [sourceVersion, setSourceVersion] = useState<CoaSourceVersionView | null>(null)
  const [suggestions, setSuggestions] = useState<CoaSuggestionView[]>([])
  const [decisions, setDecisions] = useState<CoaDecisionView[]>([])
  const [auditEvents, setAuditEvents] = useState<CoaAuditEventView[]>([])

  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [retrieving, setRetrieving] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [decision, setDecision] = useState<string>(COA_DECISIONS[0].value)
  const [note, setNote] = useState('')

  const selected = useMemo(
    () => documents.find((d) => d.coaDocumentId === selectedId) ?? null,
    [documents, selectedId],
  )

  const boundSuggestion = useMemo(
    () => suggestions.find((s) => s.state === 'bound') ?? null,
    [suggestions],
  )
  const withheldSuggestion = useMemo(
    () => suggestions.find((s) => s.state !== 'bound') ?? null,
    [suggestions],
  )

  const sortedFindings = useMemo(
    () => [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [findings],
  )

  const evidenceVersion = selected ? `${selected.parserVersion}@${selected.documentFingerprint}` : ''
  const currentState = decisions[0]?.resultingState ?? 'pending_review'

  const reportError = useCallback((err: unknown, fallback: string) => {
    setMessage({
      type: 'error',
      text: err instanceof CoaReviewError || err instanceof Error ? err.message : fallback,
    })
  }, [])

  const loadDocuments = useCallback(async () => {
    if (!isSupabaseConfigured) return
    setLoading(true)
    try {
      const rows = await listCoaDocuments()
      setDocuments(rows)
      setSelectedId((current) => current ?? rows[0]?.coaDocumentId ?? null)
    } catch (err) {
      reportError(err, 'The COA list could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [isSupabaseConfigured, reportError])

  const loadDetail = useCallback(async (coaDocumentId: string) => {
    setLoading(true)
    try {
      // Loaded together so the panel state is always one coherent snapshot.
      const [f, fi, sv, sg, de, au] = await Promise.all([
        loadCoaFields(coaDocumentId),
        loadCoaFindings(coaDocumentId),
        loadLatestSourceVersion(coaDocumentId),
        loadSuggestions(coaDocumentId),
        loadDecisions(coaDocumentId),
        loadAuditEvents(coaDocumentId),
      ])
      setFields(f)
      setFindings(fi)
      setSourceVersion(sv)
      setSuggestions(sg)
      setDecisions(de)
      setAuditEvents(au)
    } catch (err) {
      reportError(err, 'The COA review could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [reportError])

  // Reload from the database on mount — this is what makes a refresh reproduce
  // the evidence, findings, source, suggestion, decision and audit trail.
  //
  // The queries are issued directly rather than through the loaders above so no
  // state is set synchronously inside the effect, and each effect can abandon a
  // response that arrived after unmount or after the selection moved on.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let active = true
    listCoaDocuments()
      .then((rows) => {
        if (!active) return
        setDocuments(rows)
        setSelectedId((current) => current ?? rows[0]?.coaDocumentId ?? null)
      })
      .catch((err: unknown) => {
        if (active) reportError(err, 'The COA list could not be loaded.')
      })
    return () => { active = false }
  }, [isSupabaseConfigured, reportError])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    Promise.all([
      loadCoaFields(selectedId),
      loadCoaFindings(selectedId),
      loadLatestSourceVersion(selectedId),
      loadSuggestions(selectedId),
      loadDecisions(selectedId),
      loadAuditEvents(selectedId),
    ])
      .then(([f, fi, sv, sg, de, au]) => {
        if (!active) return
        setFields(f)
        setFindings(fi)
        setSourceVersion(sv)
        setSuggestions(sg)
        setDecisions(de)
        setAuditEvents(au)
      })
      .catch((err: unknown) => {
        if (active) reportError(err, 'The COA review could not be loaded.')
      })
    return () => { active = false }
  }, [selectedId, reportError])

  async function handleFile(file: File | null): Promise<void> {
    if (!file) return
    setMessage(null)
    setExtracting(true)
    try {
      const result = await extractCoa(file)
      setSelectedId(result.document.coaDocumentId)
      await loadDocuments()
      await loadDetail(result.document.coaDocumentId)
      setMessage({
        type: result.document.supported ? 'success' : 'info',
        text: result.document.supported
          ? `Extracted ${result.fields.length} field(s) from ${result.document.pageCount} page(s); ${result.findings.length} deterministic finding(s).`
          : `Document stored but not supported: ${result.document.unsupportedReason ?? 'unrecognised format'}.`,
      })
    } catch (err) {
      reportError(err, 'The COA could not be extracted.')
    } finally {
      setExtracting(false)
    }
  }

  async function handleRetrieveSource(): Promise<void> {
    if (!selectedId) return
    setMessage(null)
    setRetrieving(true)
    try {
      const result = await retrieveOfficialSourceFor(selectedId)
      await loadDetail(selectedId)
      setMessage({
        type: result.suggestionState === 'bound' ? 'success' : 'info',
        text: result.suggestionState === 'bound'
          ? `Source retrieved from ${result.sourceVersion.authority}; a preliminary suggestion is bound to version ${short(result.sourceVersion.contentFingerprint)}.`
          : `Source not verified (${result.sourceVersion.retrievalStatus}). ${result.suggestionReason ?? 'No regulatory suggestion was created.'}`,
      })
    } catch (err) {
      reportError(err, 'The official source could not be retrieved.')
    } finally {
      setRetrieving(false)
    }
  }

  async function handleRecordDecision(): Promise<void> {
    if (!selected) return
    setMessage(null)
    setDeciding(true)
    try {
      await recordCoaDecision({
        coaDocumentId: selected.coaDocumentId,
        sourceVersionId: sourceVersion?.sourceVersionId ?? null,
        suggestionId: boundSuggestion?.suggestionId ?? null,
        decision,
        previousState: currentState,
        note,
        evidenceVersion,
      })
      setNote('')
      await loadDetail(selected.coaDocumentId)
      setMessage({ type: 'success', text: 'Decision recorded and written to the audit trail.' })
    } catch (err) {
      // A refusal here is the database's authorization boundary doing its job.
      reportError(err, 'The decision was refused.')
    } finally {
      setDeciding(false)
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Source-bound COA review</h2>
        <div className="disclaimer-box">
          <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>
            BACKEND REQUIRED
          </span>
          <div>
            COA review reads and writes real compliance records and has no local simulation by design.
            Connect the Supabase backend to use this surface.
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* ── Intake ─────────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Source-bound COA review</h2>
        <p className="td-muted">
          Processes a supplied machine-readable COA <strong>on the server</strong>, records every extracted
          value with the PDF page it came from, derives deterministic findings, and retrieves one official
          authority source. A preliminary suggestion is created <strong>only</strong> when it can be bound to
          a source version that was actually retrieved. A parsed COA is documented evidence, not proof of
          authenticity — and no conclusion about compliance is drawn by this system.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="btn btn-primary" style={{ cursor: isAdmin && !extracting ? 'pointer' : 'not-allowed' }}>
            {extracting ? 'Extracting on server…' : 'Upload COA (PDF)'}
            <input
              type="file"
              accept="application/pdf,.pdf"
              disabled={!isAdmin || extracting}
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null
                event.target.value = ''
                void handleFile(file)
              }}
            />
          </label>
          <button className="btn btn-review" disabled={loading} onClick={() => { void loadDocuments() }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <span className="td-muted" style={{ fontSize: 12 }}>
            {documents.length} COA document(s) on file
          </span>
        </div>

        {message && (
          <div className="disclaimer-box" style={{ marginTop: 12 }}>
            <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: message.type === 'error' ? 'var(--warning)' : 'var(--success, #2e7d32)' }}>
              {message.type === 'error' ? 'COA REVIEW ERROR' : message.type === 'info' ? 'COA REVIEW NOTICE' : 'COA REVIEW OK'}
            </span>
            <div>{message.text}</div>
          </div>
        )}

        {documents.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <label className="td-muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              Reviewing
            </label>
            <select
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(event.target.value || null)}
              style={{ maxWidth: '100%' }}
            >
              {documents.map((doc) => (
                <option key={doc.coaDocumentId} value={doc.coaDocumentId}>
                  {doc.sampleName ?? doc.sourceFilename ?? 'Untitled'} · {doc.reportNumber ?? 'no report no.'} · {formatTime(doc.extractedAt)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {selected && (
        <>
          {/* ── Evidence + provenance ────────────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Extracted evidence</h3>
            <div className="td-muted" style={{ fontSize: 12, marginBottom: 10 }}>
              Parser <strong>{selected.parserVersion}</strong> · document fingerprint{' '}
              <code>{short(selected.documentFingerprint, 24)}</code> · {selected.pageCount} page(s) ·
              extracted {formatTime(selected.extractedAt)} · status <strong>{selected.extractionStatus}</strong>
              {selected.unsupportedReason && <> · {selected.unsupportedReason}</>}
            </div>

            {fields.length === 0 ? (
              <p className="td-muted">No fields were extracted from this document.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Field</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Value</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Raw</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>PDF page</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <tr key={field.key}>
                        <td style={{ padding: '6px 8px' }}>{field.label}</td>
                        <td style={{ padding: '6px 8px' }}>{field.normalizedValue ?? <span className="td-muted">—</span>}</td>
                        <td style={{ padding: '6px 8px' }} className="td-muted">{field.rawValue ?? '—'}</td>
                        <td style={{ padding: '6px 8px' }}>
                          {/* Provenance: every displayed value names its page. */}
                          {field.pageNumber !== null
                            ? <strong>p.{field.pageNumber}</strong>
                            : <span className="td-muted">not located</span>}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <span className={fieldStatusClass(field.status)}>{field.status}</span>
                          {field.warnings.length > 0 && (
                            <div className="td-muted" style={{ fontSize: 11 }}>{field.warnings.join('; ')}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Deterministic findings ───────────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Deterministic findings</h3>
            <p className="td-muted" style={{ fontSize: 12 }}>
              Mechanical observations about the document itself. They consult no legal threshold and state
              no compliance conclusion.
            </p>
            {sortedFindings.length === 0 ? (
              <p className="td-muted">No findings: identifiers, dates and all expected panels were readable.</p>
            ) : (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {sortedFindings.map((finding) => (
                  <li key={finding.fingerprint} style={{ marginBottom: 6 }}>
                    <span className={severityClass(finding.severity)}>{finding.severity}</span>{' '}
                    <strong>{finding.title}</strong>
                    {finding.pageNumber !== null && <> <span className="td-muted">(page {finding.pageNumber})</span></>}
                    <div className="td-muted" style={{ fontSize: 12 }}>{finding.detail}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Official source ──────────────────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Official source</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <button
                className="btn btn-primary"
                disabled={!isAdmin || retrieving}
                onClick={() => { void handleRetrieveSource() }}
              >
                {retrieving ? 'Retrieving on server…' : 'Retrieve official source now'}
              </button>
              <span className="td-muted" style={{ fontSize: 12 }}>
                Server-side, HTTPS-only, host-allowlisted, every redirect revalidated.
              </span>
            </div>

            {!sourceVersion ? (
              <div className="disclaimer-box">
                <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>
                  UNVERIFIED
                </span>
                <div>No official source has been retrieved for this COA. No regulatory suggestion can exist.</div>
              </div>
            ) : (
              <div style={{ fontSize: 13 }}>
                <div><strong>Authority:</strong> {sourceVersion.authority}</div>
                <div><strong>Jurisdiction:</strong> {sourceVersion.jurisdiction} ({sourceVersion.jurisdictionCode})</div>
                <div>
                  <strong>Direct URL:</strong>{' '}
                  <a href={sourceVersion.finalUrl ?? sourceVersion.requestedUrl} target="_blank" rel="noopener noreferrer">
                    {sourceVersion.finalUrl ?? sourceVersion.requestedUrl}
                  </a>
                </div>
                <div><strong>Retrieved:</strong> {formatTime(sourceVersion.retrievedAt)}</div>
                <div>
                  <strong>Status:</strong>{' '}
                  <span className={sourceVersion.retrievalStatus === 'retrieved' ? 'status-verified' : 'status-missing'}>
                    {sourceVersion.retrievalStatus}
                  </span>
                  {sourceVersion.httpStatus !== null && <> (HTTP {sourceVersion.httpStatus})</>}
                  {sourceVersion.failureReason && <span className="td-muted"> — {sourceVersion.failureReason}</span>}
                </div>
                <div><strong>Source version:</strong> <code>{short(sourceVersion.contentFingerprint, 24)}</code></div>
                {sourceVersion.redirectChain.length > 1 && (
                  <div className="td-muted" style={{ fontSize: 12 }}>
                    Redirect chain: {sourceVersion.redirectChain.join(' → ')}
                  </div>
                )}
                {sourceVersion.relevantSection && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Relevant section</strong>{' '}
                    <span className="td-muted" style={{ fontSize: 11 }}>
                      ({sourceVersion.sectionMatched ? 'keyword match' : 'no keyword match — opening of the retrieved page'}, stored verbatim)
                    </span>
                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'rgba(0,0,0,0.04)', padding: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
                      {sourceVersion.relevantSection}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Preliminary suggestion ───────────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Preliminary suggestion</h3>
            {boundSuggestion ? (
              <>
                <div className="td-muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  Bound to source version <code>{short(sourceVersion?.contentFingerprint ?? null, 24)}</code>{' '}
                  retrieved {formatTime(sourceVersion?.retrievedAt ?? null)}. Preliminary only — it carries no
                  operational effect until an administrator decides.
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, margin: 0 }}>{boundSuggestion.suggestionText}</pre>
              </>
            ) : (
              <div className="disclaimer-box">
                <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>
                  {withheldSuggestion ? withheldSuggestion.state.toUpperCase() : 'NO SUGGESTION'}
                </span>
                <div>
                  {withheldSuggestion
                    ? `A suggestion exists but is ${withheldSuggestion.state} and is not shown as guidance: ${withheldSuggestion.reason ?? 'no reason recorded'}.`
                    : 'No suggestion has been created. A verified source retrieval is required first.'}
                </div>
              </div>
            )}
          </div>

          {/* ── Administrator decision ───────────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Administrator decision</h3>
            <p className="td-muted" style={{ fontSize: 12 }}>
              Current state: <strong>{currentState}</strong>. Only an authorized administrator may decide;
              the database refuses a decision recorded by anyone else, or in anyone else's name.
            </p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <select value={decision} onChange={(event) => setDecision(event.target.value)}>
                {COA_DECISIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Note (recorded in the audit trail)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                style={{ flex: '1 1 260px', minWidth: 200 }}
              />
              <button
                className="btn btn-primary"
                disabled={!isAdmin || deciding}
                onClick={() => { void handleRecordDecision() }}
              >
                {deciding ? 'Recording…' : 'Record decision'}
              </button>
            </div>

            {decisions.length > 0 && (
              <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {decisions.map((entry) => (
                  <li key={entry.decisionId} style={{ marginBottom: 6 }}>
                    <strong>{entry.decision}</strong> · {entry.previousState} → {entry.resultingState} ·{' '}
                    {formatTime(entry.decidedAt)}
                    <div className="td-muted" style={{ fontSize: 12 }}>
                      {entry.note || <em>no note</em>} · evidence <code>{short(entry.evidenceVersion, 28)}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Audit trail ──────────────────────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Audit trail</h3>
            {auditEvents.length === 0 ? (
              <p className="td-muted">No audit events recorded for this COA yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>When</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Action</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Actor</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Previous → resulting</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Evidence / source version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEvents.map((event, index) => (
                      <tr key={`${event.createdAt}-${index}`}>
                        <td style={{ padding: '6px 8px' }}>{formatTime(event.createdAt)}</td>
                        <td style={{ padding: '6px 8px' }}>{event.action}</td>
                        <td style={{ padding: '6px 8px' }} className="td-muted">{short(event.actorId, 12)}</td>
                        <td style={{ padding: '6px 8px' }} className="td-muted">
                          {JSON.stringify(event.beforeState ?? null)} → {JSON.stringify(event.afterState ?? null)}
                        </td>
                        <td style={{ padding: '6px 8px' }} className="td-muted">
                          {short(event.evidenceVersion, 18)} / {short(event.sourceVersionId, 12)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
