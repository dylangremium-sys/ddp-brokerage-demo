import type { FarmProfile, InventoryItem } from '../../types'
import { deriveCoaIntelligence } from '../../lib/procurementControl'
import { EvidenceBadge } from '../../components/shared/StatusBadge'

interface Props {
  inventory: InventoryItem[]
  farms: FarmProfile[]
}

function na(val: string | number | undefined): string {
  return val === undefined || val === '' ? '—' : String(val)
}

export default function DDPCoaIntelligence({ inventory, farms }: Props) {
  const rows = inventory.map(item => ({
    item,
    coa: deriveCoaIntelligence(item),
    farm: farms.find(f => f.id === item.farmId || f.tradingName === item.farmName || f.legalBusinessName === item.farmName),
  }))
  const flaggedCount = rows.filter(r => r.coa.redFlags.length > 0).length

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — PROCUREMENT AUTHORITY</div>
        <h1 className="page-title">COA Intelligence</h1>
        <p className="page-desc">
          Structured lab-result summary per batch, built only from values already recorded on that batch — plus any gaps or failures that need attention.
        </p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>NOTE</span>
        <div>
          All values below are as typed by the farm from its COA. Each batch's <strong>Evidence</strong> column shows whether a
          COA file was actually received, or only claimed — none of these figures are independently verified. Open the
          source COA and compare before relying on any figure commercially.
        </div>
      </div>

      {inventory.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No inventory batches on file.</div>
      ) : (
        <>
          <div className="summary-grid-8" style={{ marginTop: 20 }}>
            <div className="summary-card s-total"><div className="summary-val">{rows.length}</div><div className="summary-lbl">Batches on File</div></div>
            <div className="summary-card s-missing"><div className="summary-val">{flaggedCount}</div><div className="summary-lbl">Batches with Red Flags</div></div>
          </div>

          <div className="card table-card" style={{ marginTop: 20 }}>
            <div className="table-scroll">
              <table className="inv-table inv-table--cards">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Farm</th>
                    <th>Lab</th>
                    <th>Report #</th>
                    <th>Test Date</th>
                    <th>THC %</th>
                    <th>CBD %</th>
                    <th>Terpenes %</th>
                    <th>Moisture %</th>
                    <th>Heavy Metals</th>
                    <th>Pesticides</th>
                    <th>Mycotoxins</th>
                    <th>Microbial</th>
                    <th>Evidence</th>
                    <th>Red Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ item, coa, farm }) => (
                    <tr key={item.id}>
                      <td data-label="Batch">
                        <span className="td-bold">{coa.strainName || 'Unnamed batch'}</span>
                        <br /><span className="td-muted mono">{na(coa.batchNumber)}</span>
                      </td>
                      <td data-label="Farm">{farm?.tradingName || item.farmName || '—'}</td>
                      <td data-label="Lab">{na(coa.labName)}</td>
                      <td data-label="Report #" className="mono">{na(coa.reportNumber)}</td>
                      <td data-label="Test Date">{na(coa.reportDate)}</td>
                      <td data-label="THC %" className="td-num td-mono">{coa.totalThcPercent ? `${coa.totalThcPercent}%` : '—'}</td>
                      <td data-label="CBD %" className="td-num td-mono">{coa.totalCbdPercent ? `${coa.totalCbdPercent}%` : '—'}</td>
                      <td data-label="Terpenes %" className="td-num td-mono">{coa.totalTerpenesPercent ? `${coa.totalTerpenesPercent}%` : '—'}</td>
                      <td data-label="Moisture %" className="td-num td-mono">{coa.moisturePercent ? `${coa.moisturePercent}%` : '—'}</td>
                      <td data-label="Heavy Metals">{na(coa.heavyMetalsStatus)}</td>
                      <td data-label="Pesticides">{na(coa.pesticidesStatus)}</td>
                      <td data-label="Mycotoxins">{na(coa.mycotoxinsStatus)}</td>
                      <td data-label="Microbial">{na(coa.microbialStatus)}</td>
                      <td data-label="Evidence"><EvidenceBadge status={coa.evidenceStatus} /></td>
                      <td data-label="Red Flags">
                        {coa.redFlags.length === 0
                          ? <span className="td-muted">None on file</span>
                          : <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                              {coa.redFlags.map((f, i) => <li key={i} style={{ color: 'var(--error)' }}>{f}</li>)}
                            </ul>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
