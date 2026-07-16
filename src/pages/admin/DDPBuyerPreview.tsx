import { useState, useEffect } from 'react'
import { flushSync } from 'react-dom'
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
  PROCUREMENT_DECISION_LABELS,
  type StoredDecision,
} from '../../lib/procurementControl'
import { deriveBuyerApprovalGate } from '../../lib/buyerApprovalGate'
import {
  prepareBuyerPackSnapshotInput,
  generateNextBuyerPackSnapshot,
  deriveSnapshotStatus,
  deriveBuyerPackReleaseEligibility,
  buyerPackApprovalId,
  type BuyerPackSnapshot,
  type BuyerPackSnapshotStatus,
} from '../../lib/buyerPackSnapshot'
import { createLocalStorageBuyerPackSnapshotRepository } from '../../lib/buyerPackSnapshotStore'
import { selectBuyerPackSnapshotRepository } from '../../lib/buyerPackSnapshotSupabaseStore'
import { resolveDecision, recordDecision, type DecisionSource, type ResolvedDecision } from '../../lib/procurementDecisionStore'
import { appendBuyerPackAuditEvent, getBuyerPackAuditTrail } from '../../lib/buyerPackAudit'
import { appendBuyerPackDownload } from '../../lib/buyerPackDownloads'

// Server-backed when Supabase is configured (issues snapshots through the
// append-only issue_buyer_pack_snapshot RPC); the existing localStorage
// repository remains the demo-mode fallback. Same BuyerPackSnapshotRepository
// contract either way, so no call site below changes.
const snapshotRepo = selectBuyerPackSnapshotRepository(createLocalStorageBuyerPackSnapshotRepository())

interface Props {
  inventory: InventoryItem[]
  farms?: FarmProfile[]
  selectedItem?: InventoryItem | null
  onBack?: () => void
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
  // Current admin identity, used as the named approver/generator on a snapshot.
  approverName?: string
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
function computeBuyerDisclosureStatus(
  item: InventoryItem,
  farms: FarmProfile[] | undefined,
  authoritative?: StoredDecision | null,
) {
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
  // AUTHORITATIVE DECISION, when the caller has resolved one. The issue gate must
  // never be driven by the raw localStorage cache: a decision the server refused,
  // or one whose server state could not be read, must not authorise a release.
  // `authoritative` is undefined only for the read-only summary list below, which
  // displays cached state and issues nothing.
  const storedDecision = authoritative !== undefined
    ? authoritative
    : loadProcurementDecisions()[item.id]
  const { isHumanApproved, packStatusLabel } = deriveBuyerApprovalGate(hasBlockingIssues, storedDecision?.decision === 'progress')

  return {
    farm, requirements, missingRequirements, blockerRequirements, receivedCount,
    unresolvedRisks, hasBlockingIssues, storedDecision, isHumanApproved, packStatusLabel,
  }
}

// ─── Buyer Pack ───────────────────────────────────────────────────────────────

function BuyerPack({ item, farms, onBack, onGetCoaUrl, approverName }: {
  item: InventoryItem
  farms?: FarmProfile[]
  onBack?: () => void
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
  approverName?: string
}) {
  const [coaLoading, setCoaLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // The authoritative decision, resolved asynchronously (server wins). Until it
  // resolves it is null, so the gate is CLOSED by default — the pack cannot be
  // issued on the strength of unverified browser state.
  const [resolved, setResolved] = useState<ResolvedDecision | null>(null)

  // Only a decision that the server accepted (or one from a genuinely
  // un-provisioned database) may reach the issue gate. 'unavailable' — the
  // authoritative read failed — yields null, so issuance is blocked.
  const authoritativeDecision: StoredDecision | null =
    resolved && resolved.decision && resolved.source !== 'unavailable' && resolved.decidedAt
      ? { decision: resolved.decision, notes: resolved.reason ?? undefined, decidedAt: resolved.decidedAt }
      : null

  const {
    farm, requirements, missingRequirements, blockerRequirements, receivedCount, unresolvedRisks,
    storedDecision, isHumanApproved, packStatusLabel,
  } = computeBuyerDisclosureStatus(item, farms, authoritativeDecision)
  const [decision, setDecision] = useState<ProcurementDecision | ''>('')
  const [decisionSaved, setDecisionSaved] = useState(false)
  const [decisionReason, setDecisionReason] = useState('')
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [savingDecision, setSavingDecision] = useState(false)
  const [decisionSource, setDecisionSource] = useState<DecisionSource>('none')

  // SERVER WINS. On mount, reconcile against the authoritative server record.
  // resolveDecision() refreshes the localStorage cache when a server row exists,
  // and falls back to the cache (source='local-cache') only when the table is
  // genuinely not deployed. If the authoritative read FAILS (permission, RLS,
  // auth, transient), it returns source='unavailable' — the gate then stays shut
  // rather than trusting stale browser state.
  useEffect(() => {
    let cancelled = false
    void resolveDecision(item.id).then(resolved => {
      if (cancelled) return
      setResolved(resolved)
      setDecisionSource(resolved.source)
      if (resolved.decision) {
        setDecision(resolved.decision)
        setDecisionReason(resolved.reason ?? '')
      }
    })
    return () => { cancelled = true }
  }, [item.id])

  // Latest immutable snapshot for this batch (null until one is loaded/issued).
  const [latestSnapshot, setLatestSnapshot] = useState<BuyerPackSnapshot | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<BuyerPackSnapshotStatus | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)
  const [issueNotice, setIssueNotice] = useState<string | null>(null)
  // A snapshot READ that failed. Distinct from latestSnapshot === null, which
  // means "no snapshot exists". A failed read knows nothing about existence, so
  // the UI must not present it as an absence.
  const [snapshotLoadError, setSnapshotLoadError] = useState<string | null>(null)
  // Why a print attempt was refused. Never silently swallowed: an operator who
  // presses Print must be told which release condition is unmet, in the same
  // words the Issue path uses.
  const [printError, setPrintError] = useState<string | null>(null)
  // Stamped at the moment of printing, so the artifact records when it was
  // produced rather than when the page happened to mount.
  const [printedAt, setPrintedAt] = useState<string | null>(null)

  const approver = (approverName && approverName.trim()) || 'DDP Admin'

  // Load the latest persisted snapshot for this batch on mount / batch change.
  // Async because the repository contract is now Promise-based (Phase B step 1).
  //
  // The repository rejects on a genuine read failure (permission, network). It no
  // longer rejects merely because migration 10 is absent — that degrades to the
  // local repository inside the store. Either way this must not produce an
  // unhandled rejection, and a failed read must not be rendered as "no snapshot".
  useEffect(() => {
    let cancelled = false
    snapshotRepo.getLatest(item.id).then(
      s => {
        if (cancelled) return
        setLatestSnapshot(s)
        setSnapshotLoadError(null)  // a later batch loading cleanly clears an earlier failure
      },
      (err: unknown) => {
        if (cancelled) return
        setLatestSnapshot(null)
        setSnapshotLoadError(err instanceof Error ? err.message : 'Could not load the snapshot history.')
      },
    )
    return () => { cancelled = true }
  }, [item.id])

  // Recompute the derived status whenever the latest snapshot changes (async
  // because deriveSnapshotStatus reads the repository). State is only ever set
  // inside the async callback, never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<BuyerPackSnapshotStatus | null> => {
      if (!latestSnapshot) return null
      return deriveSnapshotStatus(snapshotRepo, getBuyerPackAuditTrail(item.id), item.id, latestSnapshot.manifest.version)
    }
    load().then(
      s => { if (!cancelled) setSnapshotStatus(s) },
      (err: unknown) => {
        if (cancelled) return
        setSnapshotStatus(null)
        setSnapshotLoadError(err instanceof Error ? err.message : 'Could not derive the snapshot status.')
      },
    )
    return () => { cancelled = true }
  }, [item.id, latestSnapshot])

  // The decision is now recorded SERVER-SIDE (public.procurement_decisions,
  // append-only, actor captured from auth.uid()). localStorage is only a cache
  // so the synchronous render path stays consistent. A reason is mandatory —
  // a decision without one is not an audit record.
  async function handleSaveDecision() {
    if (!decision || savingDecision) return
    setDecisionError(null)

    const result = await recordDecision({
      batchId: item.id,
      decision,
      reason: decisionReason,
    })

    if (!result.ok) {
      // The server REFUSED the write. Nothing was cached, so the gate must not
      // move: re-resolve from the authoritative source rather than assuming the
      // attempted decision took effect.
      setDecisionError(result.error ?? 'The decision could not be recorded.')
      const reResolved = await resolveDecision(item.id)
      setResolved(reResolved)
      setDecisionSource(reResolved.source)
      return
    }

    // Accepted (server) or deliberately local (table absent). Re-resolve so the
    // gate and the snapshot approval timestamp come from the authoritative state,
    // never from a value this function assumed.
    const reResolved = await resolveDecision(item.id)
    setResolved(reResolved)
    setDecisionSource(reResolved.source)
    setDecisionSaved(true)
    setTimeout(() => setDecisionSaved(false), 2000)
  }

  async function handleIssueBuyerPack() {
    setIssueError(null)
    setIssueNotice(null)
    // Assemble the snapshot input from already-derived evidence and re-assert
    // the human-approval gate. This never bypasses the gate — both this call
    // and createBuyerPackSnapshot downstream reject anything not explicitly
    // human-approved with a recorded "progress" decision.
    const eligibility = prepareBuyerPackSnapshotInput({
      packId: item.id,
      generatedBy: approver,
      approvedBy: approver,
      isHumanApproved,
      storedDecision: storedDecision ?? null,
      inventory: item,
      coas: { hasCoaFile: !!item.coaStoragePath, certFileName: item.certFileName ?? null, coaStoragePath: item.coaStoragePath ?? null },
      complianceSummary: { tier: farm ? deriveComplianceTier(farm, [item]) : 'CULTIVATOR_CLAIMED' },
      documentChecks: CHECKLIST.map(c => ({ key: c.key, label: c.label, passed: c.pass(item) })),
      risks: unresolvedRisks,
      evidenceSummary: requirements,
    })
    if (!eligibility.eligible) {
      setIssueError(eligibility.reason)
      return
    }

    setIssuing(true)
    try {
      const { snapshot, previousVersion } = await generateNextBuyerPackSnapshot(snapshotRepo, eligibility.input)
      appendBuyerPackAuditEvent({ packId: item.id, snapshotVersion: snapshot.manifest.version, action: 'pack_generated', user: approver })
      if (previousVersion !== null) {
        appendBuyerPackAuditEvent({ packId: item.id, snapshotVersion: previousVersion, action: 'pack_superseded', user: approver })
      }
      setLatestSnapshot(snapshot)
      setIssueNotice(`Buyer pack v${snapshot.manifest.version} issued.`)
    } catch (err) {
      setIssueError(err instanceof Error ? err.message : 'Failed to issue buyer pack.')
    } finally {
      setIssuing(false)
    }
  }

  // Records a download of the already-issued snapshot. No snapshot → export
  // still works exactly as before, just without a download-history entry.
  function recordDownload(format: string) {
    if (!latestSnapshot) return
    appendBuyerPackDownload({ packId: item.id, snapshotVersion: latestSnapshot.manifest.version, user: approver, format })
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
      recordDownload('summary-copy')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not available in some browser contexts
    }
  }

  // The release gate for the print path. Printing a pack puts it in front of a
  // buyer exactly as issuing it does, so it answers to the same predicate the
  // issue path uses — not to a lookalike boolean. Previously this called
  // window.print() unconditionally, so a pack that Issue refused could still be
  // printed and handed over, and the on-screen notice forbidding that was
  // removed from the printed artifact by `.no-print`.
  function handlePrint() {
    const gate = deriveBuyerPackReleaseEligibility({
      isHumanApproved,
      storedDecision: storedDecision ?? null,
      approvedBy: approver,
    })
    if (!gate.eligible) {
      setPrintError(gate.reason)
      return
    }
    setPrintError(null)
    // flushSync so the stamped time is in the DOM before the print dialog reads
    // it — window.print() is synchronous and would otherwise capture the prior
    // render, leaving the artifact with a stale or empty timestamp.
    flushSync(() => setPrintedAt(new Date().toISOString()))
    recordDownload('print-pdf')
    window.print()
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
          <button
            type="button"
            className="btn btn-primary"
            onClick={handlePrint}
            disabled={!isHumanApproved}
            title={isHumanApproved ? undefined : 'Requires no blocking issues and a recorded "Progress" decision'}
          >
            Print / Save PDF
          </button>
        </div>
      </div>

      {/* Why a print attempt was refused. Mirrors the Issue path's own notice so
          one refused act reads the same way wherever it is attempted. */}
      {!isHumanApproved && (
        <div className="no-print" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -4 }}>
          Printing is enabled only after this batch is human-approved for buyer discussion.
        </div>
      )}
      {printError && (
        <div className="no-print" role="alert" style={{ fontSize: 12, color: 'var(--warning)', marginTop: -4 }}>
          {printError}
        </div>
      )}

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
            {/* Prints. The count above prints, so hiding the identities left the
                artifact asserting "N Missing" without saying what — a count
                without identities is not evidence a buyer can act on. */}
            {missingRequirements.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)' }}>
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
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setSavingDecision(true); void handleSaveDecision().finally(() => setSavingDecision(false)) }}
              disabled={!decision || !decisionReason.trim() || savingDecision}
            >
              {savingDecision ? 'Recording…' : decisionSaved ? '✓ Recorded' : 'Record Decision'}
            </button>
            {storedDecision && !decisionSaved && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Last recorded: {PROCUREMENT_DECISION_LABELS[storedDecision.decision]} ({new Date(storedDecision.decidedAt).toLocaleDateString()})
              </span>
            )}
          </div>

          {/* A decision without a stated reason is not an audit record. The
              server CHECK enforces this too; the button is disabled until it is
              supplied so the operator is never surprised by a rejection. */}
          <textarea
            value={decisionReason}
            onChange={e => setDecisionReason(e.target.value)}
            placeholder="Reason for this decision (required — recorded in the audit trail)"
            rows={2}
            style={{ width: '100%', marginTop: 10, fontSize: 13 }}
          />

          {decisionError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger, #b00020)' }}>
              {decisionError}
            </div>
          )}

          {/* Provenance. An operator authorising a controlled-substance release
              is entitled to know whether that record actually reached the server. */}
          {decisionSource === 'local-cache' && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              ⚠ This decision exists only in this browser. It has no server-side audit record
              and no recorded approver. Re-record it to store it durably.
            </div>
          )}
          {decisionSource === 'server' && !decisionError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              ✓ Recorded server-side (append-only, attributed to the signed-in admin).
            </div>
          )}

          {/* The authoritative decision could not be READ. This is not "no decision
              exists" — it is unknown. Issuance is blocked (isHumanApproved is false,
              because the gate refuses to run on unverified browser state). */}
          {decisionSource === 'unavailable' && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--warning)' }}>
              ⚠ The procurement decision could not be verified against the server, so the
              authoritative decision for this batch is <strong>unknown</strong>. This is
              <strong> not</strong> a statement that no decision exists. Issuing a buyer pack is
              blocked until the decision can be read.
              {resolved?.error ? ` (${resolved.error})` : ''}
            </div>
          )}
        </div>

        {/* Issue immutable buyer pack snapshot */}
        <div className="no-print" style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="detail-block-title" style={{ marginBottom: 10 }}>Immutable Buyer Pack Record</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { void handleIssueBuyerPack() }}
              disabled={!isHumanApproved || issuing}
              title={isHumanApproved ? undefined : 'Requires no blocking issues and a recorded "Progress" decision'}
            >
              {issuing ? 'Issuing…' : latestSnapshot ? 'Re-Issue Buyer Pack (new version)' : snapshotLoadError ? 'Issue Buyer Pack (history unavailable)' : 'Issue Buyer Pack'}
            </button>
            {!isHumanApproved && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Enabled only after this batch is human-approved for buyer discussion.
              </span>
            )}
            {issueNotice && <span style={{ fontSize: 12, color: 'var(--success, #2e7d32)' }}>{issueNotice}</span>}
            {issueError && <span style={{ fontSize: 12, color: 'var(--warning)' }}>{issueError}</span>}
          </div>

          {/* A failed read is NOT evidence that no snapshot exists. Say so
              explicitly, so an operator never reads a blank panel as "this pack
              has never been issued" and re-issues over an existing record. */}
          {snapshotLoadError && !latestSnapshot && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--warning)' }}>
              ⚠ The snapshot history could not be read, so it is unknown whether this pack has
              already been issued. This is <strong>not</strong> a confirmation that none exists.
              ({snapshotLoadError})
            </div>
          )}

          {latestSnapshot && (
            <div className="detail-rows" style={{ marginTop: 12 }}>
              <div className="detail-row"><span className="dl">Snapshot Version</span><span className="dv">v{latestSnapshot.manifest.version}</span></div>
              <div className="detail-row"><span className="dl">Content Hash</span><span className="dv td-mono">{latestSnapshot.manifest.contentHash.slice(0, 12)}…</span></div>
              <div className="detail-row"><span className="dl">Status</span><span className="dv">{snapshotStatus}</span></div>
            </div>
          )}
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '10px 0 0' }}>
            Issuing preserves a hashed, append-only copy of exactly what this pack shows, under the recorded human approval.
            Stored in this browser only for now — tamper-evident, not a durable server record.
          </p>
        </div>

        {/* Provenance — printed only. A released pack must carry, on the artifact
            itself, the identity and approval it rests on: the same approval id
            the issued snapshot records, so a printout and a snapshot of the same
            approval cite the same event and can be reconciled later. Screen
            already shows this state in the header and decision blocks. */}
        <div className="print-only-block buyer-pack-provenance">
          <div className="buyer-pack-provenance-title">Pack provenance</div>
          <dl className="buyer-pack-provenance-grid">
            <dt>Pack identifier</dt>
            <dd>{item.id}</dd>
            <dt>Approval status</dt>
            <dd>{packStatusLabel}</dd>
            <dt>Human approver</dt>
            <dd>{approver}</dd>
            {storedDecision?.decidedAt && (
              <>
                <dt>Approval identifier</dt>
                <dd>{buyerPackApprovalId(item.id, storedDecision.decidedAt)}</dd>
                <dt>Approval recorded</dt>
                <dd>{storedDecision.decidedAt}</dd>
              </>
            )}
            <dt>Printed</dt>
            <dd>{printedAt ?? ''}</dd>
            {latestSnapshot && (
              <>
                <dt>Issued snapshot</dt>
                <dd>v{latestSnapshot.manifest.version}</dd>
              </>
            )}
          </dl>
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

export default function DDPBuyerPreview({ inventory, farms, selectedItem, onBack, onGetCoaUrl, approverName }: Props) {
  if (selectedItem) {
    return (
      <BuyerPack
        item={selectedItem}
        farms={farms}
        onBack={onBack}
        onGetCoaUrl={onGetCoaUrl}
        approverName={approverName}
      />
    )
  }

  // Listing a batch here — under a "Human-Approved" heading with the reviewed-supply
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
          No batches are currently human approved for buyer discussion. Approving a batch on the Inventory Dashboard is not enough on its own —
          open its Buyer Pack from Master Inventory, confirm there are no unresolved blocking issues, and record a "Progress" decision.
        </div>
      ) : (
        <>
          <div className="section-label-row" style={{ marginTop: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <DDPVerifiedSupplySeal size={36} />
              <div className="section-label">Human-Approved Available Inventory</div>
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
