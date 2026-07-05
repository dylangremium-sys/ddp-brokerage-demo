import { Fragment, useState } from 'react'
import type { DocumentRequirementType, EvidenceStatus, FarmProfile, InventoryItem } from '../../types'
import {
  DOCUMENT_REQUIREMENT_TYPES,
  DOCUMENT_REQUIREMENT_LABELS,
  deriveFarmDocumentRequirements,
  applyRequirementOverrides,
  saveRequirementOverride,
} from '../../lib/procurementControl'

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
}

// The matrix uses its own six-word vocabulary (per the procurement plan) —
// distinct from, but derived from, the underlying EvidenceStatus.
type MatrixLabel = 'Received' | 'Partial' | 'Missing' | 'Reviewed' | 'Verified' | 'Blocker'

const MATRIX_LABEL: Record<EvidenceStatus, MatrixLabel> = {
  claimed: 'Partial',
  documented: 'Received',
  reviewed: 'Reviewed',
  verified: 'Verified',
  missing: 'Missing',
  rejected: 'Blocker',
  expired: 'Blocker',
}

const MATRIX_CLASS: Record<MatrixLabel, string> = {
  Received: 'status-documented',
  Partial: 'status-claimed',
  Missing: 'status-missing',
  Reviewed: 'status-reviewed',
  Verified: 'status-verified',
  Blocker: 'status-reject',
}

const OVERRIDE_OPTIONS: EvidenceStatus[] = ['claimed', 'documented', 'reviewed', 'verified', 'missing', 'rejected', 'expired']

export default function DDPMissingDocuments({ farms, inventory }: Props) {
  const [openFarmId, setOpenFarmId] = useState<string | null>(null)
  const [, forceRerender] = useState(0)

  const rows = farms.map(farm => {
    const requirements = applyRequirementOverrides(deriveFarmDocumentRequirements(farm, inventory))
    const blockerCount = requirements.filter(r => MATRIX_LABEL[r.status] === 'Blocker').length
    const missingCount = requirements.filter(r => r.status === 'missing').length
    const receivedCount = requirements.filter(r => r.status === 'documented' || r.status === 'reviewed' || r.status === 'verified').length
    return { farm, requirements, blockerCount, missingCount, receivedCount }
  })

  function handleOverride(farmId: string, type: DocumentRequirementType, status: EvidenceStatus) {
    saveRequirementOverride(farmId, type, status)
    forceRerender(n => n + 1)
  }

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — PROCUREMENT AUTHORITY</div>
        <h1 className="page-title">Missing Document Matrix</h1>
        <p className="page-desc">
          Every required document or evidence item, per farm, labelled by evidence level — not by whether a field was typed in.
        </p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>NOTE</span>
        <div>
          Most farm-level fields are free-text claims, not uploaded files. They can only read as <strong>Partial</strong> (claimed) or <strong>Missing</strong> here
          until a real document is received. <strong>Reviewed</strong> and <strong>Verified</strong> only appear once a DDP reviewer or qualified party has explicitly recorded that step below.
        </div>
      </div>

      {farms.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No farm profiles on file.</div>
      ) : (
        <div className="card table-card" style={{ marginTop: 20 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--compact">
              <thead>
                <tr>
                  <th>Farm</th>
                  <th>Received</th>
                  <th>Missing</th>
                  <th>Blockers</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ farm, blockerCount, missingCount, receivedCount, requirements }) => (
                  <Fragment key={farm.id}>
                    <tr>
                      <td className="td-bold">{farm.tradingName}</td>
                      <td className="td-num">{receivedCount}/{DOCUMENT_REQUIREMENT_TYPES.length}</td>
                      <td className="td-num">{missingCount}</td>
                      <td className="td-num">{blockerCount > 0 ? <span className="status-pill status-reject">{blockerCount}</span> : '—'}</td>
                      <td>
                        <button className="btn btn-review" onClick={() => setOpenFarmId(openFarmId === farm.id ? null : farm.id)}>
                          {openFarmId === farm.id ? 'Close' : 'Open Matrix'}
                        </button>
                      </td>
                    </tr>
                    {openFarmId === farm.id && (
                      <tr>
                        <td colSpan={5} style={{ padding: 0, background: 'var(--bg-elevated)' }}>
                          <div style={{ padding: '16px 20px' }}>
                            <div className="detail-rows">
                              {requirements.map(req => (
                                <div className="detail-row" key={req.type} style={{ alignItems: 'flex-start' }}>
                                  <span className="dl">{DOCUMENT_REQUIREMENT_LABELS[req.type]}</span>
                                  <span className="dv" style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                                    <span className={`status-pill ${MATRIX_CLASS[MATRIX_LABEL[req.status]]}`}>{MATRIX_LABEL[req.status]}</span>
                                    {req.reference && <span className="td-muted" style={{ fontSize: 11.5 }}>{req.reference}</span>}
                                    {req.notes && <span className="td-muted" style={{ fontSize: 11.5, maxWidth: 320, textAlign: 'right' }}>{req.notes}</span>}
                                    <select
                                      value={req.status}
                                      onChange={e => handleOverride(farm.id, req.type, e.target.value as EvidenceStatus)}
                                      style={{ fontSize: 12 }}
                                    >
                                      {OVERRIDE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
