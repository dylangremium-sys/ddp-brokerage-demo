import { useEffect, useMemo, useState } from 'react'
import type { ComplianceAlert, ComplianceRule, FarmProfile, InventoryItem, RiskSeverity, RiskStatus } from '../../types'
import { deriveAutoRisks } from '../../lib/procurementControl'
import {
  resolveRiskOverrides,
  recordRiskOverride,
  isEffectiveOverride,
  type BatchOverrideResolution,
  type ResolvedRiskOverride,
} from '../../lib/procurementOverrideStore'
import BrowserOnlyProvenanceNotice from '../../components/shared/BrowserOnlyProvenanceNotice'
import { getComplianceRuleImpact } from '../../lib/complianceRuleImpact'
import { EvidenceBadge, ComplianceRuleCheckBadge } from '../../components/shared/StatusBadge'

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  onReviewFarm?: (farmId: string) => void
  onReviewItem?: (itemId: string) => void
  complianceRules?: ComplianceRule[]
  complianceAlerts?: ComplianceAlert[]
}

const SEVERITY_CLASS: Record<RiskSeverity, string> = {
  low: 'badge-gray',
  medium: 'badge-pending',
  high: 'badge-risk-high',
  blocker: 'badge-rejected',
}

const STATUS_OPTIONS: RiskStatus[] = ['open', 'in_review', 'resolved', 'accepted']

const STATUS_LABEL: Record<RiskStatus, string> = {
  open: 'Open',
  in_review: 'In Review',
  resolved: 'Resolved',
  accepted: 'Accepted',
}

export default function DDPRiskRegister({ farms, inventory, onReviewFarm, onReviewItem, complianceRules = [], complianceAlerts = [] }: Props) {
  const [severityFilter, setSeverityFilter] = useState<RiskSeverity | 'all'>('all')

  // The auto-derived risks are a pure function of the props — no override is
  // folded in here. Overrides are applied only from the AUTHORITATIVE resolution
  // below, never synchronously from raw localStorage: this page's statuses are
  // half of the release gate (hasBlockingIssues), and a status the server never
  // accepted must not be rendered as if it were on record.
  const autoRisks = useMemo(() => deriveAutoRisks(farms, inventory), [farms, inventory])

  // Stable primitive dep: the resolve must re-run when the SET of risk ids
  // changes, not on every re-render that rebuilds an equal array. The ids are
  // content-bound (composeRiskId), so a risk whose severity/issue changed is a
  // new key and its superseded override simply never matches.
  const riskKey = useMemo(() => autoRisks.map(r => r.riskId).join(' '), [autoRisks])

  // null = the authoritative read has not settled. The resolution is stored
  // WITH the key it was read for, and staleness is DERIVED rather than reset
  // inside the effect (the eslint react-hooks/set-state-in-effect rule forbids
  // the reset, and deriving is also simply correct: a changed risk set reads as
  // 'loading' in the very same render that changed it, so there is no window in
  // which the previous set's overrides are applied to this one).
  const [resolvedOverrides, setResolvedOverrides] =
    useState<{ key: string; value: BatchOverrideResolution<ResolvedRiskOverride> } | null>(null)
  const resolution = resolvedOverrides !== null && resolvedOverrides.key === riskKey ? resolvedOverrides.value : null

  useEffect(() => {
    let cancelled = false
    void resolveRiskOverrides(riskKey === '' ? [] : riskKey.split(' ')).then(
      next => { if (!cancelled) setResolvedOverrides({ key: riskKey, value: next }) },
      (err: unknown) => {
        if (cancelled) return
        // resolveRiskOverrides reports read failures in-band; this is the
        // belt-and-braces path for an unexpected throw. Fail closed identically.
        const message = err instanceof Error ? err.message : 'The risk overrides could not be read.'
        setResolvedOverrides({ key: riskKey, value: { byKey: new Map(), unavailable: true, error: message } })
      },
    )
    return () => { cancelled = true }
  }, [riskKey])

  // Overrides may be shown as applied ONLY from a settled, successful read.
  // While loading, and whenever the read failed, the derived statuses stand —
  // 'unavailable' is not "no overrides", so nothing here may substitute the
  // cache or render a clearance the server has not confirmed.
  const overridesLive = resolution !== null && !resolution.unavailable
  const risks = useMemo(() => {
    if (resolution === null || resolution.unavailable) return autoRisks
    return autoRisks.map(risk => {
      const override = resolution.byKey.get(risk.riskId)
      if (!override || override.status === null || !isEffectiveOverride(override.source)) return risk
      return { ...risk, status: override.status, owner: override.owner ?? risk.owner }
    })
  }, [autoRisks, resolution])

  // How many of the risks ON THIS PAGE are showing a BROWSER-ONLY override.
  // Server-recorded overrides are durable, attributed rows and are deliberately
  // NOT counted — the notice exists to flag records that other admins cannot see
  // and sign-out destroys, and a server row is neither. Counted against the live
  // risk ids, so a superseded override (one whose risk content has since
  // changed, and which is therefore inert — see composeRiskId) is correctly NOT
  // counted: it is not affecting anything an operator can see.
  // Only overrides that exist ONLY in this browser are warned about. The
  // resolved source is the single authority for that — a raw localStorage read
  // would over-count, because the store write-throughs mean the cache also holds
  // copies of durable, attributed SERVER rows. On a failed or unsettled read the
  // count is 0, which is correct: the fail-closed branch above applies no
  // override at all, so nothing browser-local is in effect to warn about.
  const overriddenCount = useMemo(() => {
    if (resolution === null || resolution.unavailable) return 0
    return risks.filter(r => resolution.byKey.get(r.riskId)?.source === 'local-cache').length
  }, [risks, resolution])

  const visible = severityFilter === 'all' ? risks : risks.filter(r => r.severity === severityFilter)
  const openCount = risks.filter(r => r.status === 'open').length
  const blockerCount = risks.filter(r => r.severity === 'blocker' && r.status !== 'resolved' && r.status !== 'accepted').length

  // A status change is STAGED, not written. recordRiskOverride refuses a blank
  // reason (as does the DB CHECK behind it), and fabricating one client-side
  // would be worse than no override — it would launder an unexplained clearance
  // into the audit trail. So the select only stages the change; the write
  // happens when the operator supplies the reason and confirms.
  const [pending, setPending] = useState<{ riskId: string; status: RiskStatus } | null>(null)
  const [pendingReason, setPendingReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)

  function handleStatusPick(riskId: string, status: RiskStatus, currentStatus: RiskStatus) {
    setWriteError(null)
    // Re-picking the current status is a cancellation, not a change — recording
    // a no-op override would create an audit row that decides nothing.
    if (status === currentStatus) {
      setPending(null)
      setPendingReason('')
      return
    }
    setPending({ riskId, status })
    setPendingReason('')
  }

  function handleCancelPending() {
    setPending(null)
    setPendingReason('')
    setWriteError(null)
  }

  async function handleRecordOverride() {
    if (!pending || saving) return
    const reason = pendingReason.trim()
    if (!reason) return // the button is disabled without one; this mirrors the store's own refusal
    setSaving(true)
    setWriteError(null)

    // The whole sequence is guarded and `saving` is released in `finally`.
    // recordRiskOverride reports refusals in-band (ok: false), but it can still
    // REJECT — localStorage throwing while refreshing the cache, or any
    // unexpected client/network exception. Releasing `saving` only on the
    // in-band paths left every status control permanently disabled on a
    // rejection, and produced an unhandled rejection alongside it.
    try {
      const result = await recordRiskOverride({ riskId: pending.riskId, status: pending.status, reason })

      if (!result.ok) {
        // The server REFUSED the write. The store deliberately cached nothing, so
        // the displayed status must not move: surface the error and keep the
        // staged change so the operator can retry or abandon it knowingly.
        setWriteError(result.error ?? 'The override could not be recorded.')
        return
      }

      // Accepted (server) or deliberately local (table absent / demo mode).
      // Re-resolve so the displayed status and its provenance come from the
      // authoritative source, never from what this handler assumed took effect.
      const next = await resolveRiskOverrides(riskKey === '' ? [] : riskKey.split(' '))
      setResolvedOverrides({ key: riskKey, value: next })
      setPending(null)
      setPendingReason('')
    } catch (err: unknown) {
      // The staged change is kept so the operator can retry. The displayed
      // status is untouched — it is only ever rendered from the resolution — so
      // a write whose outcome is unknown cannot appear applied.
      setWriteError(err instanceof Error ? err.message : 'The override could not be recorded.')
    } finally {
      setSaving(false)
    }
  }

  function farmName(farmId?: string): string {
    return farms.find(f => f.id === farmId)?.tradingName || '—'
  }

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — PROCUREMENT AUTHORITY</div>
        <h1 className="page-title">Risk Register</h1>
        <p className="page-desc">
          Gaps and failures found by scanning the actual farm and batch records — nothing here is invented. Severity, owner,
          and status are for DDP staff to assess and update.
        </p>
      </div>

      <div className="summary-grid-8">
        <div className="summary-card s-total"><div className="summary-val">{risks.length}</div><div className="summary-lbl">Total Risks on File</div></div>
        <div className="summary-card s-pending"><div className="summary-val">{openCount}</div><div className="summary-lbl">Open</div></div>
        <div className="summary-card s-missing"><div className="summary-val">{blockerCount}</div><div className="summary-lbl">Unresolved Blockers</div></div>
      </div>

      {/* Three distinct read states, never conflated. A still-loading or failed
          authoritative read must not render as "no overrides" — that is a
          positive claim neither state supports. Same contract as the Qualified
          Buyer Preview list and the buyer-pack decision panel. */}
      {resolution === null && (
        <div className="card" role="status" style={{ padding: 12, marginTop: 12, fontSize: 12.5, color: 'var(--text-muted)' }}>
          Checking the recorded risk status overrides against the server… Statuses below are the derived ones until this settles.
        </div>
      )}
      {resolution !== null && resolution.unavailable && (
        <div className="card" role="status" style={{ padding: 12, marginTop: 12, fontSize: 12.5, color: 'var(--warning)' }}>
          ⚠ The risk status overrides could not be verified against the server, so the authoritative status of every risk
          below is <strong>unknown</strong>. This is <strong>not</strong> a statement that no overrides exist. Statuses shown
          are the derived ones only, and no override can be recorded until the read succeeds.
          {resolution.error ? ` (${resolution.error})` : ''}
        </div>
      )}

      {/* Provenance. A risk status moved to Resolved/Accepted here is half of the
          release gate (hasBlockingIssues). Overrides recorded on the server are
          durable and attributed; the ones this notice counts are only in this
          browser, and the operator is entitled to know that before relying on
          them. */}
      <BrowserOnlyProvenanceNotice count={overriddenCount} subject="risk status overrides" />

      <div className="toolbar-row" style={{ marginTop: 20 }}>
        <select className="toolbar-select" value={severityFilter} onChange={e => setSeverityFilter(e.target.value as RiskSeverity | 'all')}>
          <option value="all">All severities</option>
          <option value="blocker">Blocker</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <span className="toolbar-count">{visible.length} of {risks.length} risks</span>
      </div>

      {visible.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          No risks on file matching this filter.
        </div>
      ) : (
        <div className="card table-card" style={{ marginTop: 12 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--cards">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Farm / Batch</th>
                  <th>Issue</th>
                  <th>Required Action</th>
                  <th>Owner</th>
                  <th>Evidence</th>
                  <th>Compliance Rule Check</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(risk => {
                  const item = risk.batchId ? inventory.find(i => i.id === risk.batchId) : undefined
                  const ruleImpact = item
                    ? getComplianceRuleImpact('batch', item.id, complianceRules, complianceAlerts)
                    : getComplianceRuleImpact('farm', risk.farmId, complianceRules, complianceAlerts)
                  const override = resolution?.byKey.get(risk.riskId)
                  const isPendingRow = pending?.riskId === risk.riskId
                  return (
                    <tr key={risk.riskId}>
                      <td data-label="Severity"><span className={`badge ${SEVERITY_CLASS[risk.severity]}`}>{risk.severity.toUpperCase()}</span></td>
                      <td data-label="Farm / Batch">
                        <span className="td-bold">{item ? (item.productName || 'Unnamed batch') : farmName(risk.farmId)}</span>
                        {item && <><br /><span className="td-muted">{farmName(risk.farmId)}</span></>}
                      </td>
                      <td data-label="Issue" style={{ maxWidth: 260 }}>{risk.issue}</td>
                      <td data-label="Required Action" style={{ maxWidth: 260 }}>{risk.requiredAction}</td>
                      <td data-label="Owner">{risk.owner}</td>
                      <td data-label="Evidence"><EvidenceBadge status={risk.evidenceStatus} /></td>
                      <td data-label="Compliance Rule Check">
                        <ComplianceRuleCheckBadge impact={ruleImpact} />
                      </td>
                      <td data-label="Status">
                        <select
                          value={isPendingRow ? pending.status : risk.status}
                          onChange={e => handleStatusPick(risk.riskId, e.target.value as RiskStatus, risk.status)}
                          // Editing is gated on a settled successful read: staging a
                          // change against a status the server has not confirmed
                          // would invite overriding the wrong baseline.
                          disabled={!overridesLive || saving}
                          title={overridesLive ? undefined : 'Overrides cannot be changed until the authoritative override state has been read.'}
                          style={{ fontSize: 12.5 }}
                        >
                          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                        {isPendingRow && (
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 220 }}>
                            {/* A reason is REQUIRED — the store (and the DB CHECK
                                behind it) refuses a blank one, and nothing is
                                auto-filled: an invented reason would defeat the
                                point of recording one. */}
                            <input
                              type="text"
                              value={pendingReason}
                              onChange={e => setPendingReason(e.target.value)}
                              placeholder="Reason (required — recorded in the audit trail)"
                              style={{ fontSize: 12, width: '100%' }}
                            />
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                className="btn btn-review"
                                onClick={() => { void handleRecordOverride() }}
                                disabled={!pendingReason.trim() || saving}
                              >
                                {saving ? 'Recording…' : 'Record'}
                              </button>
                              <button type="button" className="btn btn-ghost" onClick={handleCancelPending} disabled={saving}>
                                Cancel
                              </button>
                            </div>
                            {writeError && (
                              <div style={{ fontSize: 12, color: 'var(--danger, #b00020)' }}>{writeError}</div>
                            )}
                          </div>
                        )}
                        {/* Per-row provenance, decision-panel vocabulary — one
                            vocabulary for one property. Shown only for an
                            override actually in effect on this row. */}
                        {!isPendingRow && override && override.status !== null && override.source === 'server' && (
                          <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                            ✓ Recorded server-side (append-only, attributed to the signed-in admin).
                          </div>
                        )}
                        {!isPendingRow && override && override.status !== null && override.source === 'local-cache' && (
                          <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                            ⚠ This override exists only in this browser.
                          </div>
                        )}
                      </td>
                      <td>
                        {item && onReviewItem && <button className="btn btn-review" onClick={() => onReviewItem(item.id)}>Open Batch</button>}
                        {!item && risk.farmId && onReviewFarm && <button className="btn btn-review" onClick={() => onReviewFarm(risk.farmId!)}>Open Farm</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
