import { useState } from 'react'
import type { FarmProfile, InventoryItem } from '../../types'
import { DDPVerifiedSupplySeal } from '../../components/logos'

interface Props {
  inventory: InventoryItem[]
  farms: FarmProfile[]
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
  onBuyerPack?: (itemId: string) => void
}

type SortKey = 'default' | 'quantity' | 'thc' | 'price' | 'farm'

export default function DDPMasterInventory({ inventory, farms, onGetCoaUrl, onBuyerPack }: Props) {
  const approved = inventory.filter(i => i.status === 'Approved')
  const totalKg = approved.reduce((s, i) => s + i.quantityKg, 0)
  const [coaLoadingId, setCoaLoadingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('default')

  const filtered = approved.filter(i => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      i.productName.toLowerCase().includes(q) ||
      i.farmName.toLowerCase().includes(q) ||
      (i.batchNumber || '').toLowerCase().includes(q)
    )
  })

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'quantity') return b.quantityKg - a.quantityKg
    if (sortKey === 'thc') return b.thcPct - a.thcPct
    if (sortKey === 'price') return b.pricePerKg - a.pricePerKg
    if (sortKey === 'farm') return a.farmName.localeCompare(b.farmName)
    return 0
  })

  async function handleViewCoa(item: InventoryItem) {
    if (!onGetCoaUrl || !item.coaStoragePath) return
    setCoaLoadingId(item.id)
    const url = await onGetCoaUrl(item.coaStoragePath)
    setCoaLoadingId(null)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  function getFarm(item: InventoryItem): FarmProfile | undefined {
    if (item.farmId) return farms.find(f => f.id === item.farmId)
    return farms.find(f => f.tradingName === item.farmName || f.legalBusinessName === item.farmName)
  }

  function getProvince(item: InventoryItem): string {
    const farm = getFarm(item)
    if (farm) return farm.province
    return item.location.split(',')[0] || '—'
  }

  function getTier(item: InventoryItem): string {
    const farm = getFarm(item)
    return farm?.partnerTier || '—'
  }

  return (
    <div className="page-wrap ddp-wrap">
      <div className="master-banner">
        <div className="master-banner-inner">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="master-eyebrow">DDP VERIFIED INVENTORY</div>
              <h1 className="master-title">Master Inventory</h1>
              <p className="master-desc">Verified and approved stock — controlled by DDP and ready for qualified buyer engagement.</p>
            </div>
            <DDPVerifiedSupplySeal size={68} />
          </div>
          <div className="master-stats-row">
            <div className="master-stat">
              <div className="master-stat-val">{approved.length}</div>
              <div className="master-stat-lbl">Approved Batches</div>
            </div>
            <div className="master-stat">
              <div className="master-stat-val">{totalKg.toLocaleString()} kg</div>
              <div className="master-stat-lbl">Total Verified Stock</div>
            </div>
            <div className="master-stat">
              <div className="master-stat-val">{new Set(approved.map(i => i.farmName)).size}</div>
              <div className="master-stat-lbl">Verified Farms</div>
            </div>
          </div>
        </div>
      </div>

      {approved.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>No Verified Inventory Yet</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>Approved inventory batches from the Inventory Review screen will appear here once approved.</p>
        </div>
      ) : (
        <div className="card table-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 0', flexWrap: 'wrap' }}>
            <input
              type="search"
              placeholder="Search product, farm, or batch…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: '1 1 200px', fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)' }}
            />
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)' }}
            >
              <option value="default">Sort: Default</option>
              <option value="quantity">Sort: Quantity ↓</option>
              <option value="thc">Sort: THC % ↓</option>
              <option value="price">Sort: Price/kg ↓</option>
              <option value="farm">Sort: Farm A–Z</option>
            </select>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {sorted.length} of {approved.length} {approved.length === 1 ? 'batch' : 'batches'}
            </span>
          </div>
          <div className="table-card-title" style={{ paddingTop: 10 }}>Verified Inventory — DDP Controlled</div>
          <div className="table-scroll">
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Farm</th>
                  <th>Province</th>
                  <th>Quantity (kg)</th>
                  <th>Batch</th>
                  <th>THC %</th>
                  <th>CBD %</th>
                  <th>Moisture %</th>
                  <th>Grade</th>
                  <th>COA</th>
                  <th>Farm Tier</th>
                  <th>Status</th>
                  {onBuyerPack && <th>Export</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr><td colSpan={onBuyerPack ? 13 : 12} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13.5 }}>No batches match your search.</td></tr>
                ) : sorted.map(item => (
                  <tr key={item.id}>
                    <td className="td-bold">{item.productName || 'Unnamed batch'}</td>
                    <td>{item.farmName || 'Unnamed farm'}</td>
                    <td className="td-muted">{getProvince(item)}</td>
                    <td className="td-num">{item.quantityKg.toLocaleString()}</td>
                    <td className="td-mono">{item.batchNumber || '—'}</td>
                    <td className="td-num">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                    <td className="td-num">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                    <td className="td-num">{item.moisturePct > 0 ? `${item.moisturePct}%` : '—'}</td>
                    <td><span className="grade-chip">Grade {item.qualityGrade}</span></td>
                    <td>
                      {item.certFileName || item.coaStoragePath
                        ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="coa-present">✓ COA attached</span>
                            {item.coaStoragePath && onGetCoaUrl && (
                              <button
                                type="button"
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '1px 8px' }}
                                onClick={() => handleViewCoa(item)}
                                disabled={coaLoadingId === item.id}
                              >
                                {coaLoadingId === item.id ? '…' : 'View file'}
                              </button>
                            )}
                          </span>
                        )
                        : <span className="coa-missing">✗ COA missing</span>}
                    </td>
                    <td>
                      <span className={`farm-tier-badge tier-${getTier(item).toLowerCase().replace(/ /g, '-')}`}>
                        {getTier(item)}
                      </span>
                    </td>
                    <td><span className="badge badge-approved">Approved</span></td>
                    {onBuyerPack && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ fontSize: 11, padding: '2px 10px', whiteSpace: 'nowrap' }}
                          onClick={() => onBuyerPack(item.id)}
                        >
                          📋 Generate Buyer Pack
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
