import type { InventoryItem, InventoryStatus } from '../types'

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
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS</div>
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
        <div className="table-card-title">All Inventory Submissions</div>
        <div className="table-scroll">
          <table className="inv-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Farm</th>
                <th>Location</th>
                <th>Qty (kg)</th>
                <th>Batch</th>
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
              {inventory.map(item => (
                <tr key={item.id}>
                  <td className="td-bold">{item.productName}</td>
                  <td>{item.farmName}</td>
                  <td className="td-muted">{item.location}</td>
                  <td className="td-num">{item.quantityKg.toLocaleString()}</td>
                  <td className="td-mono">{item.batchNumber || '—'}</td>
                  <td className="td-num">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                  <td className="td-num">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                  <td className="td-num">{item.moisturePct > 0 ? `${item.moisturePct}%` : '—'}</td>
                  <td><span className="grade-chip">Grade {item.qualityGrade}</span></td>
                  <td>
                    {item.certFileName
                      ? <span className="coa-present">✓</span>
                      : <span className="coa-missing">✗ Missing</span>}
                  </td>
                  <td><span className={`badge ${STATUS_CLASS[item.status]}`}>{item.status}</span></td>
                  <td>
                    <button className="btn btn-review" onClick={() => onReview(item.id)}>Review</button>
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
