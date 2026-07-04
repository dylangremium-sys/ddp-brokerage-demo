import { useState } from 'react'
import type { FarmProfile, InventoryItem } from '../../types'
import { DDPVerifiedSupplySeal } from '../../components/logos'
import { deriveComplianceTier, COMPLIANCE_TIER_LABEL, complianceTierClass, testStatusClass, testStatusLabel } from '../../data'
import { DocumentCard } from '../../components/shared/DocumentCard'
import { FilterSidebar, RangeSlider, CertCheckboxGroup, type RangeValue } from '../../components/shared/FilterSidebar'

const CERT_OPTIONS: { key: keyof FarmProfile; label: string }[] = [
  { key: 'gmpCert', label: 'EU-GMP' },
  { key: 'gacpCert', label: 'GACP' },
  { key: 'picsCert', label: 'PIC/S' },
]

const THC_BOUNDS: RangeValue = { min: 0, max: 35 }
const CBD_BOUNDS: RangeValue = { min: 0, max: 25 }
const MOISTURE_BOUNDS: RangeValue = { min: 0, max: 15 }

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
  const [thcRange, setThcRange] = useState<RangeValue>(THC_BOUNDS)
  const [cbdRange, setCbdRange] = useState<RangeValue>(CBD_BOUNDS)
  const [moistureRange, setMoistureRange] = useState<RangeValue>(MOISTURE_BOUNDS)
  const [certFilters, setCertFilters] = useState<string[]>([])

  function toggleCert(key: string) {
    setCertFilters(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }

  function resetFilters() {
    setThcRange(THC_BOUNDS)
    setCbdRange(CBD_BOUNDS)
    setMoistureRange(MOISTURE_BOUNDS)
    setCertFilters([])
  }

  const filtered = approved.filter(i => {
    if (search.trim()) {
      const q = search.toLowerCase()
      const matchesSearch =
        i.productName.toLowerCase().includes(q) ||
        i.farmName.toLowerCase().includes(q) ||
        (i.batchNumber || '').toLowerCase().includes(q)
      if (!matchesSearch) return false
    }
    if (i.thcPct > 0 && (i.thcPct < thcRange.min || i.thcPct > thcRange.max)) return false
    if (i.cbdPct > 0 && (i.cbdPct < cbdRange.min || i.cbdPct > cbdRange.max)) return false
    if (i.moisturePct > 0 && (i.moisturePct < moistureRange.min || i.moisturePct > moistureRange.max)) return false
    if (certFilters.length > 0) {
      const farm = getFarm(i)
      if (!farm) return false
      if (!certFilters.every(key => !!farm[key as keyof FarmProfile])) return false
    }
    return true
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

  function getTier(item: InventoryItem) {
    const farm = getFarm(item)
    return farm ? deriveComplianceTier(farm) : undefined
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
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>NO RECORDS ON FILE</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>Approved inventory batches from the Inventory Review screen will appear here once approved.</p>
        </div>
      ) : (
      <div className="filter-layout">
        <FilterSidebar onReset={resetFilters}>
          <RangeSlider label="THC %" bounds={THC_BOUNDS} value={thcRange} onChange={setThcRange} />
          <RangeSlider label="CBD %" bounds={CBD_BOUNDS} value={cbdRange} onChange={setCbdRange} />
          <RangeSlider label="Moisture %" bounds={MOISTURE_BOUNDS} value={moistureRange} onChange={setMoistureRange} />
          <CertCheckboxGroup label="Compliance Gates" options={CERT_OPTIONS} selected={certFilters} onToggle={toggleCert} />
        </FilterSidebar>
        <div className="card table-card">
          <div className="toolbar-row">
            <input
              type="search"
              className="toolbar-input"
              placeholder="Search product, farm, or batch…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select
              className="toolbar-select"
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
            >
              <option value="default">Sort: Default</option>
              <option value="quantity">Sort: Quantity ↓</option>
              <option value="thc">Sort: THC % ↓</option>
              <option value="price">Sort: Price/kg ↓</option>
              <option value="farm">Sort: Farm A–Z</option>
            </select>
            <span className="toolbar-count">
              {sorted.length} of {approved.length} {approved.length === 1 ? 'batch' : 'batches'}
            </span>
          </div>
          <div className="table-card-title">Verified Inventory — DDP Controlled</div>
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
                  <th>COA</th>
                  <th>Verification Tier</th>
                  <th>Status</th>
                  {onBuyerPack && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr><td colSpan={onBuyerPack ? 11 : 10} className="empty-table-cell">NO ASSETS MATCH SPECIFIED PROCUREMENT CRITERIA</td></tr>
                ) : sorted.map(item => (
                  <tr key={item.id}>
                    <td className="td-mono" data-label="Batch ID">{item.batchNumber || '—'}</td>
                    <td data-label="Genotype / Strain">
                      <span className="td-bold">{item.productName || 'Unnamed batch'}</span>
                      <br /><span className="td-muted">{item.farmName || 'Unnamed farm'} · {getProvince(item)}</span>
                    </td>
                    <td className="td-num td-mono" data-label="THC %">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                    <td className="td-num td-mono" data-label="CBD %">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                    <td data-label="Microbial"><span className={testStatusClass(item.microbialStatus)}>{testStatusLabel(item.microbialStatus)}</span></td>
                    <td data-label="Heavy Metals"><span className={testStatusClass(item.heavyMetalsStatus)}>{testStatusLabel(item.heavyMetalsStatus)}</span></td>
                    <td className="td-num" data-label="Allocatable Qty (kg)">{item.quantityKg.toLocaleString()}</td>
                    <td data-label="COA">
                      <DocumentCard
                        variant="table-cell"
                        hasFile={!!(item.certFileName || item.coaStoragePath)}
                        fileName={item.certFileName}
                        sizeBytes={item.coaFileSizeBytes}
                        issuedDate={item.coaIssuedDate}
                        openable={!!(item.coaStoragePath && onGetCoaUrl)}
                        loading={coaLoadingId === item.id}
                        onOpen={() => handleViewCoa(item)}
                        missingText="COA missing"
                      />
                    </td>
                    <td data-label="Verification Tier">
                      {getTier(item) ? (
                        <span className={`farm-tier-badge ${complianceTierClass(getTier(item)!)}`}>
                          {COMPLIANCE_TIER_LABEL[getTier(item)!]}
                        </span>
                      ) : '—'}
                    </td>
                    <td data-label="Status"><span className="badge badge-approved">Approved</span></td>
                    {onBuyerPack && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-pack"
                          onClick={() => onBuyerPack(item.id)}
                        >
                          Initiate Procurement Sequence
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      )}
    </div>
  )
}
