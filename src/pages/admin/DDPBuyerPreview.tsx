import { useState } from 'react'
import type { FarmProfile, InventoryItem } from '../../types'
import { DDPVerifiedSupplySeal } from '../../components/logos'
import { deriveComplianceTier, COMPLIANCE_TIER_LABEL, complianceTierClass, testStatusClass, testStatusLabel } from '../../data'
import { DocumentCard } from '../../components/shared/DocumentCard'

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
  { key: 'notes',   label: 'Batch notes on file',          pass: i => !!(i.farmerNotes || i.notes) },
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
    if (!url) return
    if (url.startsWith('data:')) {
      // Browsers block window.open() with data: URLs — convert to blob URL first
      fetch(url)
        .then(r => r.blob())
        .then(blob => {
          const blobUrl = URL.createObjectURL(blob)
          window.open(blobUrl, '_blank', 'noopener,noreferrer')
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
        })
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
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
      `Price per kg:     ${item.pricePerKg > 0 ? `฿${item.pricePerKg.toLocaleString()} THB/kg` : '—'}`,
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
            {copied ? '✓ Copied' : 'Copy Summary'}
          </button>
          {hasCoa && canOpenCoa && (
            <button type="button" className="btn btn-ghost" onClick={handleOpenCoa} disabled={coaLoading}>
              {coaLoading ? '…' : 'Access Certificate of Analysis (COA)'}
            </button>
          )}
          {hasPhoto && (
            <button type="button" className="btn btn-ghost" onClick={handleOpenPhoto}>
              Open Photo
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => window.print()}>
            Print / Save PDF
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
            <span className="badge badge-approved" style={{ fontSize: 12, padding: '4px 10px' }}>✓ DDP Independent Audit Verified</span>
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
            {farm && (
              <div className="buyer-pack-field">
                <span className="buyer-pack-lbl">Verification Tier</span>
                <span className={`farm-tier-badge ${complianceTierClass(deriveComplianceTier(farm))}`}>
                  {COMPLIANCE_TIER_LABEL[deriveComplianceTier(farm)]}
                </span>
              </div>
            )}

            <div className="detail-block-title" style={{ margin: '18px 0 10px' }}>Allocatable Commercial Quantities</div>
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
              <span>{item.pricePerKg > 0 ? `฿${item.pricePerKg.toLocaleString()} THB/kg` : '—'}</span>
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
            <DocumentCard
              variant="buyer-pack"
              hasFile={hasCoa}
              fileName={item.certFileName}
              sizeBytes={item.coaFileSizeBytes}
              issuedDate={item.coaIssuedDate}
              openable={canOpenCoa}
              loading={coaLoading}
              onOpen={handleOpenCoa}
              missingText="COA not yet uploaded"
              missingSeverity="muted"
            />

            {hasPhoto ? (
              <button type="button" className="btn btn-ghost no-print" onClick={handleOpenPhoto}>
                {(item.photoUrls?.length ?? 0) > 1 ? `${item.photoUrls!.length} Product Photos` : 'Product Photo'}
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
          <div className="pack-check-grid">
            {checkResults.map(c => (
              <div key={c.key} className={`pack-check-item${c.result ? ' pack-check-pass' : ''}`}>
                <span className="pack-check-mark">{c.result ? '✓' : '○'}</span>
                <span>{c.label}</span>
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

// ─── Default export: buyer preview dashboard or pack ─────────────────────────

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
        <p className="page-desc">Indicative buyer-facing summary. DDP controls all buyer access, communications, and commercial terms.</p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>NOTE</span>
        <div>
          <strong>Buyer access controlled by DDP</strong> — Buyer-facing packs are prepared by DDP for qualified commercial review only.
          To generate a buyer information pack for a specific batch, use the <strong>Generate Buyer Pack</strong> action in Master Inventory.
        </div>
      </div>

      {approved.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          No approved inventory available for preview. Approve inventory batches from the Inventory Dashboard to enable this section.
        </div>
      ) : (
        <>
          <div className="section-label-row" style={{ marginTop: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <DDPVerifiedSupplySeal size={36} />
              <div className="section-label">Verified Available Inventory</div>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Visible only to qualified buyers approved by DDP</span>
          </div>

          <div className="card table-card">
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
                  </tr>
                </thead>
                <tbody>
                  {approved.map(item => (
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
                      <td data-label="COA">{item.certFileName || item.coaStoragePath ? <span className="coa-present">✓</span> : <span className="coa-missing">✗</span>}</td>
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
