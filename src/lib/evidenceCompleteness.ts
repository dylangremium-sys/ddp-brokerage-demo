import type { EvidenceType } from './evidenceAiTypes'
import type { EvidenceFinding, EvidenceRecord } from './evidenceConflictDetection'

// ─── Evidence Intelligence — deterministic completeness (Phase A) ───────────
//
// Pure TypeScript. Assesses, per required evidence item, whether the expected
// documentation is present / missing / incomplete / conflicting / expired /
// not-applicable / pending review / unable to verify.
//
// This is NOT a legal-compliance score. The percentage it can emit is a
// DOCUMENTATION-completeness indicator only, explicitly labelled non-legal.
// Every requirement is explained individually; the percentage is a convenience,
// never a substitute for the per-requirement detail. No AI, no I/O, no
// persistence, no decision.

export type EvidenceRequirementStatus =
  | 'present'
  | 'missing'
  | 'incomplete'
  | 'conflicting'
  | 'expired'
  | 'not_applicable'
  | 'pending_review'
  | 'unable_to_verify'

/** One expected piece of documentation and the evidence type that satisfies it. */
export interface EvidenceRequirementDefinition {
  key: string
  label: string
  satisfiedBy: EvidenceType
  /** Set false to declare the requirement not applicable to this assessment. */
  applicable?: boolean
}

export interface EvidenceRequirementAssessment {
  key: string
  label: string
  status: EvidenceRequirementStatus
  detail: string
  /** Ids of the records considered for this requirement (if any). */
  evidenceReferences: string[]
  requiresHumanReview: true
}

export interface EvidenceCompletenessInput {
  requirements: EvidenceRequirementDefinition[]
  records: EvidenceRecord[]
  /** Deterministic conflict findings; a requirement whose record is referenced
   *  by one is reported as 'conflicting'. */
  conflicts?: EvidenceFinding[]
  /** ISO date for expiry evaluation. Expiry is not evaluated when absent. */
  asOfDate?: string
  /** Record ids a reviewer has flagged as still pending review. */
  pendingReviewEvidenceIds?: string[]
  /** Record ids that could not be verified (e.g. unreadable / unresolved). */
  unableToVerifyEvidenceIds?: string[]
}

export const DOCUMENTATION_COMPLETENESS_LABEL =
  'Documentation-completeness indicator only — NOT a legal-compliance score or determination.'

export interface EvidenceCompletenessResult {
  assessments: EvidenceRequirementAssessment[]
  /** 0..100. Share of APPLICABLE requirements that are fully present. A
   *  documentation indicator only — never a legal-compliance measure. */
  documentationCompletenessPercent: number
  documentationCompletenessLabel: string
  requiresHumanReview: true
  /** Literal false, so no consumer can read this as a legal determination. */
  isLegalComplianceDetermination: false
}

function toEpoch(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const epoch = Date.parse(value)
  return Number.isNaN(epoch) ? null : epoch
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Present-but-underpopulated check, per evidence type. */
function isIncompleteRecord(record: EvidenceRecord, asOf: number | null): boolean {
  switch (record.evidenceType) {
    case 'coa':
      return !nonEmpty(record.batchIdentifier) || record.hasApprovedSpecification !== true
    case 'licence':
    case 'certificate':
      // Missing an expiry we cannot even evaluate validity — treat as incomplete
      // unless expiry is present (expiry-in-past is handled as 'expired').
      return !nonEmpty(record.expiryDate) && asOf !== null
    default:
      return false
  }
}

function isExpired(record: EvidenceRecord, asOf: number | null): boolean {
  if (asOf === null) return false
  if (record.evidenceType !== 'licence' && record.evidenceType !== 'certificate') return false
  const expiry = toEpoch(record.expiryDate)
  return expiry !== null && expiry < asOf
}

function assessRequirement(
  requirement: EvidenceRequirementDefinition,
  input: EvidenceCompletenessInput,
  conflictedIds: Set<string>,
): EvidenceRequirementAssessment {
  const base = { key: requirement.key, label: requirement.label, requiresHumanReview: true as const }

  if (requirement.applicable === false) {
    return { ...base, status: 'not_applicable', detail: `${requirement.label} is marked not applicable to this assessment.`, evidenceReferences: [] }
  }

  const matching = input.records.filter(r => r.evidenceType === requirement.satisfiedBy)
  if (matching.length === 0) {
    return { ...base, status: 'missing', detail: `No ${requirement.label.toLowerCase()} evidence is present. A reviewer should obtain it.`, evidenceReferences: [] }
  }

  const ids = matching.map(r => r.id)
  const asOf = toEpoch(input.asOfDate)
  const pending = new Set(input.pendingReviewEvidenceIds ?? [])
  const unable = new Set(input.unableToVerifyEvidenceIds ?? [])

  // Precedence (strongest signal first): conflicting → expired → unable →
  // pending → incomplete → present.
  if (matching.some(r => conflictedIds.has(r.id))) {
    return { ...base, status: 'conflicting', detail: `${requirement.label} evidence is the subject of a deterministic conflict finding. A reviewer should resolve it.`, evidenceReferences: ids }
  }
  if (matching.some(r => isExpired(r, asOf))) {
    return { ...base, status: 'expired', detail: `${requirement.label} evidence has expired relative to ${input.asOfDate}. A reviewer should confirm current validity.`, evidenceReferences: ids }
  }
  if (matching.some(r => unable.has(r.id))) {
    return { ...base, status: 'unable_to_verify', detail: `${requirement.label} evidence could not be verified. Unable to verify — a reviewer should confirm.`, evidenceReferences: ids }
  }
  if (matching.some(r => pending.has(r.id))) {
    return { ...base, status: 'pending_review', detail: `${requirement.label} evidence is present but pending human review.`, evidenceReferences: ids }
  }
  if (matching.some(r => isIncompleteRecord(r, asOf))) {
    return { ...base, status: 'incomplete', detail: `${requirement.label} evidence appears incomplete (missing a required field). A reviewer should complete it.`, evidenceReferences: ids }
  }
  return { ...base, status: 'present', detail: `${requirement.label} evidence is present. No determination has been made; human review still required.`, evidenceReferences: ids }
}

/**
 * Deterministic per-requirement completeness assessment. Returns an explicit
 * status and explanation for EACH requirement plus a clearly-labelled,
 * non-legal documentation-completeness percentage. Never a legal-compliance
 * determination; every requirement still requires human review.
 */
export function assessEvidenceCompleteness(input: EvidenceCompletenessInput): EvidenceCompletenessResult {
  const conflictedIds = new Set<string>()
  for (const finding of input.conflicts ?? []) {
    for (const id of finding.entityReferences) conflictedIds.add(id)
  }

  const assessments = input.requirements.map(req => assessRequirement(req, input, conflictedIds))

  const applicable = assessments.filter(a => a.status !== 'not_applicable')
  const present = applicable.filter(a => a.status === 'present')
  const documentationCompletenessPercent = applicable.length === 0
    ? 0
    : Math.round((present.length / applicable.length) * 100)

  return {
    assessments,
    documentationCompletenessPercent,
    documentationCompletenessLabel: DOCUMENTATION_COMPLETENESS_LABEL,
    requiresHumanReview: true,
    isLegalComplianceDetermination: false,
  }
}
