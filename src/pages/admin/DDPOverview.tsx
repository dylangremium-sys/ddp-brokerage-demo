import { farmTotalScore, isFarmScored } from '../../data'
import { displayName, shortIdentifier } from '../../lib/entityName'
import type { FarmProfile, InventoryItem, FarmStatus, InventoryStatus } from '../../types'

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
  'Under Review': 'badge-under-review',
  'More Information Required': 'badge-orange',
  'Approved': 'badge-approved',
  'Watchlist': 'badge-watchlist',
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
  // ONLY FARMS THAT HAVE ACTUALLY BEEN SCORED. Nothing computes these values for
  // a real farm (see isFarmScored in data.ts), so every Supabase-backed farm has
  // a total of 0 — and without this filter the panel lists them as "Top-Scored"
  // and prints "0 / 900" beside each one. That is a ranking of things that were
  // never ranked, and it contradicted the review page once that page started
  // saying "Not yet scored" for the same farm.
  const topFarms = [...farms].filter(isFarmScored).sort((a, b) => farmTotalScore(b) - farmTotalScore(a)).slice(0, 3)

  return (
    <div className="eo-page">
      <header className="eo-page-head">
        <div className="eo-eyebrow">DDP OPERATIONS</div>
        <h1 className="eo-title">Operations Overview</h1>
        <p className="eo-page-desc">Supply intelligence summary — all farm registrations, inventory submissions, and compliance status.</p>
      </header>

      <div className="eo-kpi-strip">
        <SummaryCard val={totalFarms} lbl="Registered Farms" cls="s-total" />
        {/* NAMED FOR WHAT IT COUNTS. This counts FARMS at 'Submitted to DDP'
            or 'Under Review'; it has never had anything to do with documents.
            Labelled "Awaiting Review" on a console whose sidebar also carries
            Evidence, it read as the evidence queue — so on 2026-08-12 it showed
            0 while a document sat awaiting clarification, and looked like a
            contradiction. The count was right; the word was missing. */}
        <SummaryCard val={pendingFarms} lbl="Farms Awaiting Review" cls="s-pending" />
        <SummaryCard val={approvedFarms} lbl="Approved Farms" cls="s-approved" />
        <SummaryCard val={watchlistFarms} lbl="Watchlist" cls="s-missing" />
        <SummaryCard val={`${totalKg.toLocaleString()} kg`} lbl="Total Submitted Stock" cls="s-total" />
        <SummaryCard val={`${approvedKg.toLocaleString()} kg`} lbl="Approved Stock" cls="s-approved" />
        {/* Likewise: this counts INVENTORY BATCHES flagged 'Missing Document',
            not entries in the document register. A document that arrived and
            was queried is not counted here and should not be — it is not
            missing. The evidence queue is its own surface. */}
        <SummaryCard val={missingDocItems} lbl="Batches Missing a Document" cls="s-missing" />
        <SummaryCard val={exportReadyFarms} lbl="Export Document Review" cls="s-farms" />
      </div>

      <div className="eo-grid eo-section">
        <section>
          <div className="eo-section-head"><h2 className="eo-section-title">Recent Farm Registrations</h2></div>
          <div className="eo-panel">
            <div className="eo-table-scroll">
            <table className="eo-table">
              <thead><tr><th>Farm</th><th>Province</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {recentFarms.length === 0 ? (
                  <tr><td colSpan={4} className="empty-table-cell">NO RECORDS ON FILE</td></tr>
                ) : recentFarms.map(f => (
                  <tr key={f.id}>
                    {/* A farm with no trading name rendered as an empty cell,
                        which reads as a table fault rather than as missing
                        data. Standing rule 5a: never blank, never a raw UUID.
                        Display only — nothing here writes a name into
                        `trading_name`, which feeds buyer paperwork. */}
                    <td className="eo-td-primary" data-label="Farm">
                      {(() => {
                        const named = displayName(f.tradingName ?? '', 'No name on file', f.id)
                        return named.unnamed && named.identifier
                          ? <>{named.name} <span className="mono-id">{shortIdentifier(named.identifier)}</span></>
                          : named.name
                      })()}
                    </td>
                    <td data-label="Province">{f.province}</td>
                    <td data-label="Status"><span className={`badge ${FARM_STATUS_CLASS[f.status]}`}>{f.status}</span></td>
                    <td><button className="btn btn-review" onClick={() => onReviewFarm(f.id)}>Open Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </section>

        <section>
          <div className="eo-section-head"><h2 className="eo-section-title">Recent Inventory Batches</h2></div>
          <div className="eo-panel">
            <div className="eo-table-scroll">
            <table className="eo-table">
              <thead><tr><th>Product</th><th>Farm</th><th>Qty (kg)</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {recentInventory.length === 0 ? (
                  <tr><td colSpan={5} className="empty-table-cell">NO RECORDS ON FILE</td></tr>
                ) : recentInventory.map(i => (
                  <tr key={i.id}>
                    <td className="eo-td-primary" data-label="Product">{i.productName}</td>
                    <td data-label="Farm">{i.farmName}</td>
                    <td className="eo-td-num" data-label="Qty (kg)">{i.quantityKg.toLocaleString()}</td>
                    <td data-label="Status"><span className={`badge ${INV_STATUS_CLASS[i.status]}`}>{i.status}</span></td>
                    <td><button className="btn btn-review" onClick={() => onReviewItem(i.id)}>Open Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </section>
      </div>

      {(riskAlertFarms.length > 0 || riskAlertInventory.length > 0) && (
        <section className="eo-section">
          <div className="eo-section-head"><h2 className="eo-section-title eo-section-title--risk">Action Required</h2></div>
          <div className="eo-panel">
            {riskAlertFarms.map(f => (
              <div key={f.id} className="eo-alert-row">
                <span className="eo-alert-kind">Farm</span>
                <span className="eo-alert-name">{f.tradingName}</span>
                <span className={`badge ${FARM_STATUS_CLASS[f.status]}`}>{f.status}</span>
                <button className="btn btn-review" onClick={() => onReviewFarm(f.id)}>Open Review</button>
              </div>
            ))}
            {riskAlertInventory.map(i => (
              <div key={i.id} className="eo-alert-row">
                <span className="eo-alert-kind">Batch</span>
                <span className="eo-alert-name">{i.productName} — {i.farmName}</span>
                <span className="badge badge-missing">Missing Document</span>
                <button className="btn btn-review" onClick={() => onReviewItem(i.id)}>Open Review</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="eo-grid eo-section">
        <section>
          <div className="eo-section-head"><h2 className="eo-section-title">Largest Approved Batches</h2></div>
          <div className="eo-panel">
            <div className="eo-table-scroll">
            <table className="eo-table">
              <thead><tr><th>Product</th><th>Farm</th><th>Qty (kg)</th><th>Grade</th><th>Status</th></tr></thead>
              <tbody>
                {topInventory.length === 0 ? (
                  <tr><td colSpan={5} className="empty-table-cell">NO RECORDS ON FILE</td></tr>
                ) : topInventory.map(i => (
                  <tr key={i.id}>
                    <td className="eo-td-primary" data-label="Product">{i.productName}</td>
                    <td data-label="Farm">{i.farmName}</td>
                    <td className="eo-td-num" data-label="Qty (kg)">{i.quantityKg.toLocaleString()}</td>
                    <td data-label="Grade"><span className="grade-chip">{i.qualityGrade ? `Grade ${i.qualityGrade}` : '—'}</span></td>
                    <td data-label="Status"><span className={`badge ${INV_STATUS_CLASS[i.status]}`}>{i.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </section>

        <section>
          <div className="eo-section-head"><h2 className="eo-section-title">Top-Scored Farm Profiles</h2></div>
          <div className="eo-panel">
            {topFarms.length === 0
              ? <div className="empty-table-cell">NO RECORDS ON FILE</div>
              : topFarms.map(f => {
              const total = farmTotalScore(f)
              const avg = Math.round(total / 9)
              return (
                <div key={f.id} className="eo-score-row">
                  <div>
                    <div className="eo-score-name">{f.tradingName}</div>
                    <div className="eo-score-province">{f.province}</div>
                  </div>
                  <div className="score-farm-right">
                    <div className="eo-score-total">{total} / 900</div>
                    <div className="score-bar-mini-wrap">
                      <div className="score-bar-mini" style={{ width: `${avg}%` }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

function SummaryCard({ val, lbl, cls }: { val: string | number; lbl: string; cls: string }) {
  return (
    <div className={`eo-kpi ${cls}`}>
      <div className="eo-kpi-val">{val}</div>
      <div className="eo-kpi-lbl">{lbl}</div>
    </div>
  )
}
