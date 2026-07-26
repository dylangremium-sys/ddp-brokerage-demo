import { useMemo, useState } from 'react'
import type { ComplianceAlert, ComplianceRule, FarmProfile, InventoryItem, RiskSeverity, RiskStatus } from '../../types'
import { deriveAutoRisks, applyRiskOverrides, saveRiskOverride, loadRiskOverrides } from '../../lib/procurementControl'
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
  const [renderTick, forceRerender] = useState(0)
  const [severityFilter, setSeverityFilter] = useState<RiskSeverity | 'all'>('all')

  // renderTick is a dependency (not just farms/inventory) because saved risk
  // overrides live in localStorage, not in these props — bumping the tick
  // after a save is what makes applyRiskOverrides pick up the fresh value.
  const risks = useMemo(() => {
    void renderTick // deliberate recompute trigger — overrides live in localStorage, not in props
    return applyRiskOverrides(deriveAutoRisks(farms, inventory))
  }, [farms, inventory, renderTick])
  // How many of the risks ON THIS PAGE are showing a browser-local override
  // rather than their derived status. Counted against the live risk ids, so a
  // superseded override (one whose risk content has since changed, and which is
  // therefore inert — see composeRiskId) is correctly NOT counted: it is not
  // affecting anything an operator can see.
  const overriddenCount = useMemo(() => {
    void renderTick
    const overrides = loadRiskOverrides()
    return risks.filter(r => overrides[r.riskId] !== undefined).length
  }, [risks, renderTick])

  const visible = severityFilter === 'all' ? risks : risks.filter(r => r.severity === severityFilter)
  const openCount = risks.filter(r => r.status === 'open').length
  const blockerCount = risks.filter(r => r.severity === 'blocker' && r.status !== 'resolved' && r.status !== 'accepted').length

  function handleStatusChange(riskId: string, status: RiskStatus) {
    saveRiskOverride(riskId, status)
    forceRerender(n => n + 1)
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

      {/* Provenance. A risk status moved to Resolved/Accepted here is half of the
          release gate (hasBlockingIssues), yet it is written only to this
          browser. The operator is entitled to know that before relying on it. */}
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
                        <select value={risk.status} onChange={e => handleStatusChange(risk.riskId, e.target.value as RiskStatus)} style={{ fontSize: 12.5 }}>
                          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
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
