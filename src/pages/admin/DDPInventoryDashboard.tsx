import type { InventoryItem, InventoryStatus } from '../../types'

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
                <th>Product / Strain</th>
                <th>Farm</th>
                <th>Location</th>
                <th>Qty (kg)</th>
                <th>Batch No.</th>
                <th>THC %</th>
                <th>CBD %</th>
                <th>Moisture %</th>
                <th>Grade</th>
                <th>COA</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {inventory.length === 0 ? (
                <tr><td colSpan={12} className="empty-table-cell">No inventory submissions yet. Batches submitted by suppliers will appear here.</td></tr>
              ) : inventory.map(item => (
                <tr key={item.id}>
                  <td className="td-bold" data-label="Product / Strain">{item.productName}</td>
                  <td data-label="Farm">{item.farmName}</td>
                  <td className="td-muted" data-label="Location">{item.location}</td>
                  <td className="td-num" data-label="Qty (kg)">{item.quantityKg.toLocaleString()}</td>
                  <td className="td-mono" data-label="Batch No.">{item.batchNumber || '—'}</td>
                  <td className="td-num" data-label="THC %">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                  <td className="td-num" data-label="CBD %">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                  <td className="td-num" data-label="Moisture %">{item.moisturePct > 0 ? `${item.moisturePct}%` : '—'}</td>
                  <td data-label="Grade"><span className="grade-chip">Grade {item.qualityGrade}</span></td>
                  <td data-label="COA">
                    {item.certFileName
                      ? <span className="coa-present">COA provided</span>
                      : <span className="coa-missing">COA missing</span>}
                  </td>
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
