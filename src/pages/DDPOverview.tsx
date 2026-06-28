import { farmTotalScore } from '../data'
import type { FarmProfile, InventoryItem, FarmStatus, InventoryStatus } from '../types'

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  onReviewFarm: (id: string) => void
  onReviewItem: (id: string) => void
}

const INV_STATUS_CLASS: Record<InventoryStatus, string> = {
  'Pending Review': 'badge-pending',
  'Approved': 'badge-approved',
  'Missing Document': 'badge-missing',
  'Rejected': 'badge-rejected',
}

const FARM_STATUS_CLASS: Record<FarmStatus, string> = {
  'Draft': 'badge-gray',
  'Submitted to DDP': 'badge-pending',
  'Under Review': 'badge-blue',
  'More Information Required': 'badge-orange',
  'Approved': 'badge-approved',
  'Watchlist': 'badge-rejected',
  'Strategic Partner': 'badge-purple',
  'Rejected': 'badge-rejected',
}

export default function DDPOverview({ farms, inventory, onReviewFarm, onReviewItem }: Props) {
  const totalFarms = farms.length
  const pendingFarms = farms.filter(f => f.status === 'Submitted to DDP' || f.status === 'Under Review').length
  const approvedFarms = farms.filter(f => f.status === 'Approved' || f.status === 'Strategic Partner').length
  const watchlistFarms = farms.filter(f => f.status === 'Watchlist').length
  const totalKg = inventory.reduce((s, i) => s + i.quantityKg, 0)
  const approvedKg = inventory.filter(i => i.status === 'Approved').reduce((s, i) => s + i.quantityKg, 0)
  const missingDocItems = inventory.filter(i => i.status === 'Missing Document').length
  const exportReadyFarms = farms.filter(f => f.exportLicence && f.exportLicence !== '').length

  const recentFarms = [...farms].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()).slice(0, 3)
  const recentInventory = [...inventory].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()).slice(0, 3)
  const riskAlertFarms = farms.filter(f => f.status === 'More Information Required' || f.status === 'Watchlist')
  const riskAlertInventory = inventory.filter(i => i.status === 'Missing Document')
  const topInventory = [...inventory].sort((a, b) => b.quantityKg - a.quantityKg).slice(0, 5)
  const topFarms = [...farms].sort((a, b) => farmTotalScore(b) - farmTotalScore(a)).slice(0, 3)

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS</div>
        <h1 className="page-title">Overview Dashboard</h1>
        <p className="page-desc">Supply intelligence summary across all farms and inventory submissions.</p>
      </div>

      <div className="summary-grid-8">
        <SummaryCard val={totalFarms} lbl="Total Farms" cls="s-total" />
        <SummaryCard val={pendingFarms} lbl="Pending Review" cls="s-pending" />
        <SummaryCard val={approvedFarms} lbl="Approved Farms" cls="s-approved" />
        <SummaryCard val={watchlistFarms} lbl="Watchlist" cls="s-rejected" />
        <SummaryCard val={`${totalKg.toLocaleString()} kg`} lbl="Total Inventory" cls="s-total" />
        <SummaryCard val={`${approvedKg.toLocaleString()} kg`} lbl="Approved Inventory" cls="s-approved" />
        <SummaryCard val={missingDocItems} lbl="Missing Docs" cls="s-missing" />
        <SummaryCard val={exportReadyFarms} lbl="Export-Ready Farms" cls="s-farms" />
      </div>

      <div className="overview-grid">
        <div>
          <div className="section-label-row"><div className="section-label">Recent Farm Submissions</div></div>
          <div className="card table-card">
            <table className="inv-table">
              <thead><tr><th>Farm</th><th>Province</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {recentFarms.map(f => (
                  <tr key={f.id}>
                    <td className="td-bold">{f.tradingName}</td>
                    <td>{f.province}</td>
                    <td><span className={`badge ${FARM_STATUS_CLASS[f.status]}`}>{f.status}</span></td>
                    <td><button className="btn btn-review" onClick={() => onReviewFarm(f.id)}>Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="section-label-row"><div className="section-label">Recent Inventory Submissions</div></div>
          <div className="card table-card">
            <table className="inv-table">
              <thead><tr><th>Product</th><th>Farm</th><th>Qty (kg)</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {recentInventory.map(i => (
                  <tr key={i.id}>
                    <td className="td-bold">{i.productName}</td>
                    <td>{i.farmName}</td>
                    <td className="td-num">{i.quantityKg.toLocaleString()}</td>
                    <td><span className={`badge ${INV_STATUS_CLASS[i.status]}`}>{i.status}</span></td>
                    <td><button className="btn btn-review" onClick={() => onReviewItem(i.id)}>Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {(riskAlertFarms.length > 0 || riskAlertInventory.length > 0) && (
        <div style={{ marginTop: 24 }}>
          <div className="section-label-row"><div className="section-label" style={{ color: '#dc2626' }}>⚠ Risk Alerts</div></div>
          <div className="card" style={{ padding: '16px 20px' }}>
            {riskAlertFarms.map(f => (
              <div key={f.id} className="risk-alert-row">
                <span className="risk-icon">🏭</span>
                <span className="risk-name">{f.tradingName}</span>
                <span className={`badge ${FARM_STATUS_CLASS[f.status]}`}>{f.status}</span>
                <button className="btn btn-review" onClick={() => onReviewFarm(f.id)}>Review</button>
              </div>
            ))}
            {riskAlertInventory.map(i => (
              <div key={i.id} className="risk-alert-row">
                <span className="risk-icon">📦</span>
                <span className="risk-name">{i.productName} — {i.farmName}</span>
                <span className="badge badge-missing">Missing Document</span>
                <button className="btn btn-review" onClick={() => onReviewItem(i.id)}>Review</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="overview-grid" style={{ marginTop: 24 }}>
        <div>
          <div className="section-label-row"><div className="section-label">Top Inventory by Quantity</div></div>
          <div className="card table-card">
            <table className="inv-table">
              <thead><tr><th>Product</th><th>Farm</th><th>Qty (kg)</th><th>Grade</th><th>Status</th></tr></thead>
              <tbody>
                {topInventory.map(i => (
                  <tr key={i.id}>
                    <td className="td-bold">{i.productName}</td>
                    <td>{i.farmName}</td>
                    <td className="td-num">{i.quantityKg.toLocaleString()}</td>
                    <td><span className="grade-chip">Grade {i.qualityGrade}</span></td>
                    <td><span className={`badge ${INV_STATUS_CLASS[i.status]}`}>{i.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="section-label-row"><div className="section-label">Highest Scoring Farms</div></div>
          <div className="card" style={{ overflow: 'hidden' }}>
            {topFarms.map(f => {
              const total = farmTotalScore(f)
              const avg = Math.round(total / 9)
              return (
                <div key={f.id} className="score-farm-row">
                  <div>
                    <div className="score-farm-name">{f.tradingName}</div>
                    <div className="score-farm-province">{f.province}</div>
                  </div>
                  <div className="score-farm-right">
                    <div className="score-farm-total">{total} / 900</div>
                    <div className="score-bar-mini-wrap">
                      <div className="score-bar-mini" style={{ width: `${avg}%` }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ val, lbl, cls }: { val: string | number; lbl: string; cls: string }) {
  return (
    <div className={`summary-card ${cls}`}>
      <div className="summary-val">{val}</div>
      <div className="summary-lbl">{lbl}</div>
    </div>
  )
}
