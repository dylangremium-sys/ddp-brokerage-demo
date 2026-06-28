import { T, FARM_STATUS_LABEL, INVENTORY_STATUS_LABEL } from '../translations'
import type { Lang, InventoryItem, FarmProfile, FarmStatus, InventoryStatus } from '../types'

interface Props {
  lang: Lang
  inventory: InventoryItem[]
  farms: FarmProfile[]
}

const STATUS_CLASS: Record<InventoryStatus, string> = {
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

export default function FarmerStatus({ lang, inventory, farms }: Props) {
  const t = T[lang]
  const myFarms = [...farms].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
  const isEmpty = myFarms.length === 0 && inventory.length === 0

  function farmMsg(status: FarmStatus): string {
    if (status === 'Submitted to DDP' || status === 'Under Review') return t.farmPendingMsg
    if (status === 'More Information Required') return t.farmMoreInfoMsg
    if (status === 'Approved' || status === 'Strategic Partner') return t.farmApprovedMsg
    if (status === 'Watchlist') return t.farmWatchlistMsg
    if (status === 'Rejected') return t.farmRejectedMsg
    return ''
  }

  function invMsg(status: InventoryStatus): string | null {
    if (status === 'Pending Review') return t.pendingMsg
    if (status === 'Missing Document') return t.missingDocMsg
    if (status === 'Rejected') return t.rejectedMsg
    if (status === 'Approved') return t.approvedMsg
    return null
  }

  function invMsgClass(status: InventoryStatus): string {
    if (status === 'Approved') return 'alert alert-success-sm'
    if (status === 'Rejected') return 'alert alert-danger'
    if (status === 'Missing Document') return 'alert alert-warning'
    return 'alert alert-info-sm'
  }

  return (
    <div className="page-wrap">
      <div className="page-header farmer-header">
        <div className="farmer-header-row">
          <div className="page-eyebrow">{t.eyebrow}</div>
        </div>
        <h1 className="page-title">{t.statusTitle}</h1>
        <p className="page-desc">{t.statusDesc}</p>
      </div>

      {/* Combined empty state — shown only when farmer has made no submissions at all */}
      {isEmpty && (
        <div className="empty-state-hero">
          <div className="empty-state-icon">📋</div>
          <p className="empty-state-message">
            No submissions yet. Register your farm or submit an inventory batch to begin.
          </p>
        </div>
      )}

      {/* Farm Status */}
      {!isEmpty && <div className="section-label-row">
        <div className="section-label">{t.farmStatusSection}</div>
      </div>}

      {!isEmpty && myFarms.length === 0 ? (
        <div className="empty-state">{t.noFarmProfile}</div>
      ) : !isEmpty && (
        <div className="status-list" style={{ marginBottom: 32 }}>
          {myFarms.map(farm => (
            <div key={farm.id} className="card status-card">
              <div className="status-card-top">
                <div>
                  <div className="status-product">{farm.tradingName || farm.legalBusinessName}</div>
                  <div className="status-meta">{farm.province}{farm.district ? `, ${farm.district}` : ''}</div>
                </div>
                <span className={`badge ${FARM_STATUS_CLASS[farm.status]}`}>
                  {FARM_STATUS_LABEL[farm.status][lang]}
                </span>
              </div>
              <div className="status-pills">
                <span className="pill">{t.completionLabel}: {farm.completionPct}%</span>
                {farm.province && <span className="pill">{farm.province}</span>}
                {farm.farmType && <span className="pill">{farm.farmType}</span>}
              </div>
              <div className="completion-bar-wrap" style={{ marginTop: 10 }}>
                <div className="completion-bar-track">
                  <div className="completion-bar-fill" style={{ width: `${farm.completionPct}%` }} />
                </div>
              </div>
              {farmMsg(farm.status) && (
                <div className={`alert ${farm.status === 'Approved' || farm.status === 'Strategic Partner' ? 'alert-success-sm' : farm.status === 'Rejected' ? 'alert-danger' : farm.status === 'More Information Required' || farm.status === 'Watchlist' ? 'alert-warning' : 'alert-info-sm'}`} style={{ marginTop: 10 }}>
                  {farmMsg(farm.status)}
                </div>
              )}
              {farm.submittedAt && (
                <div className="submitted-date">
                  Submitted: {new Date(farm.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Inventory Status */}
      {!isEmpty && <div className="section-label-row">
        <div className="section-label">{t.inventoryStatusSection}</div>
      </div>}

      {!isEmpty && inventory.length === 0 ? (
        <div className="empty-state">{t.noInventory}</div>
      ) : !isEmpty && (
        <div className="status-list">
          {inventory.map(item => {
            const msg = invMsg(item.status)
            return (
              <div key={item.id} className="card status-card">
                <div className="status-card-top">
                  <div>
                    <div className="status-product">{item.productName}</div>
                    <div className="status-meta">
                      {item.farmName} · {item.location} · {t.batchPrefix} {item.batchNumber || '—'}
                    </div>
                  </div>
                  <span className={`badge ${STATUS_CLASS[item.status]}`}>
                    {INVENTORY_STATUS_LABEL[item.status][lang]}
                  </span>
                </div>
                <div className="status-pills">
                  <span className="pill">{item.quantityKg.toLocaleString()} {t.kgUnit}</span>
                  <span className="pill">{t.gradePrefix} {item.qualityGrade}</span>
                  {item.moisturePct > 0 && <span className="pill">{t.moisturePrefix} {item.moisturePct}%</span>}
                  {item.thcPct > 0 && <span className="pill">{t.thcPrefix} {item.thcPct}%</span>}
                  {item.cbdPct > 0 && <span className="pill">{t.cbdPrefix} {item.cbdPct}%</span>}
                  {item.waterActivity && <span className="pill">{t.waPrefix} {item.waterActivity}</span>}
                  <span className="pill">฿{item.pricePerKg}/{t.kgUnit}</span>
                  {item.harvestDate && <span className="pill">{t.harvestPrefix} {item.harvestDate}</span>}
                  {item.certFileName && <span className="pill pill-doc">📄 {item.certFileName}</span>}
                </div>
                {msg && <div className={invMsgClass(item.status)} style={{ marginTop: 10 }}>{msg}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
