import { describe, expect, it } from 'vitest'
import {
  detectDateChronologyErrors,
  detectDuplicateChecksums,
  detectEntityOwnershipMismatch,
  detectEvidenceConflicts,
  detectExpiredEvidence,
  detectInconsistentReportValues,
  detectLabResultWithoutApprovedSpecification,
  detectMissingCoaBatchLink,
  detectSharedBatchAcrossCultivars,
  detectTranslationWithoutOriginal,
} from './evidenceConflictDetection'
import type { EvidenceRecord } from './evidenceConflictDetection'
import {
  syntheticSameBatchSameCultivarRecords,
  syntheticSharedBatchRecords,
} from '../test-fixtures/evidence/synthetic-shared-batch-identifiers'
import { syntheticThirdPartyLicenceRecord } from '../test-fixtures/evidence/synthetic-third-party-licence'
import {
  EVIDENCE_ASOF_DATE,
  syntheticExpiredCertificateRecord,
  syntheticValidCertificateRecord,
} from '../test-fixtures/evidence/synthetic-expired-certificate'
import {
  syntheticTranslationWithOriginalRecords,
  syntheticTranslationWithoutOriginalRecord,
} from '../test-fixtures/evidence/synthetic-translation-conflict'
import { syntheticCoaNoSpecificationRecord } from '../test-fixtures/evidence/synthetic-coa-no-specification'
import { syntheticCoaCompleteRecord } from '../test-fixtures/evidence/synthetic-coa-complete'

// ─── Phase A — deterministic conflict detection tests ───────────────────────
//
// Every finding must carry requiresHumanReview: true and must never be a
// pass/fail or compliance decision.

function record(overrides: Partial<EvidenceRecord>): EvidenceRecord {
  return { id: 'ev-x', evidenceType: 'other', ...overrides }
}

describe('detectSharedBatchAcrossCultivars', () => {
  it('flags one batch identifier linked to multiple cultivars', () => {
    const findings = detectSharedBatchAcrossCultivars(syntheticSharedBatchRecords)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('shared_batch_multiple_cultivars')
    expect(findings[0].entityReferences).toEqual(['ev-batch-share-a', 'ev-batch-share-b'])
    expect(findings[0].requiresHumanReview).toBe(true)
  })

  it('does NOT flag the same batch with the same cultivar', () => {
    expect(detectSharedBatchAcrossCultivars(syntheticSameBatchSameCultivarRecords)).toHaveLength(0)
  })
})

describe('detectEntityOwnershipMismatch', () => {
  it('flags a third-party licence whose claimed holder differs from the linked entity', () => {
    const findings = detectEntityOwnershipMismatch([syntheticThirdPartyLicenceRecord])
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('entity_ownership_mismatch')
  })

  it('does not flag matching claimed/linked entities', () => {
    expect(detectEntityOwnershipMismatch([syntheticCoaCompleteRecord])).toHaveLength(0)
  })
})

describe('detectExpiredEvidence', () => {
  it('flags a certificate expired before the relevant date', () => {
    const findings = detectExpiredEvidence([syntheticExpiredCertificateRecord], { asOfDate: EVIDENCE_ASOF_DATE })
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('expired_evidence')
  })

  it('does not flag a still-valid certificate', () => {
    expect(detectExpiredEvidence([syntheticValidCertificateRecord], { asOfDate: EVIDENCE_ASOF_DATE })).toHaveLength(0)
  })

  it('skips expiry evaluation entirely when no asOfDate is supplied (deterministic)', () => {
    expect(detectExpiredEvidence([syntheticExpiredCertificateRecord], {})).toHaveLength(0)
  })
})

describe('detectDateChronologyErrors', () => {
  it('flags a sample date before the harvest date', () => {
    const findings = detectDateChronologyErrors([record({ harvestDate: '2026-01-10', sampleDate: '2026-01-05' })])
    expect(findings.map(f => f.code)).toContain('sample_before_harvest')
  })

  it('flags a report date before the sample date', () => {
    const findings = detectDateChronologyErrors([record({ sampleDate: '2026-01-10', reportDate: '2026-01-05' })])
    expect(findings.map(f => f.code)).toContain('report_before_sample')
  })

  it('does not flag correctly ordered dates', () => {
    expect(detectDateChronologyErrors([syntheticCoaCompleteRecord])).toHaveLength(0)
  })
})

describe('detectMissingCoaBatchLink', () => {
  it('flags a CoA with no batch identifier', () => {
    const findings = detectMissingCoaBatchLink([record({ id: 'c', evidenceType: 'coa', batchIdentifier: null })])
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('missing_coa_batch_link')
  })

  it('does not flag a CoA that is linked to a batch', () => {
    expect(detectMissingCoaBatchLink([syntheticCoaCompleteRecord])).toHaveLength(0)
  })
})

describe('detectTranslationWithoutOriginal', () => {
  it('flags a translation with no source-language original present', () => {
    const findings = detectTranslationWithoutOriginal([syntheticTranslationWithoutOriginalRecord])
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('translation_without_original')
  })

  it('does not flag a translation whose original is present', () => {
    expect(detectTranslationWithoutOriginal(syntheticTranslationWithOriginalRecords)).toHaveLength(0)
  })
})

describe('detectDuplicateChecksums', () => {
  it('flags two records sharing an identical checksum', () => {
    const findings = detectDuplicateChecksums([
      record({ id: 'a', checksum: 'DEAD' }),
      record({ id: 'b', checksum: 'dead' }), // case-insensitive match
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('duplicate_checksum')
    expect(findings[0].entityReferences).toEqual(['a', 'b'])
  })

  it('does not flag distinct checksums', () => {
    const findings = detectDuplicateChecksums([syntheticCoaCompleteRecord, syntheticCoaNoSpecificationRecord])
    expect(findings).toHaveLength(0)
  })
})

describe('detectInconsistentReportValues', () => {
  it('flags the same report number carrying different values', () => {
    const findings = detectInconsistentReportValues([
      record({ id: 'a', reportNumber: 'RPT-1', reportedValue: 'thc:9%' }),
      record({ id: 'b', reportNumber: 'RPT-1', reportedValue: 'thc:12%' }),
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('inconsistent_report_values')
  })

  it('does not flag the same report number with consistent values', () => {
    const findings = detectInconsistentReportValues([
      record({ id: 'a', reportNumber: 'RPT-2', reportedValue: 'thc:9%' }),
      record({ id: 'b', reportNumber: 'RPT-2', reportedValue: 'thc:9%' }),
    ])
    expect(findings).toHaveLength(0)
  })
})

describe('detectLabResultWithoutApprovedSpecification', () => {
  it('flags a CoA with no approved specification attached', () => {
    const findings = detectLabResultWithoutApprovedSpecification([syntheticCoaNoSpecificationRecord])
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('lab_result_without_approved_specification')
  })

  it('does not flag a CoA with an approved specification', () => {
    expect(detectLabResultWithoutApprovedSpecification([syntheticCoaCompleteRecord])).toHaveLength(0)
  })
})

describe('detectEvidenceConflicts (aggregate)', () => {
  it('returns no findings for a clean, consistent record', () => {
    expect(detectEvidenceConflicts([syntheticCoaCompleteRecord], { asOfDate: EVIDENCE_ASOF_DATE })).toHaveLength(0)
  })

  it('aggregates findings across every check and never returns a decision field', () => {
    const findings = detectEvidenceConflicts(
      [
        ...syntheticSharedBatchRecords,
        syntheticThirdPartyLicenceRecord,
        syntheticExpiredCertificateRecord,
        syntheticTranslationWithoutOriginalRecord,
        syntheticCoaNoSpecificationRecord,
      ],
      { asOfDate: EVIDENCE_ASOF_DATE },
    )
    const codes = findings.map(f => f.code)
    expect(codes).toContain('shared_batch_multiple_cultivars')
    expect(codes).toContain('entity_ownership_mismatch')
    expect(codes).toContain('expired_evidence')
    expect(codes).toContain('translation_without_original')
    expect(codes).toContain('lab_result_without_approved_specification')
    // Every finding is a review observation, never a decision.
    for (const f of findings) {
      expect(f.requiresHumanReview).toBe(true)
      expect(f).not.toHaveProperty('decision')
      expect(f).not.toHaveProperty('approved')
    }
  })
})
