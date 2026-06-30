import { useState } from 'react'
import type { FarmProfile, InventoryItem } from '../types'
import { DDPVerifiedSupplySeal } from '../components/logos'

interface Props {
  inventory: InventoryItem[]
  farms?: FarmProfile[]
  selectedItem?: InventoryItem | null
  onBack?: () => void
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
}

const CHECKLIST: { key: string; label: string; pass: (i: InventoryItem) => boolean }[] = [
  { key: 'batch',    label: 'Batch number assigned',      pass: i => !!i.batchNumber },
  { key: 'coa',     label: 'COA on file',                 pass: i => !!(i.certFileName || i.coaAvailable || i.coaStoragePath) },
  { key: 'lab',     label: 'Lab name recorded',           pass: i => !!i.labName },
  { key: 'date',    label: 'Test date recorded',          pass: i => !!i.testDate },
  { key: 'thc',     label: 'THC % recorded',              pass: i => i.thcPct > 0 },
  { key: 'cbd',     label: 'CBD % recorded',              pass: i => i.cbdPct > 0 },
  { key: 'moist',   label: 'Moisture % recorded',         pass: i => i.moisturePct > 0 },
  { key: 'water',   label: 'Water activity recorded',     pass: i => !!i.waterActivity },
  { key: 'storage', label: 'Storage conditions supplied', pass: i => !!i.storageConditions },
  { key: 'notes',   label: 'Farmer notes present',        pass: i => !!(i.farmerNotes || i.notes) },
]

const BUYER_CARDS = [
  {
    flag: '🇨🇿', buyer: 'Czech Processor',
    interest: 'Interested in Grade A Mango — requesting batch documentation and COA review.',
    tags: ['Grade A', 'Mango', 'COA Required'],
  },
  {
    flag: '🇨🇭', buyer: 'Swiss Importer',
    interest: 'Requires verified batch documentation and certificate of analysis for all available strains.',
    tags: ['All Strains', 'COA Required', 'Verified Batch'],
  },
  {
    flag: '🇩🇪', buyer: 'German Distributor',
    interest: 'Requesting monthly supply estimate and pricing schedule.',
    tags: ['Supply Estimate', 'Pricing', 'Monthly Commitment'],
  },
  {
    flag: '🇬🇧', buyer: 'UK Medical Buyer',
    interest: 'Interested in export-ready batches only. Requires GMP documentation.',
    tags: ['Export Ready', 'GMP Required', 'Medical Grade'],
  },
]

function na(val: string | number | undefined | null, suffix = ''): string {
  if (val === undefined || val === null || val === '' || val === 0) return '—'
  return `${val}${suffix}`
}

// ─── Buyer Pack ───────────────────────────────────────────────────────────────

function BuyerPack({ item, farms, onBack, onGetCoaUrl }: {
  item: InventoryItem
  farms?: FarmProfile[]
  onBack?: () => void
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
}) {
  const [coaLoading, setCoaLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const farm = farms?.find(f =>
    (item.farmId && f.id === item.farmId) ||
    f.tradingName === item.farmName ||
    f.legalBusinessName === item.farmName
  )

  const location = farm?.province
    ? `${farm.province}, Thailand`
    : item.location || '—'

  const checkResults = CHECKLIST.map(c => ({ ...c, result: c.pass(item) }))
  const passCount = checkResults.filter(c => c.result).length

  const hasCoa = !!(item.certFileName || item.coaAvailable || item.coaStoragePath)
  const canOpenCoa = !!(item.coaStoragePath && onGetCoaUrl)
  const hasPhoto = (item.photoUrls?.length ?? 0) > 0 || !!item.photoUrl
  const previewPhoto = item.photoUrls?.[0] ?? item.photoUrl ?? null

  async function handleOpenCoa() {
    if (!onGetCoaUrl || !item.coaStoragePath) return
    setCoaLoading(true)
    const url = await onGetCoaUrl(item.coaStoragePath)
    setCoaLoading(false)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  function handleOpenPhoto() {
    const url = item.photoUrls?.[0] ?? item.photoUrl
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  function buildSummaryText() {
    const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    return [
      'DDP VERIFIED BATCH — BUYER SUMMARY',
      `Generated: ${date}`,
      '',
      `Product:          ${item.productName}`,
      `Batch Number:     ${na(item.batchNumber)}`,
      `Farm:             ${item.farmName}`,
      `Location:         ${location}`,
      `Available Qty:    ${item.quantityKg > 0 ? `${item.quantityKg.toLocaleString()} ${item.unit ?? 'kg'}` : '—'}`,
      `Price per kg:     ${item.pricePerKg > 0 ? `฿${item.pricePerKg.toLocaleString()}` : '—'}`,
      '',
      `THC:              ${na(item.thcPct, '%')}`,
      `CBD:              ${na(item.cbdPct, '%')}`,
      `Moisture:         ${na(item.moisturePct, '%')}`,
      `Water Activity:   ${na(item.waterActivity)}`,
      `Storage:          ${na(item.storageConditions)}`,
      '',
      `Compliance:       ${passCount}/${CHECKLIST.length} checks passed`,
      `DDP Status:       Approved`,
      '',
      `COA:              ${hasCoa ? (item.certFileName || 'On file — request from DDP') : 'Not yet uploaded'}`,
      `Photo:            ${hasPhoto ? 'Available — request from DDP' : 'Not available'}`,
      '',
      'All commercial terms are managed exclusively by DDP Brokerage.',
    ].join('\n')
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildSummaryText())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not available in some browser contexts
    }
  }

  return (
    <div className="page-wrap ddp-wrap buyer-pack-wrap">

      {/* Action bar — hidden on print */}
      <div className="buyer-pack-actions no-print">
        {onBack && (
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            ← Master Inventory
          </button>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" onClick={handleCopy}>
            {copied ? '✓ Copied' : '📋 Copy Summary'}
          </button>
          {hasCoa && canOpenCoa && (
            <button type="button" className="btn btn-ghost" onClick={handleOpenCoa} disabled={coaLoading}>
              {coaLoading ? '…' : '📄 Open COA'}
            </button>
          )}
          {hasPhoto && (
            <button type="button" className="btn btn-ghost" onClick={handleOpenPhoto}>
              📷 Open Photo
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => window.print()}>
            🖨 Print / Save PDF
          </button>
        </div>
      </div>

      {/* Pack card */}
      <div className="card buyer-pack-card">

        {/* Header */}
        <div className="buyer-pack-header">
          <div style={{ flex: 1 }}>
            <div className="buyer-pack-eyebrow">DDP VERIFIED BATCH · BUYER INFORMATION PACK</div>
            <h1 className="buyer-pack-title">{item.productName}</h1>
            <div className="buyer-pack-sub">
              {item.farmName}
              {item.batchNumber ? ` · Batch ${item.batchNumber}` : ''}
              {item.productType ? ` · ${item.productType.charAt(0).toUpperCase() + item.productType.slice(1)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
            <DDPVerifiedSupplySeal size={72} />
            <span className="badge badge-approved" style={{ fontSize: 12, padding: '4px 10px' }}>✓ DDP Approved</span>
          </div>
        </div>

        {/* Two-column detail grid */}
        <div className="buyer-pack-grid">

          {/* Left: Farm, availability, pricing */}
          <div>
            <div className="detail-block-title" style={{ marginBottom: 10 }}>Farm &amp; Origin</div>
            <div className="buyer-pack-field">
              <span className="buyer-pack-lbl">Farm</span>
              <span>{item.farmName || '—'}</span>
            </div>
            <div className="buyer-pack-field">
              <span className="buyer-pack-lbl">Location</span>
              <span>{location}</span>
            </div>
            {farm?.partnerTier && (
              <div className="buyer-pack-field">
                <span className="buyer-pack-lbl">Partner Tier</span>
                <span className={`farm-tier-badge tier-${farm.partnerTier.toLowerCase().replace(/ /g, '-')}`}>
                  {farm.partnerTier}
                </span>
              </div>
            )}

            <div className="detail-block-title" style={{ margin: '18px 0 10px' }}>Availability &amp; Pricing</div>
            <div className="buyer-pack-field">
              <span className="buyer-pack-lbl">Available Qty</span>
              <span>{item.quantityKg > 0 ? `${item.quantityKg.toLocaleString()} ${item.unit ?? 'kg'}` : '—'}</span>
            </div>
            {item.minimumOrderKg && (
              <div className="buyer-pack-field">
                <span className="buyer-pack-lbl">Min. Order</span>
                <span>{item.minimumOrderKg} kg</span>
              </div>
            )}
            <div className="buyer-pack-field">
              <span className="buyer-pack-lbl">Price / kg</span>
              <span>{item.pricePerKg > 0 ? `฿${item.pricePerKg.toLocaleString()}` : '—'}</span>
            </div>
            {item.harvestDate && (
              <div className="buyer-pack-field">
                <span className="buyer-pack-lbl">Harvest Date</span>
                <span>{item.harvestDate}</span>
              </div>
            )}
            {item.expiryDate && (
              <div className="buyer-pack-field">
                <span className="buyer-pack-lbl">Expiry Date</span>
                <span>{item.expiryDate}</span>
              </div>
            )}
          </div>

          {/* Right: Lab values, storage */}
          <div>
            <div className="detail-block-title" style={{ marginBottom: 10 }}>Lab Values</div>
            <div className="buyer-pack-field"><span className="buyer-pack-lbl">THC</span><span>{na(item.thcPct, '%')}</span></div>
            <div className="buyer-pack-field"><span className="buyer-pack-lbl">CBD</span><span>{na(item.cbdPct, '%')}</span></div>
            <div className="buyer-pack-field"><span className="buyer-pack-lbl">Moisture</span><span>{na(item.moisturePct, '%')}</span></div>
            <div className="buyer-pack-field"><span className="buyer-pack-lbl">Water Activity (aw)</span><span>{na(item.waterActivity)}</span></div>
            {item.totalTerpenesPct && (
              <div className="buyer-pack-field"><span className="buyer-pack-lbl">Terpenes</span><span>{item.totalTerpenesPct}%</span></div>
            )}
            {item.labName && (
              <div className="buyer-pack-field"><span className="buyer-pack-lbl">Lab</span><span>{item.labName}</span></div>
            )}
            {item.reportNumber && (
              <div className="buyer-pack-field"><span className="buyer-pack-lbl">Report #</span><span>{item.reportNumber}</span></div>
            )}
            {item.testDate && (
              <div className="buyer-pack-field"><span className="buyer-pack-lbl">Test Date</span><span>{item.testDate}</span></div>
            )}

            <div className="detail-block-title" style={{ margin: '18px 0 10px' }}>Storage &amp; Grade</div>
            <div className="buyer-pack-field">
              <span className="buyer-pack-lbl">Conditions</span>
              <span>{na(item.storageConditions)}</span>
            </div>
            <div className="buyer-pack-field">
              <span className="buyer-pack-lbl">Grade</span>
              <span>{item.qualityGrade ? <span className="grade-chip">Grade {item.qualityGrade}</span> : '—'}</span>
            </div>
          </div>
        </div>

        {/* Documents */}
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="detail-block-title" style={{ marginBottom: 10 }}>Documents</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {hasCoa ? (
              canOpenCoa ? (
                <button type="button" className="btn btn-ghost no-print" onClick={handleOpenCoa} disabled={coaLoading}>
                  {coaLoading ? '…' : `📄 ${item.certFileName || 'Certificate of Analysis'}`}
                </button>
              ) : (
                <span className="coa-present">✓ {item.certFileName || 'COA on file'}</span>
              )
            ) : (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>COA not yet uploaded</span>
            )}

            {hasPhoto ? (
              <button type="button" className="btn btn-ghost no-print" onClick={handleOpenPhoto}>
                📷 {(item.photoUrls?.length ?? 0) > 1 ? `${item.photoUrls!.length} Product Photos` : 'Product Photo'}
              </button>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No product photo</span>
            )}

            {/* Print-only static labels replace interactive buttons */}
            <span className="print-only" style={{ fontSize: 12, color: '#555' }}>
              COA: {hasCoa ? (item.certFileName || 'On file — request from DDP') : 'Not yet uploaded'}
              {' · '}
              Photo: {hasPhoto ? 'Available — request from DDP' : 'Not available'}
            </span>
          </div>
        </div>

        {/* Photo preview */}
        {previewPhoto && (
          <div style={{ marginTop: 16 }}>
            <div className="detail-block-title" style={{ marginBottom: 8 }}>Product Photo</div>
            <img
              src={previewPhoto}
              alt="Product photo"
              style={{ maxWidth: 200, maxHeight: 160, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }}
            />
          </div>
        )}

        {/* Compliance checklist */}
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div className="detail-block-title" style={{ marginBottom: 0 }}>DDP Compliance Checklist</div>
            <span className={`badge ${passCount === CHECKLIST.length ? 'badge-approved' : passCount >= 7 ? 'badge-pending' : 'badge-rejected'}`}>
              {passCount}/{CHECKLIST.length} passed
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '6px 20px' }}>
            {checkResults.map(c => (
              <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                <span style={{ color: c.result ? 'var(--success)' : '#cbd5e1', fontWeight: 700, flexShrink: 0 }}>
                  {c.result ? '✓' : '○'}
                </span>
                <span style={{ color: c.result ? 'var(--text)' : 'var(--text-muted)' }}>{c.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 12,
          fontSize: 11.5, color: 'var(--text-muted)',
          display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6,
        }}>
          <span>DDP Brokerage · Confidential — for qualified buyers only</span>
          <span>All commercial terms managed exclusively by DDP</span>
        </div>
      </div>
    </div>
  )
}

// ─── Default export: prototype buyer dashboard or pack ─────────────────────────

export default function DDPBuyerPreview({ inventory, farms, selectedItem, onBack, onGetCoaUrl }: Props) {
  if (selectedItem) {
    return (
      <BuyerPack
        item={selectedItem}
        farms={farms}
        onBack={onBack}
        onGetCoaUrl={onGetCoaUrl}
      />
    )
  }

  const approved = inventory.filter(i => i.status === 'Approved')

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — COMMERCIAL INTELLIGENCE</div>
        <h1 className="page-title">Qualified Buyer Preview</h1>
        <p className="page-desc">Prototype view of buyer interest signals. DDP controls all buyer access, communications, and commercial terms.</p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>NOTE</span>
        <div>
          <strong>PROTOTYPE MODULE</strong> — Buyer access, pricing, messaging, and transactions are not active in this demonstration.
          To generate a buyer information pack for a specific batch, use the <strong>📋 Buyer Pack</strong> button in Master Inventory.
        </div>
      </div>

      {approved.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          No approved inventory available for preview. Approve inventory batches from the Inventory Dashboard to enable this section.
        </div>
      ) : (
        <>
          <div className="buyer-cards-grid">
            {BUYER_CARDS.map((bc, i) => (
              <div key={i} className="buyer-card">
                <div className="buyer-card-flag">{bc.flag}</div>
                <div className="buyer-card-body">
                  <div className="buyer-card-name">{bc.buyer}</div>
                  <p className="buyer-card-interest">{bc.interest}</p>
                  <div className="buyer-card-tags">
                    {bc.tags.map((tag, j) => <span key={j} className="buyer-tag">{tag}</span>)}
                  </div>
                </div>
                <div className="buyer-card-status">
                  <span className="badge badge-pending">Interest Received</span>
                </div>
              </div>
            ))}
          </div>

          <div className="section-label-row" style={{ marginTop: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <DDPVerifiedSupplySeal size={36} />
              <div className="section-label">Verified Available Inventory</div>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Visible only to qualified buyers approved by DDP</span>
          </div>

          <div className="card table-card">
            <div className="table-scroll">
              <table className="inv-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Farm</th>
                    <th>Quantity (kg)</th>
                    <th>THC %</th>
                    <th>CBD %</th>
                    <th>Grade</th>
                    <th>COA</th>
                    <th>Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {approved.map(item => (
                    <tr key={item.id}>
                      <td className="td-bold">{item.productName}</td>
                      <td>{item.farmName}</td>
                      <td className="td-num">{item.quantityKg.toLocaleString()}</td>
                      <td className="td-num">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                      <td className="td-num">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                      <td><span className="grade-chip">Grade {item.qualityGrade}</span></td>
                      <td>{item.certFileName || item.coaStoragePath ? <span className="coa-present">✓</span> : <span className="coa-missing">✗</span>}</td>
                      <td className="td-mono">{item.batchNumber || '—'}</td>
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
