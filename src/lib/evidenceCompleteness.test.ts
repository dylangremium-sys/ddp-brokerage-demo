import { describe, expect, it } from 'vitest'
import {
  DOCUMENTATION_COMPLETENESS_LABEL,
  assessEvidenceCompleteness,
} from './evidenceCompleteness'
import type {
  EvidenceCompletenessInput,
  EvidenceRequirementDefinition,
} from './evidenceCompleteness'
import type { EvidenceFinding, EvidenceRecord } from './evidenceConflictDetection'
import { syntheticCoaCompleteRecord } from '../test-fixtures/evidence/synthetic-coa-complete'
import { syntheticCoaNoSpecificationRecord } from '../test-fixtures/evidence/synthetic-coa-no-specification'
import {
  EVIDENCE_ASOF_DATE,
  syntheticExpiredCertificateRecord,
} from '../test-fixtures/evidence/synthetic-expired-certificate'
import {
  syntheticBatchRequirements,
  syntheticMissingTraceabilityRecords,
} from '../test-fixtures/evidence/synthetic-missing-traceability'

// ─── Phase A — deterministic completeness tests ─────────────────────────────

const COA_REQ: EvidenceRequirementDefinition = { key: 'req-coa', label: 'Certificate of Analysis', satisfiedBy: 'coa' }
const CERT_REQ: EvidenceRequirementDefinition = { key: 'req-cert', label: 'Certificate', satisfiedBy: 'certificate' }

function statusFor(input: EvidenceCompletenessInput, key: string): string {
  return assessEvidenceCompleteness(input).assessments.find(a => a.key === key)!.status
}

describe('assessEvidenceCompleteness — per-requirement status', () => {
  it('reports a satisfied requirement as present', () => {
    expect(statusFor({ requirements: [COA_REQ], records: [syntheticCoaCompleteRecord] }, 'req-coa')).toBe('present')
  })

  it('reports an absent requirement as missing', () => {
    expect(statusFor({ requirements: [COA_REQ], records: [] }, 'req-coa')).toBe('missing')
  })

  it('reports a present-but-underpopulated requirement as incomplete', () => {
    // CoA with no approved specification attached.
    expect(statusFor({ requirements: [COA_REQ], records: [syntheticCoaNoSpecificationRecord] }, 'req-coa')).toBe('incomplete')
  })

  it('reports a requirement whose record has a conflict finding as conflicting', () => {
    const conflict: EvidenceFinding = {
      code: 'duplicate_checksum',
      severity: 'medium',
      title: 'x',
      detail: 'x',
      entityReferences: [syntheticCoaCompleteRecord.id],
      requiresHumanReview: true,
    }
    expect(statusFor({ requirements: [COA_REQ], records: [syntheticCoaCompleteRecord], conflicts: [conflict] }, 'req-coa')).toBe('conflicting')
  })

  it('reports an expired certificate as expired', () => {
    expect(statusFor({ requirements: [CERT_REQ], records: [syntheticExpiredCertificateRecord], asOfDate: EVIDENCE_ASOF_DATE }, 'req-cert')).toBe('expired')
  })

  it('reports an explicitly not-applicable requirement as not_applicable', () => {
    const req: EvidenceRequirementDefinition = { key: 'req-transport', label: 'Transport Record', satisfiedBy: 'transport_record', applicable: false }
    expect(statusFor({ requirements: [req], records: [] }, 'req-transport')).toBe('not_applicable')
  })

  it('reports a record flagged pending as pending_review', () => {
    expect(statusFor({ requirements: [COA_REQ], records: [syntheticCoaCompleteRecord], pendingReviewEvidenceIds: [syntheticCoaCompleteRecord.id] }, 'req-coa')).toBe('pending_review')
  })

  it('reports a record flagged unverifiable as unable_to_verify', () => {
    expect(statusFor({ requirements: [COA_REQ], records: [syntheticCoaCompleteRecord], unableToVerifyEvidenceIds: [syntheticCoaCompleteRecord.id] }, 'req-coa')).toBe('unable_to_verify')
  })
})

describe('assessEvidenceCompleteness — documentation percentage & labelling', () => {
  it('computes the percentage over applicable requirements only', () => {
    // 2 present (CoA, licence) of 3 applicable (traceability missing); transport n/a.
    const result = assessEvidenceCompleteness({
      requirements: syntheticBatchRequirements,
      records: syntheticMissingTraceabilityRecords,
      asOfDate: EVIDENCE_ASOF_DATE,
    })
    expect(result.documentationCompletenessPercent).toBe(67)
    expect(result.assessments.find(a => a.key === 'req-traceability')!.status).toBe('missing')
    expect(result.assessments.find(a => a.key === 'req-transport')!.status).toBe('not_applicable')
  })

  it('is 0% when there are no applicable requirements (never crashes)', () => {
    const req: EvidenceRequirementDefinition = { key: 'r', label: 'X', satisfiedBy: 'coa', applicable: false }
    expect(assessEvidenceCompleteness({ requirements: [req], records: [] }).documentationCompletenessPercent).toBe(0)
  })

  it('carries the explicit non-legal label and determination flag', () => {
    const result = assessEvidenceCompleteness({ requirements: [COA_REQ], records: [syntheticCoaCompleteRecord] })
    expect(result.documentationCompletenessLabel).toBe(DOCUMENTATION_COMPLETENESS_LABEL)
    expect(result.documentationCompletenessLabel).toContain('NOT a legal-compliance')
    expect(result.isLegalComplianceDetermination).toBe(false)
    expect(result.requiresHumanReview).toBe(true)
  })

  it('every requirement assessment requires human review', () => {
    const result = assessEvidenceCompleteness({ requirements: syntheticBatchRequirements, records: syntheticMissingTraceabilityRecords, asOfDate: EVIDENCE_ASOF_DATE })
    for (const a of result.assessments) expect(a.requiresHumanReview).toBe(true)
  })
})

// Guards against a stray unused import if fixtures change.
const _typecheck: EvidenceRecord[] = [syntheticCoaCompleteRecord]
void _typecheck
