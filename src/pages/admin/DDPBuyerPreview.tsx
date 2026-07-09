import { useState } from 'react'
import type { FarmProfile, InventoryItem, ProcurementDecision } from '../../types'
import { DDPVerifiedSupplySeal } from '../../components/logos'
import { deriveComplianceTier, COMPLIANCE_TIER_LABEL, complianceTierClass, testStatusClass, testStatusLabel } from '../../data'
import { DocumentCard } from '../../components/shared/DocumentCard'
import {
  deriveFarmDocumentRequirements,
  applyRequirementOverrides,
  deriveAutoRisks,
  applyRiskOverrides,
  loadProcurementDecisions,
  saveProcurementDecision,
  PROCUREMENT_DECISION_LABELS,
} from '../../lib/procurementControl'
import { deriveBuyerApprovalGate } from '../../lib/buyerApprovalGate'

interface Props {
  inventory: InventoryItem[]
  farms?: FarmProfile[]
  selectedItem?: InventoryItem | null
  onBack?: () => void
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
}

const CHECKLIST: { key: string; label: string; pass: (i: InventoryItem) => boolean }[] = [
  { key: 'batch',    label: 'Batch number assigned',      pass: i => !!i.batchNumber },
  { key: 'coa_claimed', label: 'COA claimed by farm',      pass: i => !!(i.certFileName || i.coaAvailable) },
  { key: 'coa_file',    label: 'COA file received',        pass: i => !!i.coaStoragePath },
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

// Single source of truth for "is this batch ready to be disclosed to a
// buyer" — used by both the single-batch pack and the aggregate inventory
// list, so the two views can never apply different evidentiary standards to
// the same word ("Approved") again.
function computeBuyerDisclosureStatus(item: InventoryItem, farms: FarmProfile[] | undefined) {
  const farm = farms?.find(f =>
    (item.farmId && f.id === item.farmId) ||
    f.tradingName === item.farmName ||
    f.legalBusinessName === item.farmName
  )

  const requirements = farm ? applyRequirementOverrides(deriveFarmDocumentRequirements(farm, [item])) : []
  const missingRequirements = requirements.filter(r => r.status === 'missing')
  const blockerRequirements = requirements.filter(r => r.status === 'rejected' || r.status === 'expired')
  const receivedCount = requirements.filter(r => r.status === 'documented' || r.status === 'reviewed' || r.status === 'verified').length
  const risks = applyRiskOverrides(deriveAutoRisks(farm ? [farm] : [], [item]))
    .filter(r => r.batchId === item.id || (!!farm && r.farmId === farm.id))
  const unresolvedRisks = risks.filter(r => r.status !== 'resolved' && r.status !== 'accepted')
  const hasBlockingIssues = blockerRequirements.length > 0 || unresolvedRisks.some(r => r.severity === 'blocker')
  const storedDecision = loadProcurementDecisions()[item.id]
  const { isHumanApproved, packStatusLabel } = deriveBuyerApprovalGate(hasBlockingIssues, storedDecision?.decision === 'progress')

  return {
    farm, requirements, missingRequirements, blockerRequirements, receivedCount,
    unresolvedRisks, hasBlockingIssues, storedDecision, isHumanApproved, packStatusLabel,
  }
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
  const {
    farm, requirements, missingRequirements, blockerRequirements, receivedCount, unresolvedRisks,
    storedDecision, isHumanApproved, packStatusLabel,
  } = computeBuyerDisclosureStatus(item, farms)
  const [decision, setDecision] = useState<ProcurementDecision | ''>(storedDecision?.decision ?? '')
  const [decisionSaved, setDecisionSaved] = useState(false)

  function handleSaveDecision() {
    if (!decision) return
    saveProcurementDecision(item.id, decision)
    setDecisionSaved(true)
    setTimeout(() => setDecisionSaved(false), 2000)
  }

  const location = farm?.province
    ? `${farm.province}, Thailand`
    : item.location || '—'

  const checkResults = CHECKLIST.map(c => ({ ...c, result: c.pass(item) }))
  const passCount = checkResults.filter(c => c.result).length

  // A claimed filename/checkbox is not a received document — only a real
  // storage path means DDP actually has the file. Buyer-facing COA display
  // must key off the file, not the claim.
  const hasCoaFile = !!item.coaStoragePath
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
      'DDP BUYER PACK — BATCH SUMMARY',
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
      `(Lab values as documented by the farm from its COA — DDP review required before commercial reliance)`,
      `Storage:          ${na(item.storageConditions)}`,
      '',
      `Compliance:       ${passCount}/${CHECKLIST.length} checks passed`,
      `DDP Status:       ${packStatusLabel}`,
      '',
      `COA:              ${hasCoaFile ? (item.certFileName || 'On file — request from DDP') : 'Not yet received by DDP'}`,
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
          {hasCoaFile && canOpenCoa && (
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
            <div className="buyer-pack-eyebrow">DDP BUYER PACK · BATCH INFORMATION</div>
            <h1 className="buyer-pack-title">{item.productName}</h1>
            <div className="buyer-pack-sub">
              {item.farmName}
              {item.batchNumber ? ` · Batch ${item.batchNumber}` : ''}
              {item.productType ? ` · ${item.productType.charAt(0).toUpperCase() + item.productType.slice(1)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
            {isHumanApproved && <DDPVerifiedSupplySeal size={72} />}
            <span className={`badge ${isHumanApproved ? 'badge-approved' : 'badge-pending'}`} style={{ fontSize: 12, padding: '4px 10px' }}>
              {isHumanApproved ? `✓ ${packStatusLabel}` : packStatusLabel}
            </span>
          </div>
        </div>

        {/* Executive summary — internal draft, never printed/distributed unfinished */}
        <div className="detail-block no-print">
          <div className="detail-block-title" style={{ marginBottom: 6 }}>Executive Summary (Internal Draft)</div>
          <p style={{ fontSize: 13, color: 'var(--warning)', margin: 0 }}>
            INTERNAL — Executive summary not yet completed. Decision Required: this pack must not be issued to a buyer
            until DDP staff complete this section (farm standing, batch readiness, open risks, recommended decision).
          </p>
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
                <span className="buyer-pack-lbl">Compliance Tier</span>
                <span className={`farm-tier-badge ${complianceTierClass(deriveComplianceTier(farm, [item]))}`}>
                  {COMPLIANCE_TIER_LABEL[deriveComplianceTier(farm, [item])]}
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
            <div className="detail-block-title" style={{ marginBottom: 4 }}>Lab Values</div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
              COA values documented by the farm. DDP review required before relying on these figures commercially.
            </p>
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
              hasFile={hasCoaFile}
              fileName={item.certFileName}
              openable={canOpenCoa}
              loading={coaLoading}
              onOpen={handleOpenCoa}
              missingText="COA not yet received by DDP"
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
              COA: {hasCoaFile ? (item.certFileName || 'On file — request from DDP') : 'Not yet received by DDP'}
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
              loading="lazy"
              style={{ maxWidth: 200, maxHeight: 160, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }}
            />
          </div>
        )}

        {/* Compliance checklist */}
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div className="detail-block-title" style={{ marginBottom: 0 }}>DDP Compliance Checklist</div>
            <span className={`badge ${passCount === CHECKLIST.length ? 'badge-approved' : passCount >= Math.ceil(CHECKLIST.length * 0.7) ? 'badge-pending' : 'badge-rejected'}`}>
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

        {/* Missing document matrix summary */}
        {farm && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div className="detail-block-title" style={{ marginBottom: 10 }}>Missing Document Matrix — This Batch</div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '-4px 0 10px' }}>
              Scoped to this batch only — see the full Missing Document Matrix for the farm's complete requirement picture.
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: blockerRequirements.length + missingRequirements.length > 0 ? 10 : 0 }}>
              <span style={{ fontSize: 13 }}>{receivedCount}/{requirements.length} requirements received</span>
              {missingRequirements.length > 0 && <span className="status-pill status-missing">{missingRequirements.length} Missing</span>}
              {blockerRequirements.length > 0 && <span className="status-pill status-reject">{blockerRequirements.length} Blocker</span>}
            </div>
            {missingRequirements.length > 0 && (
              <ul className="no-print" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)' }}>
                {missingRequirements.map(r => <li key={r.type}>{r.type.replace(/_/g, ' ')}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* Risk register summary */}
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="detail-block-title" style={{ marginBottom: 10 }}>Risk Register — Summary</div>
          {unresolvedRisks.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>No unresolved risks on file for this batch.</p>
          ) : (
            <div className="detail-rows">
              {unresolvedRisks.map(r => (
                <div className="detail-row" key={r.riskId}>
                  <span className="dl">{r.severity.toUpperCase()}</span>
                  <span className="dv" style={{ textAlign: 'right' }}>{r.issue}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recommended decision */}
        <div className="no-print" style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="detail-block-title" style={{ marginBottom: 10 }}>Recommended Decision</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={decision} onChange={e => setDecision(e.target.value as ProcurementDecision)} style={{ fontSize: 13 }}>
              <option value="">Select a decision…</option>
              {Object.entries(PROCUREMENT_DECISION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" onClick={handleSaveDecision} disabled={!decision}>
              {decisionSaved ? '✓ Saved' : 'Record Decision'}
            </button>
            {storedDecision && !decisionSaved && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Last recorded: {PROCUREMENT_DECISION_LABELS[storedDecision.decision]} ({new Date(storedDecision.decidedAt).toLocaleDateString()})
              </span>
            )}
          </div>
        </div>

        {/* Safety disclaimer */}
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            DDP separates farm claims from documented evidence and verified findings. Buyer decisions should be based only
            on reviewed documents and qualified-party confirmation. COA results apply to the submitted sample as received
            and do not by themselves verify the full commercial batch, storage condition, or chain of custody.
          </p>
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

  // Listing a batch here — under a "DDP-Approved" heading with the reviewed-supply
  // seal next to it — is itself a buyer-visible disclosure claim. It must clear the
  // same bar as the single-batch pack: no unresolved blocking issues AND a DDP
  // staffer has recorded an explicit "progress" procurement decision. status ===
  // 'Approved' alone is a necessary but not sufficient condition — see
  // computeBuyerDisclosureStatus / deriveBuyerApprovalGate.
  const approved = inventory
    .filter(i => i.status === 'Approved')
    .filter(i => computeBuyerDisclosureStatus(i, farms).isHumanApproved)

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
          No batches are currently approved for buyer disclosure. Approving a batch on the Inventory Dashboard is not enough on its own —
          open its Buyer Pack from Master Inventory, confirm there are no unresolved blocking issues, and record a "Progress" decision.
        </div>
      ) : (
        <>
          <div className="section-label-row" style={{ marginTop: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <DDPVerifiedSupplySeal size={36} />
              <div className="section-label">DDP-Approved Available Inventory</div>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Visible only to qualified buyers approved by DDP</span>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Batch status reflects DDP approval. THC/CBD/contaminant values are as documented by the farm from its COA — confirm with DDP before commercial reliance.
          </p>

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
                      <td data-label="COA">
                        {item.coaStoragePath
                          ? <span className="coa-present">✓</span>
                          : item.certFileName
                            ? <span className="status-pill status-claimed">Claimed</span>
                            : <span className="coa-missing">✗</span>}
                      </td>
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
