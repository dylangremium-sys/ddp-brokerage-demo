import type {
  FarmProfile,
  InventoryItem,
  ComplianceAlert,
  ComplianceRule,
  ComplianceSeverity,
} from '../../types'
import {
  combineLoadStates,
  deriveCountMeasure,
  derivePanelMode,
  formatCountMeasure,
  measureNote,
  MEASURE_UNKNOWN,
  type PanelMode,
  SIGNALS_EMPTY,
  SIGNALS_ERROR,
  SIGNALS_LOADING,
  SIGNALS_UNAVAILABLE,
  SUPPLY_EMPTY,
  SUPPLY_ERROR,
  SUPPLY_LOADING,
  SUPPLY_UNAVAILABLE,
  type SourceLoadState,
} from '../../lib/overviewViewState'
import {
  daysUntilCalendarDate,
  formatCalendarDate,
  isExpiredOn,
  isExpiringWithin,
} from '../../lib/calendarDate'
import {
  deriveCoaEvidence,
  COA_EVIDENCE_LABEL,
  COA_EVIDENCE_REASON,
  type CoaEvidencePosition,
} from '../../lib/coaEvidence'
import { formatMeasurement } from '../../lib/measurement'

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  onReviewFarm: (id: string) => void
  onReviewItem: (id: string) => void
  complianceRules: ComplianceRule[]
  complianceAlerts: ComplianceAlert[]
  /**
   * Lifecycle of each source. Absence may only be claimed at 'loaded', and each
   * measure below is bound to exactly the sources its calculation reads.
   */
  complianceLoadState: SourceLoadState
  farmsLoadState: SourceLoadState
  inventoryLoadState: SourceLoadState
}

/* ── Derivation helpers ─────────────────────────────────────────────────────
   Every value below is read from a field that already exists on the record.
   Where a field is absent or unparseable the row states that fact rather than
   substituting a plausible one.
   ────────────────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000

/** Parse a stored date, or null. Never guesses. */
function parseDate(v: string | undefined | null): Date | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t)
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
}

/** "16 Jul 2026" — never raw ISO on an operator's desk. */
function formatDate(v: string | undefined | null): string {
  const d = parseDate(v)
  if (!d) return 'Not recorded'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function ageLabel(v: string | undefined | null, now: Date): string {
  // A date-only value (documentExpiry reaching this via a priority's sortAt) is
  // a calendar date. Age it in calendar days so the count cannot drift with the
  // viewer's timezone. Instants (created_at, submittedAt) keep instant maths.
  const untilCalendarDay = daysUntilCalendarDate(v, now)
  if (untilCalendarDay !== null) return describeAge(-untilCalendarDay)

  const d = parseDate(v)
  if (!d) return 'Age unknown'
  return describeAge(daysBetween(d, now))
}

function describeAge(days: number): string {
  if (days < 0) return 'Age unknown'
  if (days === 0) return 'Today'
  if (days === 1) return '1 day'
  return `${days} days`
}

type Severity = 'critical' | 'important' | 'standard' | 'info'

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, important: 1, standard: 2, info: 3 }

interface Priority {
  key: string
  severity: Severity
  kind: 'Farm' | 'Batch' | 'Alert'
  name: string
  /** Why this row is here, stated from the record's own fields. */
  reason: string
  /** What the state means operationally. Approved vocabulary only. */
  consequence: string
  status: string
  statusTone: StatusTone
  sortAt: string | null
  onOpen?: () => void
}

type StatusTone = 'critical' | 'high' | 'review' | 'evidence' | 'neutral' | 'warn-tint' | 'risk-tint'

/**
 * Visual weight per evidence position. A received document is evidence and sits
 * quiet; an unreceived claim is self-asserted and uncorroborated, so it carries
 * a fill rather than a tint and cannot be mistaken for a documented record;
 * absent evidence stays loudest.
 */
const EVIDENCE_TONE: Record<CoaEvidencePosition, StatusTone> = {
  documented: 'evidence',
  claimed: 'high',
  missing: 'critical',
}

/** Map an alert's own severity onto the row's visual weight. */
function alertSeverity(s: ComplianceSeverity): Severity {
  if (s === 'critical') return 'critical'
  if (s === 'high') return 'important'
  if (s === 'medium') return 'standard'
  return 'info'
}

export default function DDPOverview({
  farms,
  inventory,
  onReviewFarm,
  onReviewItem,
  complianceRules,
  complianceAlerts,
  complianceLoadState,
  farmsLoadState,
  inventoryLoadState,
}: Props) {
  const now = new Date()

  // ── Measure → source binding ─────────────────────────────────────────────
  // Each measure is bound to exactly the sources its calculation reads below.
  // Nothing here may report a number until every source it depends on has
  // completed successfully.
  //   farms      → Expiring within 30 days
  //   inventory  → Missing evidence, Supply position (evidence fields live on
  //                the batch row; there is no separate evidence source)
  //   both       → Submissions awaiting review
  //   all three  → Review priorities
  //   compliance → Blocked decisions, Compliance signals
  const submissionsState = combineLoadStates(farmsLoadState, inventoryLoadState)
  const prioritiesState = combineLoadStates(farmsLoadState, inventoryLoadState, complianceLoadState)
  const supplyMode = derivePanelMode(inventoryLoadState, inventory.length)

  // Whether every source feeding Review priorities has settled. Until then the
  // list is provably partial, so it may not present as the complete picture.
  const prioritiesResolved = prioritiesState === 'loaded' || prioritiesState === 'unavailable'

  // ── Attention summary ────────────────────────────────────────────────────
  // Only measures derivable from fields present on these records. A planned
  // "Buyer-Ready for Discussion" measure is omitted: readiness lives on
  // ComplianceEntityStatus, which this page is not given, and inventing it
  // would assert a commercial position the data does not support.

  const farmsAwaitingReview = farms.filter(
    f => f.status === 'Submitted to DDP' || f.status === 'Under Review',
  )
  const batchesAwaitingReview = inventory.filter(i => i.status === 'Pending Review')
  const requiresReview = farmsAwaitingReview.length + batchesAwaitingReview.length

  // Evidence presence comes from the evidence fields, never from workflow
  // status. `status === 'Missing Document'` is a review decision: it omitted a
  // Pending Review or Approved batch that has no received COA, and it kept
  // counting a batch after its COA arrived, because the upload handlers patch
  // coaStoragePath without touching status.
  const evidenceMissingBatches = inventory.filter(i => deriveCoaEvidence(i) === 'missing')
  const evidenceClaimedBatches = inventory.filter(i => deriveCoaEvidence(i) === 'claimed')
  // One row per batch: a batch listed for its evidence gap is not repeated as a
  // routine review item below.
  const evidenceFlaggedIds = new Set(
    [...evidenceMissingBatches, ...evidenceClaimedBatches].map(i => i.id),
  )

  const unresolvedAlerts = complianceAlerts.filter(
    a => a.status === 'open' || a.status === 'in_review' || a.status === 'blocked',
  )
  const blockedAlerts = complianceAlerts.filter(a => a.status === 'blocked')

  // documentExpiry is captured by input type="date", so it is a calendar date,
  // not an instant. Classifying it against a UTC instant reported a licence
  // valid *through* today as expired for viewers east of UTC. See lib/calendarDate.
  const expiringFarms = farms.filter(f => isExpiringWithin(f.documentExpiry, now, 30))
  const expiredFarms = farms.filter(f => isExpiredOn(f.documentExpiry, now))

  // Each measure is gated on its own sources: a number, including zero, appears
  // only once every source it reads has completed successfully. Otherwise "—".
  const kpis = [
    {
      // Named for exactly what it counts: farm profiles in 'Submitted to DDP' /
      // 'Under Review' plus batches in 'Pending Review'. It deliberately excludes
      // missing-evidence batches and open alerts, which are counted beside it.
      lbl: 'Submissions awaiting review',
      state: submissionsState,
      measure: deriveCountMeasure(submissionsState, requiresReview),
      riskTone: 'warning',
    },
    {
      lbl: 'Missing evidence',
      state: inventoryLoadState,
      measure: deriveCountMeasure(inventoryLoadState, evidenceMissingBatches.length),
      riskTone: 'risk',
    },
    {
      lbl: 'Blocked decisions',
      state: complianceLoadState,
      measure: deriveCountMeasure(complianceLoadState, blockedAlerts.length),
      riskTone: 'risk',
    },
    {
      lbl: 'Expiring within 30 days',
      state: farmsLoadState,
      measure: deriveCountMeasure(farmsLoadState, expiringFarms.length),
      riskTone: 'warning',
    },
  ].map(k => ({
    ...k,
    val: formatCountMeasure(k.measure),
    note: measureNote(k.state),
    // Derived from the load state, never from the note's wording — reworded
    // copy must not be able to silently break the busy signal.
    busy: k.state === 'idle' || k.state === 'loading',
    // Tone reflects risk only when the value is known AND non-zero. An unknown
    // measure is never coloured as if it were a confirmed clean result.
    tone: k.measure.known && k.measure.value > 0 ? k.riskTone : 'zero',
  }))

  // ── Review priorities ────────────────────────────────────────────────────

  const priorities: Priority[] = []

  // No COA on file at all. States what is on file, not the review decision.
  for (const i of evidenceMissingBatches) {
    priorities.push({
      key: `batch-missing-${i.id}`,
      severity: 'critical',
      kind: 'Batch',
      name: `${i.productName} — ${i.farmName}`,
      reason: COA_EVIDENCE_REASON.missing,
      consequence: 'Buyer requirements incomplete',
      status: COA_EVIDENCE_LABEL.missing,
      statusTone: EVIDENCE_TONE.missing,
      sortAt: i.submittedAt,
      onOpen: () => onReviewItem(i.id),
    })
  }

  // A COA was claimed but never received. Still outstanding work — the file
  // has to be chased — but it is not the same fact as nothing being claimed.
  for (const i of evidenceClaimedBatches) {
    priorities.push({
      key: `batch-claimed-${i.id}`,
      severity: 'important',
      kind: 'Batch',
      name: `${i.productName} — ${i.farmName}`,
      reason: COA_EVIDENCE_REASON.claimed,
      consequence: 'Buyer requirements incomplete',
      status: COA_EVIDENCE_LABEL.claimed,
      statusTone: EVIDENCE_TONE.claimed,
      sortAt: i.submittedAt,
      onOpen: () => onReviewItem(i.id),
    })
  }

  for (const f of expiredFarms) {
    priorities.push({
      key: `farm-expired-${f.id}`,
      severity: 'critical',
      kind: 'Farm',
      name: f.tradingName,
      reason: `Documentation expired ${formatCalendarDate(f.documentExpiry) ?? 'on an unrecorded date'}`,
      consequence: 'Blocked Pending Review',
      status: 'Expired',
      statusTone: 'critical',
      sortAt: f.documentExpiry,
      onOpen: () => onReviewFarm(f.id),
    })
  }

  for (const a of unresolvedAlerts) {
    priorities.push({
      key: `alert-${a.id}`,
      severity: a.status === 'blocked' ? 'critical' : alertSeverity(a.severity),
      kind: 'Alert',
      name: a.alertTitle,
      reason: a.alertDetail || `${a.entityType} ${a.entityId}`,
      consequence: a.status === 'blocked' ? 'Blocked Pending Review' : 'Human Decision Required',
      status: a.status === 'blocked' ? 'Blocked Pending Review' : 'Under Review',
      statusTone: a.status === 'blocked' ? 'critical' : 'review',
      sortAt: a.createdAt,
    })
  }

  for (const f of expiringFarms) {
    // Non-null: isExpiringWithin only admits parseable date-only values.
    const days = daysUntilCalendarDate(f.documentExpiry, now) ?? 0
    priorities.push({
      key: `farm-expiring-${f.id}`,
      severity: 'important',
      kind: 'Farm',
      name: f.tradingName,
      reason: days === 0
        ? 'Documentation expires today'
        : `Documentation expires in ${days} day${days === 1 ? '' : 's'}`,
      consequence: 'Export-readiness incomplete',
      status: 'Needs Review',
      statusTone: 'warn-tint',
      sortAt: f.documentExpiry,
      onOpen: () => onReviewFarm(f.id),
    })
  }

  for (const f of farms.filter(f => f.status === 'More Information Required')) {
    priorities.push({
      key: `farm-info-${f.id}`,
      severity: 'important',
      kind: 'Farm',
      name: f.tradingName,
      reason: 'Supplier response outstanding',
      consequence: 'Human Decision Required',
      status: f.status,
      statusTone: 'warn-tint',
      sortAt: f.submittedAt,
      onOpen: () => onReviewFarm(f.id),
    })
  }

  for (const f of farms.filter(f => f.status === 'Watchlist')) {
    priorities.push({
      key: `farm-watch-${f.id}`,
      severity: 'important',
      kind: 'Farm',
      name: f.tradingName,
      reason: 'Watchlist condition unresolved',
      consequence: 'Human Decision Required',
      status: f.status,
      statusTone: 'warn-tint',
      sortAt: f.submittedAt,
      onOpen: () => onReviewFarm(f.id),
    })
  }

  for (const f of farmsAwaitingReview) {
    priorities.push({
      key: `farm-review-${f.id}`,
      severity: 'standard',
      kind: 'Farm',
      name: f.tradingName,
      reason: `Profile ${f.completionPct}% complete · ${f.province || 'Province not recorded'}`,
      consequence: 'Human Decision Required',
      status: f.status,
      statusTone: 'review',
      sortAt: f.submittedAt,
      onOpen: () => onReviewFarm(f.id),
    })
  }

  for (const i of batchesAwaitingReview) {
    // Already listed above with its evidence gap, which is the more urgent fact.
    if (evidenceFlaggedIds.has(i.id)) continue
    priorities.push({
      key: `batch-review-${i.id}`,
      severity: 'standard',
      kind: 'Batch',
      name: `${i.productName} — ${i.farmName}`,
      reason: `${i.quantityKg.toLocaleString()} kg submitted`,
      consequence: 'Human Decision Required',
      status: i.status,
      statusTone: 'review',
      sortAt: i.submittedAt,
      onOpen: () => onReviewItem(i.id),
    })
  }

  priorities.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (s !== 0) return s
    const at = parseDate(a.sortAt)?.getTime() ?? 0
    const bt = parseDate(b.sortAt)?.getTime() ?? 0
    return at - bt // oldest first within a severity
  })

  // ── Compliance signals ───────────────────────────────────────────────────
  // Unresolved conditions only. No positive news is manufactured.

  const rulesAwaitingDecision = complianceRules.filter(
    r => r.status === 'suggested' || r.status === 'draft',
  )

  const signals: { key: string; severity: Severity; title: string; detail: string }[] = [
    ...blockedAlerts.map(a => ({
      key: `sig-blocked-${a.id}`,
      severity: 'critical' as Severity,
      title: a.alertTitle,
      detail: `Blocked Pending Review · raised ${ageLabel(a.createdAt, now)} ago`,
    })),
    ...rulesAwaitingDecision.map(r => ({
      key: `sig-rule-${r.id}`,
      severity: (r.isBlocking ? 'important' : 'standard') as Severity,
      title: r.title,
      detail: `${r.ruleCode} · Human Decision Required`,
    })),
    ...unresolvedAlerts
      .filter(a => a.status !== 'blocked')
      .map(a => ({
        key: `sig-alert-${a.id}`,
        severity: alertSeverity(a.severity),
        title: a.alertTitle,
        detail: `${a.entityType} · raised ${ageLabel(a.createdAt, now)} ago`,
      })),
    // Farm expiry signals are admitted only once the farms read has actually
    // succeeded. `farms` starts populated from the local store, so including
    // them while that read is pending or failed would present seed data as a
    // current expiry alert.
    ...(farmsLoadState === 'loaded'
      ? expiredFarms.map(f => ({
          key: `sig-exp-${f.id}`,
          severity: 'critical' as Severity,
          title: `${f.tradingName} — documentation expired`,
          detail: `Expired ${formatCalendarDate(f.documentExpiry) ?? 'on an unrecorded date'}`,
        }))
      : []),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  // This panel is fed by two sources, so "no unresolved signals" may only be
  // claimed once BOTH have settled — compliance finishing first must not settle
  // the panel on the farms half's behalf. Signals we can truthfully show are
  // still shown: an independently successful source is never discarded.
  const signalsSourceState = combineLoadStates(complianceLoadState, farmsLoadState)
  const signalsMode: PanelMode =
    signals.length > 0 ? 'list' : derivePanelMode(signalsSourceState, 0)

  /** Named per source, so a partial list never reads as the whole picture. */
  const signalSourceNotes: string[] = []
  if (complianceLoadState === 'error') signalSourceNotes.push('Compliance alerts could not be loaded')
  else if (complianceLoadState === 'idle' || complianceLoadState === 'loading') signalSourceNotes.push('Compliance alerts still loading')
  if (farmsLoadState === 'error') signalSourceNotes.push('Farm expiry signals could not be loaded')
  else if (farmsLoadState === 'idle' || farmsLoadState === 'loading') signalSourceNotes.push('Farm expiry signals still loading')

  // ── Supply position ──────────────────────────────────────────────────────

  const supply = [...inventory]
    .sort((a, b) => {
      const at = parseDate(a.submittedAt)?.getTime() ?? 0
      const bt = parseDate(b.submittedAt)?.getTime() ?? 0
      return bt - at
    })
    .slice(0, 8)

  return (
    <div className="eo-page">
      <header className="eo-page-head">
        <div className="eo-eyebrow">DDP operations</div>
        <h1 className="eo-title">Operations overview</h1>
        <p className="eo-page-desc">
          Review supplier evidence, blocked batches and buyer-discussion readiness.
        </p>
      </header>

      {/* Attention summary — one continuous ruled strip.
          Counts name their identities in the Review priorities panel below. */}
      <div
        className="eo-kpi-strip"
        style={{ ['--eo-kpi-count' as string]: kpis.length }}
      >
        {kpis.map(k => (
          <div className="eo-kpi" key={k.lbl} aria-busy={k.busy}>
            <div className={`eo-kpi-val eo-kpi-val--${k.tone}`}>{k.val}</div>
            <div className="eo-kpi-lbl">{k.lbl}</div>
            {k.note && <div className="eo-kpi-note">{k.note}</div>}
          </div>
        ))}
      </div>

      <div className="eo-grid">
        {/* Review priorities — the primary area */}
        <section className="eo-panel" aria-labelledby="eo-prio-h">
          <div className="eo-panel-bar">
            <h2 className="eo-panel-heading" id="eo-prio-h">Review priorities</h2>
            <span className="eo-meta">
              {/* Rows are contributed by all three sources, so this count may not
                  present as complete until every one of them has settled. */}
              {prioritiesState === 'error'
                ? `${priorities.length} shown · some sources could not be loaded`
                : !prioritiesResolved
                  ? `${priorities.length} so far · sources still loading`
                  : priorities.length === 0
                    ? 'Nothing outstanding'
                    : `${priorities.length} open · most urgent first`}
            </span>
          </div>
          <div className="eo-panel-body" aria-busy={prioritiesState === 'loading'}>
            {priorities.length === 0 ? (
              <p className="eo-empty" role={prioritiesResolved ? undefined : 'status'}>
                {prioritiesState === 'error'
                  ? 'Review priorities could not be confirmed — one or more sources failed to load.'
                  : !prioritiesResolved
                    ? 'Loading review priorities…'
                    : 'No records require review.'}
              </p>
            ) : (
              <ul className="eo-prio">
                {priorities.map(p => (
                  <li className={`eo-prio-row eo-prio-row--${p.severity}`} key={p.key}>
                    <div className="eo-prio-main">
                      <div className="eo-prio-entity">
                        <span className="eo-prio-kind">{p.kind}</span>
                        <span className="eo-prio-name">{p.name}</span>
                      </div>
                      <div className="eo-prio-reason">{p.reason}</div>
                      <div className="eo-prio-consequence">{p.consequence}</div>
                    </div>
                    <div className="eo-prio-side">
                      <span className={`eo-status eo-status--${p.statusTone}`}>{p.status}</span>
                      <span className="eo-prio-age">{ageLabel(p.sortAt, now)}</span>
                      {p.onOpen && (
                        <button className="eo-btn eo-btn--tertiary" onClick={p.onOpen}>
                          Open review
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Compliance signals — narrower secondary panel.
            The panel may only assert absence once the fetch has succeeded. */}
        <section className="eo-panel" aria-labelledby="eo-sig-h">
          <div className="eo-panel-bar">
            <h2 className="eo-panel-heading" id="eo-sig-h">Compliance signals</h2>
            {signalsMode === 'list' && <span className="eo-meta">Unresolved only</span>}
          </div>
          <div className="eo-panel-body" aria-busy={signalsMode === 'loading'}>
            {signalsMode === 'loading' && (
              <p className="eo-empty" role="status">{SIGNALS_LOADING}</p>
            )}
            {signalsMode === 'error' && (
              <p className="eo-empty eo-empty--error" role="status">{SIGNALS_ERROR}</p>
            )}
            {signalsMode === 'unavailable' && (
              <p className="eo-empty" role="status">{SIGNALS_UNAVAILABLE}</p>
            )}
            {signalsMode === 'empty' && <p className="eo-empty">{SIGNALS_EMPTY}</p>}
            {signalsMode === 'list' && signals.map(s => (
              <div className={`eo-signal eo-signal--${s.severity}`} key={s.key}>
                <div className="eo-signal-title">{s.title}</div>
                <div className="eo-signal-detail">{s.detail}</div>
              </div>
            ))}
            {/* Shown alongside a list so a partial one never reads as complete. */}
            {signalsMode === 'list' && signalSourceNotes.length > 0 && (
              <p className="eo-signal-note" role="status">
                {signalSourceNotes.join(' · ')} — this list may be incomplete.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Supply position */}
      <section className="eo-panel eo-supply" aria-labelledby="eo-supply-h">
        <div className="eo-panel-bar">
          <h2 className="eo-panel-heading" id="eo-supply-h">Supply position</h2>
          {/* Only a settled inventory read may describe the batch count. */}
          {supplyMode === 'list' && (
            <span className="eo-meta">
              {`${supply.length} of ${inventory.length} batches · most recent first`}
            </span>
          )}
        </div>

        {supplyMode !== 'list' ? (
          <div className="eo-panel-body" aria-busy={supplyMode === 'loading'}>
            <p
              className={`eo-empty${supplyMode === 'error' ? ' eo-empty--error' : ''}`}
              role={supplyMode === 'loading' || supplyMode === 'error' ? 'status' : undefined}
            >
              {supplyMode === 'loading' && SUPPLY_LOADING}
              {supplyMode === 'error' && SUPPLY_ERROR}
              {supplyMode === 'unavailable' && SUPPLY_UNAVAILABLE}
              {supplyMode === 'empty' && `${SUPPLY_EMPTY}.`}
            </p>
          </div>
        ) : (
        <div className="eo-table-scroll">
          <table className="eo-table">
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Supplier</th>
                <th scope="col" className="eo-td-num">Quantity (kg)</th>
                <th scope="col" className="eo-td-num">THC %</th>
                <th scope="col">Evidence position</th>
                <th scope="col">Review state</th>
                <th scope="col">Last updated</th>
              </tr>
            </thead>
            <tbody>
              {(
                supply.map(i => {
                  // Same rule as the KPI and the priority queue, so no two
                  // panels can disagree about a batch's evidence position.
                  const evidence = deriveCoaEvidence(i)
                  const thc = formatMeasurement(i.thcPct)
                  return (
                    <tr key={i.id}>
                      <td>
                        <div className="eo-td-primary">{i.productName}</div>
                        <div className="eo-id">{i.batchNumber || 'No batch number'}</div>
                      </td>
                      <td data-label="Supplier">{i.farmName}</td>
                      <td className="eo-td-num" data-label="Quantity (kg)">{i.quantityKg.toLocaleString()}</td>
                      {/* A measured 0% THC is a value, not a missing one. Only a
                          genuinely absent reading renders as unknown. */}
                      <td className="eo-td-num" data-label="THC %">
                        {thc === null
                          ? <span title="No THC reading reported">{MEASURE_UNKNOWN}</span>
                          : thc}
                      </td>
                      <td data-label="Evidence">
                        <span className={`eo-status eo-status--${EVIDENCE_TONE[evidence]}`}>
                          {COA_EVIDENCE_LABEL[evidence]}
                        </span>
                        <span className="eo-status-reason">{COA_EVIDENCE_REASON[evidence]}</span>
                      </td>
                      <td data-label="Review state">
                        <span className={`eo-status eo-status--${reviewTone(i.status)}`}>{i.status}</span>
                      </td>
                      <td data-label="Last updated">{formatDate(i.submittedAt)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </div>
  )
}

/** Visual weight for an existing InventoryStatus. The stored value is never
 *  reworded — only its prominence changes, so absence outranks presence. */
function reviewTone(status: InventoryItem['status']): StatusTone {
  switch (status) {
    case 'Missing Document': return 'critical'
    case 'Rejected': return 'high'
    case 'Pending Review': return 'review'
    case 'Approved': return 'evidence'
    default: return 'neutral'
  }
}
