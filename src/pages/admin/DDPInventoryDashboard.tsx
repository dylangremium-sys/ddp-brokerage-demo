import type { InventoryItem, InventoryStatus } from '../../types'
import { testStatusLabel, testStatusClass } from '../../data'

interface Props {
  inventory: InventoryItem[]
  onReview: (itemId: string) => void
}

const STATUS_CLASS: Record<InventoryStatus, string> = {
  'Pending Review': 'badge-pending',
  'Approved': 'badge-approved',
  'Missing Document': 'badge-missing',
  'Rejected': 'badge-rejected',
}

export default function DDPInventoryDashboard({ inventory, onReview }: Props) {
  const totalKg = inventory.reduce((s, i) => s + i.quantityKg, 0)
  const pending = inventory.filter(i => i.status === 'Pending Review').length
  const approvedKg = inventory.filter(i => i.status === 'Approved').reduce((s, i) => s + i.quantityKg, 0)
  const missing = inventory.filter(i => i.status === 'Missing Document').length
  const rejected = inventory.filter(i => i.status === 'Rejected').length
  const farms = new Set(inventory.map(i => i.farmName)).size

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — INVENTORY REVIEW</div>
        <h1 className="page-title">Inventory Dashboard</h1>
        <p className="page-desc">Review and manage all incoming farmer inventory submissions.</p>
      </div>

      <div className="summary-grid">
        <div className="summary-card s-total"><div className="summary-val">{totalKg.toLocaleString()}</div><div className="summary-lbl">Total kg</div></div>
        <div className="summary-card s-pending"><div className="summary-val">{pending}</div><div className="summary-lbl">Pending Review</div></div>
        <div className="summary-card s-approved"><div className="summary-val">{approvedKg.toLocaleString()}</div><div className="summary-lbl">Approved kg</div></div>
        <div className="summary-card s-missing"><div className="summary-val">{missing}</div><div className="summary-lbl">Missing Docs</div></div>
        <div className="summary-card s-rejected"><div className="summary-val">{rejected}</div><div className="summary-lbl">Rejected</div></div>
        <div className="summary-card s-farms"><div className="summary-val">{farms}</div><div className="summary-lbl">Farms</div></div>
      </div>

      <div className="card table-card">
        <div className="table-card-title">All Inventory Submissions — {inventory.length} {inventory.length === 1 ? 'batch' : 'batches'}</div>
        <div className="table-scroll">
          <table className="inv-table inv-table--cards">
            <thead>
              <tr>
                <th>Batch ID</th>
                <th>Genotype / Strain</th>
                <th>THC %</th>
                <th>CBD %</th>
                <th>Microbial</th>
                <th>Heavy Metals</th>
                <th>Allocatable Qty (kg)</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {inventory.length === 0 ? (
                <tr><td colSpan={9} className="empty-table-cell">NO RECORDS ON FILE</td></tr>
              ) : inventory.map(item => (
                <tr key={item.id}>
                  <td className="td-mono" data-label="Batch ID">{item.batchNumber || '—'}</td>
                  <td data-label="Genotype / Strain">
                    <span className="td-bold">{item.productName}</span>
                    <br /><span className="td-muted">{item.farmName}</span>
                  </td>
                  <td className="td-num td-mono" data-label="THC %">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                  <td className="td-num td-mono" data-label="CBD %">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                  <td data-label="Microbial"><span className={testStatusClass(item.microbialStatus)}>{testStatusLabel(item.microbialStatus)}</span></td>
                  <td data-label="Heavy Metals"><span className={testStatusClass(item.heavyMetalsStatus)}>{testStatusLabel(item.heavyMetalsStatus)}</span></td>
                  <td className="td-num" data-label="Allocatable Qty (kg)">{item.quantityKg.toLocaleString()}</td>
                  <td data-label="Status"><span className={`badge ${STATUS_CLASS[item.status]}`}>{item.status}</span></td>
                  <td>
                    <button className="btn btn-review" onClick={() => onReview(item.id)}>Open Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
