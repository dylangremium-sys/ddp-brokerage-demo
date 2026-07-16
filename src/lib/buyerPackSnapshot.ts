import type {
  ComplianceVerificationTier,
  DocumentRequirement,
  InventoryItem,
  ProcurementDecision,
  RiskRegisterEntry,
} from '../types'
import type { BuyerPackSnapshotRepository } from './buyerPackSnapshotRepository'
import type { BuyerPackAuditEvent } from './buyerPackAudit'

// ─── Immutable Buyer Pack Snapshots — domain layer ──────────────────────────
//
// When a Buyer Pack is generated after explicit human approval, this module
// permanently preserves exactly what the buyer saw. A snapshot is created
// only from values the caller already computed and supplies — this module
// never re-derives evidence, risk, or compliance data itself, so it can never
// drift from (or duplicate) the derivation logic in lib/procurementControl.ts
// or the Buyer Pack page. Its only job is to validate, copy, hash, and freeze.
//
// Never allow "absence of blockers" to substitute for approval: creation is
// rejected unless an explicit recorded "progress" ProcurementDecision and a
// named human approver are supplied.

export interface BuyerPackCoaSummary {
  hasCoaFile: boolean
  certFileName: string | null
  coaStoragePath: string | null
}

export interface BuyerPackComplianceSummary {
  tier: ComplianceVerificationTier
}

export interface BuyerPackDocumentCheckResult {
  key: string
  label: string
  passed: boolean
}

export interface BuyerPackDocumentSummary {
  passCount: number
  totalChecks: number
  results: BuyerPackDocumentCheckResult[]
}

export interface FrozenBuyerPackEvidence {
  inventory: InventoryItem
  coas: BuyerPackCoaSummary
  complianceSummary: BuyerPackComplianceSummary
  procurementNotes: string | null
  documentSummary: BuyerPackDocumentSummary
  risks: RiskRegisterEntry[]
  evidenceSummary: DocumentRequirement[]
}

export interface BuyerPackSnapshotManifest {
  snapshotId: string
  packId: string
  version: number
  approvalId: string
  approvalTimestamp: string
  procurementDecision: ProcurementDecision
  approvedBy: string
  generatedAt: string
  generatedBy: string
  contentHash: string
}

export interface BuyerPackSnapshot {
  manifest: BuyerPackSnapshotManifest
  frozenEvidence: FrozenBuyerPackEvidence
  immutable: true
}

export interface CreateBuyerPackSnapshotInput {
  packId: string
  version: number
  generatedBy: string
  approvalId: string
  approvalTimestamp: string
  procurementDecision: ProcurementDecision
  approvedBy: string
  inventory: InventoryItem
  coas: BuyerPackCoaSummary
  complianceSummary: BuyerPackComplianceSummary
  procurementNotes: string | null
  documentSummary: BuyerPackDocumentSummary
  risks: RiskRegisterEntry[]
  evidenceSummary: DocumentRequirement[]
}

// Recursively sorts object keys so JSON.stringify produces the same string
// regardless of property insertion order — required for a stable hash.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key])
        return acc
      }, {} as Record<string, unknown>)
  }
  return value
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/**
 * The content hash covers exactly what the buyer saw and under what approval
 * — frozen evidence plus the approval context — but deliberately excludes
 * bookkeeping fields (snapshotId, generatedAt, generatedBy, packId, version)
 * so that identical evidence approved the same way always hashes identically,
 * independent of when or as which version the snapshot object was created.
 */
async function computeContentHash(
  frozenEvidence: FrozenBuyerPackEvidence,
  approvalId: string,
  approvalTimestamp: string,
  procurementDecision: ProcurementDecision,
  approvedBy: string,
): Promise<string> {
  const canonical = canonicalJsonStringify({ frozenEvidence, approvalId, approvalTimestamp, procurementDecision, approvedBy })
  return sha256Hex(canonical)
}

export async function createBuyerPackSnapshot(input: CreateBuyerPackSnapshotInput): Promise<BuyerPackSnapshot> {
  if (input.procurementDecision !== 'progress') {
    throw new Error('A buyer pack snapshot may only be created for a recorded "progress" procurement decision.')
  }
  if (input.approvedBy.trim().length === 0) {
    throw new Error('A buyer pack snapshot requires an identified human approver.')
  }

  const frozenEvidence = deepFreeze(
    structuredClone({
      inventory: input.inventory,
      coas: input.coas,
      complianceSummary: input.complianceSummary,
      procurementNotes: input.procurementNotes,
      documentSummary: input.documentSummary,
      risks: input.risks,
      evidenceSummary: input.evidenceSummary,
    }),
  )

  const contentHash = await computeContentHash(
    frozenEvidence,
    input.approvalId,
    input.approvalTimestamp,
    input.procurementDecision,
    input.approvedBy,
  )

  const manifest: BuyerPackSnapshotManifest = deepFreeze({
    snapshotId: crypto.randomUUID(),
    packId: input.packId,
    version: input.version,
    approvalId: input.approvalId,
    approvalTimestamp: input.approvalTimestamp,
    procurementDecision: input.procurementDecision,
    approvedBy: input.approvedBy,
    generatedAt: new Date().toISOString(),
    generatedBy: input.generatedBy,
    contentHash,
  })

  return deepFreeze({ manifest, frozenEvidence, immutable: true as const })
}

export interface GenerateNextBuyerPackSnapshotResult {
  snapshot: BuyerPackSnapshot
  previousVersion: number | null
}

/**
 * Computes the next version number for packId from the repository, creates
 * the snapshot at that version, and saves it. Returns the previous version
 * number (if any) so a caller can decide to log a "pack_superseded" audit
 * event — this module never logs into buyerPackAudit.ts itself, keeping the
 * two modules independently testable with no runtime dependency between them.
 */
export async function generateNextBuyerPackSnapshot(
  repository: BuyerPackSnapshotRepository,
  input: Omit<CreateBuyerPackSnapshotInput, 'version'>,
): Promise<GenerateNextBuyerPackSnapshotResult> {
  const latest = await repository.getLatest(input.packId)
  const nextVersion = latest ? latest.manifest.version + 1 : 1
  const snapshot = await createBuyerPackSnapshot({ ...input, version: nextVersion })
  await repository.save(snapshot)
  return { snapshot, previousVersion: latest ? latest.manifest.version : null }
}

// ─── Issue eligibility + input assembly (pure) ──────────────────────────────
//
// Assembles a snapshot input from evidence the caller already derived — it
// never derives evidence itself (same discipline as the rest of this module).
// Its second job is to re-assert the human-approval gate at assembly time, so
// the gate is enforced independently of any UI button's disabled state: a
// snapshot input is produced only when a batch is human-approved AND its
// recorded procurement decision is exactly "progress" AND a named approver is
// present. createBuyerPackSnapshot re-checks the same conditions downstream,
// so this is defence-in-depth, never a weakening of the gate.

/** The minimal recorded procurement decision this assembly needs. */
export interface BuyerPackStoredDecision {
  decision: ProcurementDecision
  decidedAt: string
  notes?: string
}

export interface BuyerPackSnapshotEvidenceInput {
  packId: string
  generatedBy: string
  approvedBy: string
  isHumanApproved: boolean
  storedDecision: BuyerPackStoredDecision | null
  inventory: InventoryItem
  coas: BuyerPackCoaSummary
  complianceSummary: BuyerPackComplianceSummary
  documentChecks: BuyerPackDocumentCheckResult[]
  risks: RiskRegisterEntry[]
  evidenceSummary: DocumentRequirement[]
}

/** The conditions every buyer-pack release path must satisfy, whatever the format. */
export interface BuyerPackReleaseConditions {
  isHumanApproved: boolean
  storedDecision: BuyerPackStoredDecision | null
  approvedBy: string
}

export type BuyerPackReleaseEligibility =
  | { eligible: false; reason: string }
  | { eligible: true; approvalDecision: BuyerPackStoredDecision }

/**
 * The single authority on whether a buyer pack may leave DDP — in ANY form.
 *
 * Issuing a snapshot and printing a PDF are the same act in every way that
 * matters: both put the pack in front of a buyer. They must therefore answer to
 * one predicate, not to two that merely look alike. A print path that checked
 * only `isHumanApproved` would silently drop the approver-identity condition
 * below and diverge from issuance the moment either changes.
 *
 * The reasons are the caller-facing strings and are deliberately worded in terms
 * of issuance: releasing a pack IS issuing it, and inventing softer wording for
 * the print path would create a second vocabulary for one legal act.
 *
 * Returns the validated decision so callers need no non-null assertion — the
 * gate is the only thing entitled to conclude the decision is present.
 */
export function deriveBuyerPackReleaseEligibility(
  conditions: BuyerPackReleaseConditions,
): BuyerPackReleaseEligibility {
  if (!conditions.isHumanApproved) {
    return { eligible: false, reason: 'Batch is not human-approved for buyer discussion yet.' }
  }
  if (!conditions.storedDecision || conditions.storedDecision.decision !== 'progress') {
    return { eligible: false, reason: 'A recorded "Progress" procurement decision is required before issuing a buyer pack.' }
  }
  if (conditions.approvedBy.trim().length === 0) {
    return { eligible: false, reason: 'An identified human approver is required to issue a buyer pack.' }
  }
  return { eligible: true, approvalDecision: conditions.storedDecision }
}

/**
 * Stable identifier for the approval event a released pack rests on: the batch
 * plus the moment the decision was recorded. Shared so a printed pack cites the
 * same approval identity as the issued snapshot rather than a lookalike.
 */
export function buyerPackApprovalId(packId: string, decidedAt: string): string {
  return `${packId}:${decidedAt}`
}

export type BuyerPackIssueEligibility =
  | { eligible: false; reason: string }
  | { eligible: true; input: Omit<CreateBuyerPackSnapshotInput, 'version'> }

export function prepareBuyerPackSnapshotInput(evidence: BuyerPackSnapshotEvidenceInput): BuyerPackIssueEligibility {
  const gate = deriveBuyerPackReleaseEligibility({
    isHumanApproved: evidence.isHumanApproved,
    storedDecision: evidence.storedDecision,
    approvedBy: evidence.approvedBy,
  })
  if (!gate.eligible) {
    return { eligible: false, reason: gate.reason }
  }

  const documentSummary: BuyerPackDocumentSummary = {
    passCount: evidence.documentChecks.filter(c => c.passed).length,
    totalChecks: evidence.documentChecks.length,
    results: evidence.documentChecks,
  }

  return {
    eligible: true,
    input: {
      packId: evidence.packId,
      generatedBy: evidence.generatedBy,
      // The approval event is identified by the batch plus the moment the
      // decision was recorded — stable for a given recorded decision.
      approvalId: buyerPackApprovalId(evidence.packId, gate.approvalDecision.decidedAt),
      approvalTimestamp: gate.approvalDecision.decidedAt,
      procurementDecision: gate.approvalDecision.decision,
      approvedBy: evidence.approvedBy,
      inventory: evidence.inventory,
      coas: evidence.coas,
      complianceSummary: evidence.complianceSummary,
      procurementNotes: gate.approvalDecision.notes ?? null,
      documentSummary,
      risks: evidence.risks,
      evidenceSummary: evidence.evidenceSummary,
    },
  }
}

export type BuyerPackSnapshotStatus = 'generated' | 'issued' | 'superseded' | 'archived'

/**
 * Never stored on the snapshot itself — a field that changes after creation
 * would be a mutation, contradicting "future edits must never change
 * historical Buyer Packs." Status is always computed fresh from the
 * repository (is a later version present?) and the audit trail (has this
 * version been viewed, or archived?).
 */
export async function deriveSnapshotStatus(
  repository: BuyerPackSnapshotRepository,
  auditEvents: BuyerPackAuditEvent[],
  packId: string,
  version: number,
): Promise<BuyerPackSnapshotStatus> {
  const eventsForVersion = auditEvents.filter(e => e.packId === packId && e.snapshotVersion === version)

  if (eventsForVersion.some(e => e.action === 'pack_archived')) {
    return 'archived'
  }

  const latest = await repository.getLatest(packId)
  if (latest && latest.manifest.version > version) {
    return 'superseded'
  }

  if (eventsForVersion.some(e => e.action === 'pack_viewed')) {
    return 'issued'
  }

  return 'generated'
}
