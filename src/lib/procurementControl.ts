// ─── Procurement control derivations ────────────────────────────────────────
// Turns the existing farm/inventory records into the evidence-labelled
// structures the procurement-authority plan calls for: document
// requirements, COA intelligence, and a risk register. Every derivation
// reads only fields that already exist on FarmProfile / InventoryItem — it
// never invents a farm, quantity, licence, COA, or test result. Anything
// DDP staff decide on top of that (reviewed / verified / rejected /
// expired, or a risk status change) is stored locally as an override and
// merged back in; it never overwrites the underlying claim.
import type {
  DocumentRequirement,
  DocumentRequirementType,
  EvidenceStatus,
  FarmProfile,
  InventoryItem,
  CoaIntelligence,
  ProcurementDecision,
  RiskRegisterEntry,
  RiskSeverity,
  RiskStatus,
} from '../types'

export const DOCUMENT_REQUIREMENT_LABELS: Record<DocumentRequirementType, string> = {
  farm_identity: 'Farm Identity',
  farm_license: 'Farm Licence(s)',
  coa: 'Certificate of Analysis (COA)',
  batch_number: 'Batch Number',
  inventory_quantity_proof: 'Inventory Quantity Proof',
  inventory_photos: 'Inventory Photos',
  inventory_video: 'Inventory Video',
  storage_evidence: 'Storage Evidence',
  chain_of_custody: 'Chain of Custody',
  gacp_evidence: 'GACP Evidence',
  gmp_evidence: 'GMP Evidence',
  export_readiness_docs: 'Export Readiness Documents',
  responsible_contact: 'Responsible Contact',
}

export const DOCUMENT_REQUIREMENT_TYPES = Object.keys(DOCUMENT_REQUIREMENT_LABELS) as DocumentRequirementType[]

export function getFarmInventory(farm: FarmProfile, inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter(i =>
    i.farmId === farm.id ||
    i.farmName === farm.tradingName ||
    i.farmName === farm.legalBusinessName
  )
}

// ── Document requirement matrix ─────────────────────────────────────────────

function baseRequirement(
  farmId: string,
  type: DocumentRequirementType,
  status: EvidenceStatus,
  reference?: string,
  notes?: string,
): DocumentRequirement {
  return { farmId, type, status, reference: reference || undefined, notes }
}

/**
 * Derives the raw (un-overridden) evidence status for each required document
 * type from a farm profile and its associated inventory batches. Farm-level
 * fields on FarmProfile are plain text entered by the farm — never a real
 * uploaded file — so they can only ever read as "claimed" or "missing" here.
 * Only fields backed by an actual received file (Supabase storage path, or
 * an uploaded photo/data URL) can read as "documented".
 */
export function deriveFarmDocumentRequirements(farm: FarmProfile, inventory: InventoryItem[]): DocumentRequirement[] {
  const batches = getFarmInventory(farm, inventory)
  const hasCoaFile = batches.some(b => !!b.coaStoragePath)
  const hasCoaClaim = batches.some(b => !!b.certFileName) || !!farm.coaFiles
  const hasBatchNumber = batches.some(b => !!b.batchNumber)
  const hasPhotoFile = batches.some(b => !!b.photoUrl || (b.photoUrls?.length ?? 0) > 0)
  const hasStorageNote = batches.some(b => !!b.storageConditions)
  const hasLicense = !!(farm.cultivationLicence || farm.processingLicence || farm.manufacturingLicence
    || farm.medicalCannabisLicence || farm.exportLicence || farm.importLicence)

  return [
    baseRequirement(farm.id, 'farm_identity',
      farm.legalBusinessName && farm.registrationNumber ? 'claimed' : 'missing',
      undefined, 'Legal name and registration number as declared by the farm — not independently confirmed.'),

    baseRequirement(farm.id, 'farm_license',
      hasLicense ? 'claimed' : 'missing',
      [farm.cultivationLicence, farm.processingLicence, farm.exportLicence].filter(Boolean).join(', ') || undefined,
      'Licence numbers as declared. Verification requires checking against the issuing authority.'),

    baseRequirement(farm.id, 'coa',
      hasCoaFile ? 'documented' : hasCoaClaim ? 'claimed' : 'missing',
      batches.find(b => b.certFileName)?.certFileName,
      hasCoaFile ? 'A COA file has been received into storage for at least one batch.' : undefined),

    baseRequirement(farm.id, 'batch_number',
      hasBatchNumber ? 'claimed' : 'missing',
      undefined, 'Batch numbers are farm-entered identifiers, not yet cross-checked against a batch tracking system.'),

    baseRequirement(farm.id, 'inventory_quantity_proof',
      'missing',
      undefined, 'No distinct quantity-proof evidence (e.g. weighed delivery note) is recorded — quantityKg is a farm claim only.'),

    baseRequirement(farm.id, 'inventory_photos',
      hasPhotoFile ? 'documented' : 'missing',
      undefined, hasPhotoFile ? 'Photo file(s) received for at least one batch.' : undefined),

    baseRequirement(farm.id, 'inventory_video',
      'missing',
      undefined, 'No inventory video capture is supported by the current intake flow.'),

    baseRequirement(farm.id, 'storage_evidence',
      hasStorageNote ? 'claimed' : 'missing',
      undefined, 'Storage conditions are a free-text description supplied by the farm, not a photo or sensor log.'),

    baseRequirement(farm.id, 'chain_of_custody',
      'missing',
      undefined, 'No chain-of-custody record is captured between farm, DDP, and buyer in the current workflow.'),

    baseRequirement(farm.id, 'gacp_evidence',
      farm.gacpCert ? 'claimed' : 'missing',
      farm.gacpCert || undefined),

    baseRequirement(farm.id, 'gmp_evidence',
      farm.gmpCert ? 'claimed' : 'missing',
      farm.gmpCert || undefined),

    baseRequirement(farm.id, 'export_readiness_docs',
      farm.exportLicence ? 'claimed' : 'missing',
      farm.exportLicence || undefined,
      'An export licence being on file does not by itself confirm export-readiness for a specific destination market.'),

    baseRequirement(farm.id, 'responsible_contact',
      (farm.primaryContact && farm.mobileNumber) ? 'claimed' : 'missing'),
  ]
}

// ── Local overrides: DDP staff can advance a requirement's status (e.g. from
// documented to reviewed/verified, or to rejected/expired) with a note. This
// is a deliberate human decision, recorded locally, and never silently
// changes what the underlying data can prove. ──────────────────────────────

export const REQUIREMENT_OVERRIDE_KEY = 'ddp_requirement_overrides'

interface RequirementOverride {
  status: EvidenceStatus
  notes?: string
  lastUpdated: string
}

function requirementOverrideKey(farmId: string, type: DocumentRequirementType): string {
  return `${farmId}::${type}`
}

export function loadRequirementOverrides(): Record<string, RequirementOverride> {
  try {
    return JSON.parse(localStorage.getItem(REQUIREMENT_OVERRIDE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveRequirementOverride(farmId: string, type: DocumentRequirementType, status: EvidenceStatus, notes?: string): void {
  const all = loadRequirementOverrides()
  all[requirementOverrideKey(farmId, type)] = { status, notes, lastUpdated: new Date().toISOString() }
  localStorage.setItem(REQUIREMENT_OVERRIDE_KEY, JSON.stringify(all))
}

export function applyRequirementOverrides(base: DocumentRequirement[]): DocumentRequirement[] {
  const overrides = loadRequirementOverrides()
  return base.map(req => {
    const override = overrides[requirementOverrideKey(req.farmId, req.type)]
    if (!override) return req
    return { ...req, status: override.status, notes: override.notes ?? req.notes, lastUpdated: override.lastUpdated }
  })
}

// ── COA intelligence ─────────────────────────────────────────────────────────

/**
 * Maps an InventoryItem's already-recorded lab fields onto the structured
 * CoaIntelligence shape and flags obvious gaps/failures. Fields with no
 * backing data on the item are left undefined — no values are invented.
 */
export function deriveCoaIntelligence(item: InventoryItem): CoaIntelligence {
  const hasRealFile = !!item.coaStoragePath
  const hasClaim = !!(item.certFileName || item.coaAvailable)
  const redFlags: string[] = []

  if (!hasRealFile && !hasClaim) redFlags.push('No COA on file for this batch')
  if (item.heavyMetalsStatus === 'fail') redFlags.push('Heavy metals test failed')
  if (item.pesticidesStatus === 'fail') redFlags.push('Pesticides test failed')
  if (item.mycotoxinsStatus === 'fail') redFlags.push('Mycotoxins test failed')
  if (item.microbialStatus === 'fail') redFlags.push('Microbial test failed')
  if ((hasRealFile || hasClaim) && !item.labName) redFlags.push('Lab name not recorded')
  if ((hasRealFile || hasClaim) && !item.reportNumber) redFlags.push('Lab report number not recorded')
  if ((hasRealFile || hasClaim) && !item.testDate) redFlags.push('Test date not recorded')

  let evidenceStatus: EvidenceStatus = hasRealFile ? 'documented' : hasClaim ? 'claimed' : 'missing'

  if (item.expiryDate) {
    const expiry = new Date(item.expiryDate)
    if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
      redFlags.push('Recorded expiry date has passed')
      if (evidenceStatus !== 'missing') evidenceStatus = 'expired'
    }
  }

  return {
    batchId: item.id,
    sampleName: item.sampleName || undefined,
    strainName: item.productName || undefined,
    batchNumber: item.batchNumber || undefined,
    reportNumber: item.reportNumber || undefined,
    labName: item.labName || undefined,
    reportDate: item.testDate || undefined,
    manufacturingDate: undefined,
    expiryDate: item.expiryDate || undefined,
    totalThcPercent: item.thcPct || undefined,
    totalCbdPercent: item.cbdPct || undefined,
    totalTerpenesPercent: item.totalTerpenesPct,
    moisturePercent: item.moisturePct || undefined,
    pesticidesStatus: item.pesticidesStatus,
    heavyMetalsStatus: item.heavyMetalsStatus,
    mycotoxinsStatus: item.mycotoxinsStatus,
    microbialStatus: item.microbialStatus,
    sourceDocument: item.certFileName || (hasRealFile ? 'On file (DDP document storage)' : undefined),
    evidenceStatus,
    redFlags,
  }
}

// ── Risk register ────────────────────────────────────────────────────────────

/**
 * Stable 32-bit FNV-1a of the risk's content, as 8 lowercase hex characters.
 *
 * Not a security primitive and never used as one: this is a change-detector, so
 * a non-cryptographic hash is the right tool. It must be SYNCHRONOUS (the whole
 * derive/override path is), dependency-free, and identical across reloads and
 * browsers — SubtleCrypto is async and Math.random-seeded hashing would break
 * the "unchanged risk keeps its override" half of the contract.
 */
function riskContentFingerprint(severity: RiskSeverity, issue: string): string {
  const input = `${severity} ${issue}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // FNV prime 16777619, via shifts to stay in 32-bit integer arithmetic.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Composes a risk id that is bound to the risk's CONTENT, not only to the
 * entity it concerns.
 *
 * THE DEFECT THIS CLOSES (audit F1). The id used to be `risk-batch-${item.id}`,
 * which is content-independent, while applyRiskOverrides() matches on that id
 * alone and overrides `status`. So a "Resolved" recorded against a cosmetic gap
 * ("Lab name not recorded") kept applying after the batch's risk content changed
 * to something else entirely — including a failed heavy-metals test, which
 * raises severity 'blocker' under the SAME id and therefore arrived
 * pre-resolved. hasBlockingIssues then read zero unresolved blockers, the buyer
 * approval gate opened, and Issue Buyer Pack enabled for a contaminated batch.
 *
 * Folding a fingerprint of `severity + issue` into the id means a changed risk
 * is a NEW risk carrying no override:
 *   • Content changed  ⇒ different fingerprint ⇒ different id ⇒ the old override
 *     no longer matches and the risk is presented as 'open'. The old entry is
 *     rendered INERT, never migrated onto the new content — silently carrying a
 *     clearance across a change in what was cleared is the defect itself.
 *   • Content unchanged ⇒ identical fingerprint ⇒ identical id ⇒ a genuine
 *     override still applies, so ordinary triage is unaffected.
 *
 * Pre-fix overrides are keyed by bare ids with no '#' segment, which no derived
 * id can now produce, so every one of them is inert by construction.
 */
export function composeRiskId(base: string, severity: RiskSeverity, issue: string): string {
  return `${base}#${riskContentFingerprint(severity, issue)}`
}

/**
 * Auto-derives risk entries from real gaps already visible in the data
 * (failed lab results, missing COAs, farm status flags). This is a mechanical
 * scan, not a judgement call — severity/owner/status are DDP's to assess and
 * override; "Unassigned" is used rather than inventing a name.
 */
export function deriveAutoRisks(farms: FarmProfile[], inventory: InventoryItem[]): RiskRegisterEntry[] {
  const risks: RiskRegisterEntry[] = []

  for (const item of inventory) {
    const coa = deriveCoaIntelligence(item)
    if (coa.redFlags.length === 0) continue
    const hasFail = [coa.heavyMetalsStatus, coa.pesticidesStatus, coa.mycotoxinsStatus, coa.microbialStatus].includes('fail')
    const severity: RiskSeverity = hasFail
      ? 'blocker'
      : (coa.evidenceStatus === 'missing' || coa.evidenceStatus === 'expired')
        ? 'high'
        : 'medium'
    const requiredAction = hasFail
      ? 'Do not progress. Escalate the failed lab result to the farm and a qualified party before any buyer disclosure.'
      : coa.evidenceStatus === 'missing'
        ? 'Request a COA from the farm before this batch can be documented.'
        : 'Request an updated COA or lab confirmation.'

    const issue = coa.redFlags.join('; ')
    risks.push({
      riskId: composeRiskId(`risk-batch-${item.id}`, severity, issue),
      batchId: item.id,
      farmId: item.farmId,
      severity,
      issue,
      requiredAction,
      owner: 'Unassigned',
      status: 'open',
      evidenceStatus: coa.evidenceStatus,
    })
  }

  // Farm risks are fingerprinted on the same terms as batch risks. Their issue
  // text is fixed per branch today, so the fingerprint is stable in practice —
  // but deriving the id uniformly means a future edit to the wording or the
  // severity of a farm risk cannot silently inherit a clearance either.
  for (const farm of farms) {
    if (farm.status === 'More Information Required') {
      const issue = 'Farm profile marked "More Information Required" by DDP.'
      risks.push({
        riskId: composeRiskId(`risk-farm-${farm.id}-info`, 'medium', issue),
        farmId: farm.id,
        severity: 'medium',
        issue,
        requiredAction: 'Follow up with the farm contact for the outstanding profile fields.',
        owner: 'Unassigned',
        status: 'open',
        evidenceStatus: 'claimed',
      })
    }
    if (farm.status === 'Watchlist') {
      const issue = 'Farm is on the DDP watchlist.'
      risks.push({
        riskId: composeRiskId(`risk-farm-${farm.id}-watchlist`, 'high', issue),
        farmId: farm.id,
        severity: 'high',
        issue,
        requiredAction: 'Review the watchlist reason before progressing any batch from this farm.',
        owner: 'Unassigned',
        status: 'open',
        evidenceStatus: 'reviewed',
      })
    }
  }

  return risks
}

// Local status overrides for risk entries — DDP moving a risk through
// open -> in_review -> resolved/accepted. Kept local (no Supabase writes)
// consistent with how carbon-programme status changes are handled elsewhere
// pending an approved schema/RLS migration.
export const RISK_OVERRIDE_KEY = 'ddp_risk_overrides'

interface RiskOverride {
  status: RiskStatus
  owner?: string
  notes?: string
  updatedAt: string
}

export function loadRiskOverrides(): Record<string, RiskOverride> {
  try {
    return JSON.parse(localStorage.getItem(RISK_OVERRIDE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveRiskOverride(riskId: string, status: RiskStatus, owner?: string, notes?: string): void {
  const all = loadRiskOverrides()
  all[riskId] = { status, owner, notes, updatedAt: new Date().toISOString() }
  localStorage.setItem(RISK_OVERRIDE_KEY, JSON.stringify(all))
}

/**
 * Applies recorded overrides by exact id match.
 *
 * Because riskId is now content-bound (composeRiskId), an override only matches
 * a risk whose severity and issue are unchanged since it was recorded. An
 * override against superseded content simply finds no risk to attach to and is
 * left where it is — inert, not deleted and not migrated. That is the point:
 * the clearance was given for a specific stated issue, and it does not travel to
 * a different one.
 */
export function applyRiskOverrides(base: RiskRegisterEntry[]): RiskRegisterEntry[] {
  const overrides = loadRiskOverrides()
  return base.map(risk => {
    const override = overrides[risk.riskId]
    if (!override) return risk
    return { ...risk, status: override.status, owner: override.owner ?? risk.owner }
  })
}

// ── Procurement decisions (buyer pack) ───────────────────────────────────────
// A DDP decision recorded against a specific batch's buyer pack. Local-only,
// same rationale as the overrides above.

export const DECISION_KEY = 'ddp_procurement_decisions'

export interface StoredDecision {
  decision: ProcurementDecision
  notes?: string
  decidedAt: string
}

export function loadProcurementDecisions(): Record<string, StoredDecision> {
  try {
    return JSON.parse(localStorage.getItem(DECISION_KEY) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * `decidedAt` may be supplied to preserve an AUTHORITATIVE timestamp — the
 * server's decided_at, when caching a decision read back from the server. It is
 * generated locally only for a genuinely local decision. This matters because
 * prepareBuyerPackSnapshotInput freezes decidedAt into an immutable buyer-pack
 * snapshot as the approval timestamp: re-stamping it on every cache refresh would
 * let merely opening a page rewrite when the decision was made.
 */
export function saveProcurementDecision(
  batchId: string,
  decision: ProcurementDecision,
  notes?: string,
  decidedAt?: string,
): void {
  const all = loadProcurementDecisions()
  all[batchId] = { decision, notes, decidedAt: decidedAt ?? new Date().toISOString() }
  localStorage.setItem(DECISION_KEY, JSON.stringify(all))
}

export const PROCUREMENT_DECISION_LABELS: Record<ProcurementDecision, string> = {
  progress: 'Progress',
  hold: 'Hold',
  reject: 'Reject',
  request_documents: 'Request Documents',
  request_fresh_coa: 'Request Fresh COA',
  request_inventory_proof: 'Request Inventory Proof',
  escalate_review: 'Escalate Review',
}
