import type { AiDraftSummary } from '../../lib/complianceAiSummarisation'

/**
 * The transient AI draft panel, lifted out of DDPComplianceWatchtower so it can
 * actually be RENDERED in a test.
 *
 * It was previously inline JSX in a ~2000-line page component that no test ever
 * rendered — this repo executed no JSX at all — so two changes shipped to
 * production having never run anywhere: the source-reference list key, and an
 * escaped apostrophe. Both happened to be correct. Nothing would have caught it
 * if they had not been.
 *
 * Deliberately presentational and prop-driven: no Supabase, no fetch, no state,
 * no effects. Everything it shows is decided by the caller, which is what makes
 * it cheap to assert against. The page keeps ownership of when to show it.
 */
export interface AiDraftPanelProps {
  draft: AiDraftSummary
  /** Title of the legal update this draft belongs to. The page resolves this
   *  from its own list and only renders the panel while that update is still a
   *  `new` draft, so a stale draft is never shown against a reviewed update. */
  updateTitle: string
  /** Disables discard while a request is in flight. */
  busy: boolean
  onDiscard: () => void
}

export function AiDraftPanel({ draft, updateTitle, busy, onDiscard }: AiDraftPanelProps) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <span className="badge" style={{ background: '#7a5', color: '#fff' }}>Draft only</span>{' '}
          <strong>AI-generated draft — requires human legal review</strong>
        </div>
        <button className="btn btn-review" disabled={busy} onClick={() => { onDiscard() }}>Discard draft</button>
      </div>
      <p className="td-muted" style={{ marginTop: 4 }}>
        For: <strong>{updateTitle}</strong>. This draft is transient — it is not saved, does not
        change this legal update, and is not a record of legal review, approval, or compliance status.
      </p>
      <div style={{ marginTop: 8 }}>
        <h4 style={{ margin: '8px 0 2px' }}>Draft factual summary</h4>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{draft.draftSummary}</p>
        <h4 style={{ margin: '8px 0 2px' }}>Possible significance</h4>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{draft.possibleSignificance}</p>
        <h4 style={{ margin: '8px 0 2px' }}>Uncertainties</h4>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{draft.uncertainties}</p>
        <h4 style={{ margin: '8px 0 2px' }}>Questions for human legal review</h4>
        <ul style={{ margin: 0 }}>{draft.reviewQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        <h4 style={{ margin: '8px 0 2px' }}>Source references</h4>
        {draft.sourceReferences.length > 0
          ? <ul style={{ margin: 0 }}>{draft.sourceReferences.map(ref => <li key={ref}>{ref}</li>)}</ul>
          : <p className="td-muted" style={{ margin: 0 }}>None. No reference could be matched to the recorded source evidence.</p>}
        <p className="td-muted" style={{ marginTop: 4, fontSize: 12 }}>
          Each entry above is quoted from the recorded source — the sentence as it appears in the stored
          evidence, or the recorded source name or URL — not the AI&apos;s wording of it. References the AI
          produced that could not be matched to the stored evidence are discarded. This list is therefore
          not a citation of the underlying legislation: the primary source text is not held here.
          {draft.droppedSourceReferences > 0
            ? ` ${draft.droppedSourceReferences} unmatched reference(s) were discarded from this draft.`
            : ''}
        </p>
      </div>
      <p className="td-muted" style={{ marginTop: 8, fontSize: 12 }}>
        Provider: {draft.providerId} · Model: {draft.modelId} · Generated: {draft.generatedAt}
      </p>
    </div>
  )
}
