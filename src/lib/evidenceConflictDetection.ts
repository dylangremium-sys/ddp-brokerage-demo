import type { EvidenceOwnerType, EvidenceType } from './evidenceAiTypes'

// ─── Evidence Intelligence — deterministic conflict detection (Phase A) ─────
//
// Pure TypeScript. NO AI is involved in anything here. These are the
// deterministic comparisons the governing principle assigns to code, never to
// the model: exact identifier comparison, date chronology, duplicate hashes,
// ownership mismatch, and required-link checks.
//
// Every finding is an OBSERVATION for a human reviewer (requiresHumanReview:
// true). Nothing here returns a compliance decision, a pass/fail, an approval,
// or an enforcement action.

/** A structured, system-of-record view of one evidence item. These are known
 *  facts (human/system entered or already extracted-and-confirmed), distinct
 *  from the untrusted EvidenceAnalysisInput the AI receives. */
export interface EvidenceRecord {
  id: string
  evidenceType: EvidenceType
  ownerType?: EvidenceOwnerType
  /** Entity the document claims to be about / belong to. */
  claimedEntity?: string | null
  /** Entity the record is linked to in the system of record. */
  linkedEntity?: string | null
  batchIdentifier?: string | null
  cultivar?: string | null
  reportNumber?: string | null
  /** A normalised representative value for same-report-number comparison. */
  reportedValue?: string | null
  checksum?: string | null
  harvestDate?: string | null
  sampleDate?: string | null
  reportDate?: string | null
  issueDate?: string | null
  expiryDate?: string | null
  isTranslation?: boolean
  /** Id of the original-language evidence this is a translation of, if linked. */
  sourceLanguageEvidenceId?: string | null
  /** Whether an approved specification is attached to a laboratory result. */
  hasApprovedSpecification?: boolean
}

export type EvidenceFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface EvidenceFinding {
  code: string
  severity: EvidenceFindingSeverity
  title: string
  detail: string
  entityReferences: string[]
  requiresHumanReview: true
}

export interface EvidenceConflictOptions {
  /** ISO date used for expiry evaluation. Expiry checks are SKIPPED when
   *  absent, so results stay deterministic (no reliance on the wall clock). */
  asOfDate?: string
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Parse an ISO-ish date to an epoch, or null if absent/unparseable. */
function toEpoch(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const epoch = Date.parse(value)
  return Number.isNaN(epoch) ? null : epoch
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

// ─── 1. One batch identifier connected to multiple cultivars ─────────────────

export function detectSharedBatchAcrossCultivars(records: EvidenceRecord[]): EvidenceFinding[] {
  const byBatch = new Map<string, Set<string>>()
  const idsByBatch = new Map<string, Set<string>>()
  for (const r of records) {
    if (!nonEmpty(r.batchIdentifier) || !nonEmpty(r.cultivar)) continue
    if (!byBatch.has(r.batchIdentifier)) {
      byBatch.set(r.batchIdentifier, new Set())
      idsByBatch.set(r.batchIdentifier, new Set())
    }
    byBatch.get(r.batchIdentifier)!.add(r.cultivar.trim())
    idsByBatch.get(r.batchIdentifier)!.add(r.id)
  }
  const findings: EvidenceFinding[] = []
  for (const [batch, cultivars] of byBatch) {
    if (cultivars.size > 1) {
      findings.push({
        code: 'shared_batch_multiple_cultivars',
        severity: 'high',
        title: 'One batch identifier is linked to multiple cultivars',
        detail: `Batch "${batch}" appears with distinct cultivars: ${[...cultivars].sort().join(', ')}. A reviewer should confirm whether this is expected.`,
        entityReferences: [...idsByBatch.get(batch)!].sort(),
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 2. Claimed entity differs from linked entity ────────────────────────────

export function detectEntityOwnershipMismatch(records: EvidenceRecord[]): EvidenceFinding[] {
  const findings: EvidenceFinding[] = []
  for (const r of records) {
    if (!nonEmpty(r.claimedEntity) || !nonEmpty(r.linkedEntity)) continue
    if (r.claimedEntity.trim() !== r.linkedEntity.trim()) {
      findings.push({
        code: 'entity_ownership_mismatch',
        severity: 'high',
        title: 'Evidence claims a different entity than the one it is linked to',
        detail: `Evidence "${r.id}" claims entity "${r.claimedEntity}" but is linked to "${r.linkedEntity}". A reviewer should confirm the correct owner.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 3. Licence / certificate expired on the relevant date ───────────────────

export function detectExpiredEvidence(records: EvidenceRecord[], options: EvidenceConflictOptions): EvidenceFinding[] {
  const asOf = toEpoch(options.asOfDate)
  if (asOf === null) return []
  const findings: EvidenceFinding[] = []
  for (const r of records) {
    if (r.evidenceType !== 'licence' && r.evidenceType !== 'certificate') continue
    const expiry = toEpoch(r.expiryDate)
    if (expiry === null) continue
    if (expiry < asOf) {
      findings.push({
        code: 'expired_evidence',
        severity: 'high',
        title: 'Licence or certificate expired before the relevant date',
        detail: `${r.evidenceType} "${r.id}" expired on ${r.expiryDate}, before the relevant date ${options.asOfDate}. A reviewer should confirm current validity.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 4 & 5. Date chronology errors ───────────────────────────────────────────

export function detectDateChronologyErrors(records: EvidenceRecord[]): EvidenceFinding[] {
  const findings: EvidenceFinding[] = []
  for (const r of records) {
    const harvest = toEpoch(r.harvestDate)
    const sample = toEpoch(r.sampleDate)
    const report = toEpoch(r.reportDate)
    if (harvest !== null && sample !== null && sample < harvest) {
      findings.push({
        code: 'sample_before_harvest',
        severity: 'medium',
        title: 'Sample date precedes harvest date',
        detail: `Evidence "${r.id}" has a sample date (${r.sampleDate}) earlier than its harvest date (${r.harvestDate}). A reviewer should confirm the chronology.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
    if (sample !== null && report !== null && report < sample) {
      findings.push({
        code: 'report_before_sample',
        severity: 'medium',
        title: 'Report date precedes sample date',
        detail: `Evidence "${r.id}" has a report date (${r.reportDate}) earlier than its sample date (${r.sampleDate}). A reviewer should confirm the chronology.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 6. Missing CoA-to-batch link ────────────────────────────────────────────

export function detectMissingCoaBatchLink(records: EvidenceRecord[]): EvidenceFinding[] {
  const findings: EvidenceFinding[] = []
  for (const r of records) {
    if (r.evidenceType !== 'coa') continue
    if (!nonEmpty(r.batchIdentifier)) {
      findings.push({
        code: 'missing_coa_batch_link',
        severity: 'medium',
        title: 'CoA has no linked batch identifier',
        detail: `CoA "${r.id}" is not linked to any batch identifier. A reviewer should attach the correct batch reference.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 7. Translated evidence with no source-language original ──────────────────

export function detectTranslationWithoutOriginal(records: EvidenceRecord[]): EvidenceFinding[] {
  const ids = new Set(records.map(r => r.id))
  const findings: EvidenceFinding[] = []
  for (const r of records) {
    if (!r.isTranslation) continue
    const hasOriginal = nonEmpty(r.sourceLanguageEvidenceId) && ids.has(r.sourceLanguageEvidenceId)
    if (!hasOriginal) {
      findings.push({
        code: 'translation_without_original',
        severity: 'low',
        title: 'Translated evidence has no source-language original',
        detail: `Evidence "${r.id}" is marked as a translation but no source-language original is linked or present. A reviewer should obtain the original.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 8. Duplicate checksum ────────────────────────────────────────────────────

export function detectDuplicateChecksums(records: EvidenceRecord[]): EvidenceFinding[] {
  const byChecksum = new Map<string, string[]>()
  for (const r of records) {
    if (!nonEmpty(r.checksum)) continue
    const key = r.checksum.trim().toLowerCase()
    if (!byChecksum.has(key)) byChecksum.set(key, [])
    byChecksum.get(key)!.push(r.id)
  }
  const findings: EvidenceFinding[] = []
  for (const [checksum, idList] of byChecksum) {
    if (idList.length > 1) {
      findings.push({
        code: 'duplicate_checksum',
        severity: 'medium',
        title: 'Multiple evidence items share an identical checksum',
        detail: `Checksum ${checksum} is shared by evidence: ${[...idList].sort().join(', ')}. A reviewer should confirm whether a document was duplicated.`,
        entityReferences: [...idList].sort(),
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 9. Same report number, inconsistent values ──────────────────────────────

export function detectInconsistentReportValues(records: EvidenceRecord[]): EvidenceFinding[] {
  const byReport = new Map<string, { ids: string[]; values: Set<string> }>()
  for (const r of records) {
    if (!nonEmpty(r.reportNumber) || !nonEmpty(r.reportedValue)) continue
    const key = r.reportNumber.trim()
    if (!byReport.has(key)) byReport.set(key, { ids: [], values: new Set() })
    const entry = byReport.get(key)!
    entry.ids.push(r.id)
    entry.values.add(r.reportedValue.trim())
  }
  const findings: EvidenceFinding[] = []
  for (const [reportNumber, entry] of byReport) {
    if (entry.values.size > 1) {
      findings.push({
        code: 'inconsistent_report_values',
        severity: 'high',
        title: 'Same report number carries inconsistent values',
        detail: `Report number "${reportNumber}" appears with differing values: ${[...entry.values].sort().join(' | ')}. A reviewer should confirm which is correct.`,
        entityReferences: [...entry.ids].sort(),
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── 10. Laboratory result with no approved specification ────────────────────

export function detectLabResultWithoutApprovedSpecification(records: EvidenceRecord[]): EvidenceFinding[] {
  const findings: EvidenceFinding[] = []
  for (const r of records) {
    if (r.evidenceType !== 'coa' && r.evidenceType !== 'sampling_record') continue
    if (r.hasApprovedSpecification !== true) {
      findings.push({
        code: 'lab_result_without_approved_specification',
        severity: 'medium',
        title: 'Laboratory result has no approved specification attached',
        detail: `Laboratory result "${r.id}" has no approved specification to compare against. No determination can be made until a reviewer attaches one.`,
        entityReferences: [r.id],
        requiresHumanReview: true,
      })
    }
  }
  return findings
}

// ─── Aggregate ────────────────────────────────────────────────────────────────

/**
 * Runs every deterministic conflict check and returns the combined findings.
 * Pure: no AI, no I/O, no persistence, no decision — only observations for a
 * human reviewer.
 */
export function detectEvidenceConflicts(
  records: EvidenceRecord[],
  options: EvidenceConflictOptions = {},
): EvidenceFinding[] {
  return [
    ...detectSharedBatchAcrossCultivars(records),
    ...detectEntityOwnershipMismatch(records),
    ...detectExpiredEvidence(records, options),
    ...detectDateChronologyErrors(records),
    ...detectMissingCoaBatchLink(records),
    ...detectTranslationWithoutOriginal(records),
    ...detectDuplicateChecksums(records),
    ...detectInconsistentReportValues(records),
    ...detectLabResultWithoutApprovedSpecification(records),
  ]
}
