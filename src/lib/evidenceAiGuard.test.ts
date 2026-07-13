import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_EVIDENCE_CHARS,
  EVIDENCE_UNSAFE_TERMS,
  assessEvidenceRequestEligibility,
  collectDraftProse,
  guardEvidenceWording,
  guardEvidenceWordingFields,
  isSupportedEvidenceCapability,
  isValidConfidence,
  validateClassificationDraft,
  validateExtractedValue,
  validateExtractionDraft,
  validateProviderEnvelope,
  validateReviewQuestionDraft,
  validateSummaryDraft,
} from './evidenceAiGuard'
import type { EvidenceAnalysisInput } from './evidenceAiProvider'
import { syntheticSafeClassificationOutput } from '../test-fixtures/evidence/synthetic-coa-complete'

// ─── Phase A — request & output guard tests ─────────────────────────────────

function evidence(overrides: Partial<EvidenceAnalysisInput> = {}): EvidenceAnalysisInput {
  return { evidenceId: 'ev-1', content: 'Some synthetic evidence content.', ...overrides }
}

describe('guardEvidenceWording', () => {
  it('accepts safe, qualified reviewer language', () => {
    const safePhrases = [
      'This requires human review before any decision.',
      'No determination has been made.',
      'Unable to verify the issuer.',
      'The evidence appears incomplete.',
      'The source document states a harvest date of 2026-01-05.',
      'A reviewer should confirm the batch identifier.',
      'No approved rule has been applied to this evidence.',
      'This document is not certified and not compliant.',
    ]
    for (const phrase of safePhrases) {
      expect(guardEvidenceWording(phrase).isSafe, phrase).toBe(true)
    }
  })

  it('rejects unqualified approval / certification / authentication claims', () => {
    const unsafePhrases = [
      'This batch is compliant.',
      'The supplier is legally compliant.',
      'The certificate is certified and verified.',
      'The batch is approved and export-ready.',
      'This is EU approved.',
      'This is an authentic document.',
      'This is a genuine certificate.',
      'The product is safe for sale.',
      'It passes all requirements.',
      'It meets all regulations.',
      'This is pharmaceutical grade.',
      'The batch is fit for export.',
      'Results are guaranteed.',
    ]
    for (const phrase of unsafePhrases) {
      expect(guardEvidenceWording(phrase).isSafe, phrase).toBe(false)
    }
  })

  it('excludes a claim negated within the preceding window', () => {
    expect(guardEvidenceWording('The batch is not compliant.').isSafe).toBe(true)
    expect(guardEvidenceWording('Unable to verify whether this is authentic.').isSafe).toBe(true)
    expect(guardEvidenceWording('No approved specification is attached.').isSafe).toBe(true)
  })

  it('records a longer phrase once, not again as a shorter substring', () => {
    const result = guardEvidenceWording('The supplier is legally compliant.')
    const terms = result.findings.map(f => f.term)
    expect(terms).toContain('legally compliant')
    expect(terms).not.toContain('compliant')
  })

  it('exposes its term list for documentation/tests', () => {
    expect(EVIDENCE_UNSAFE_TERMS).toContain('export-ready')
    expect(EVIDENCE_UNSAFE_TERMS).toContain('pharmaceutical grade')
  })
})

describe('guardEvidenceWordingFields', () => {
  it('checks each field independently and tags findings by field', () => {
    const result = guardEvidenceWordingFields({
      neutralSummary: 'The source document states a change.',
      observedUncertainties: 'The batch is compliant.',
    })
    expect(result.isSafe).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].field).toBe('observedUncertainties')
  })

  it('a trailing negation in one field cannot mask an unsafe claim in another', () => {
    const result = guardEvidenceWordingFields({
      a: 'This is certified.',
      b: 'This is not certified.',
    })
    expect(result.isSafe).toBe(false)
    expect(result.findings.map(f => f.field)).toEqual(['a'])
  })

  it('skips empty / whitespace-only fields', () => {
    expect(guardEvidenceWordingFields({ a: '', b: '   ' }).isSafe).toBe(true)
  })
})

describe('assessEvidenceRequestEligibility', () => {
  const ok = { providerAvailable: true, requestInProgress: false }

  it('allows a well-formed request', () => {
    expect(assessEvidenceRequestEligibility(evidence(), 'classify_evidence', ok).action).toBe('allow')
  })

  it('rejects when a request is already in progress (checked first)', () => {
    const d = assessEvidenceRequestEligibility(evidence(), 'classify_evidence', { providerAvailable: false, requestInProgress: true })
    expect(d).toMatchObject({ action: 'reject', code: 'request_in_progress' })
  })

  it('rejects when no provider is configured', () => {
    const d = assessEvidenceRequestEligibility(evidence(), 'classify_evidence', { providerAvailable: false, requestInProgress: false })
    expect(d).toMatchObject({ action: 'reject', code: 'provider_unconfigured' })
  })

  it('rejects an unsupported capability', () => {
    const d = assessEvidenceRequestEligibility(evidence(), 'approve_supplier', ok)
    expect(d).toMatchObject({ action: 'reject', code: 'unsupported_capability' })
  })

  it('rejects missing evidence (null and empty content)', () => {
    expect(assessEvidenceRequestEligibility(null, 'classify_evidence', ok)).toMatchObject({ code: 'missing_evidence' })
    expect(assessEvidenceRequestEligibility(evidence({ content: '   ' }), 'classify_evidence', ok)).toMatchObject({ code: 'missing_evidence' })
  })

  it('rejects oversized evidence', () => {
    const big = evidence({ content: 'x'.repeat(DEFAULT_MAX_EVIDENCE_CHARS + 1) })
    expect(assessEvidenceRequestEligibility(big, 'classify_evidence', ok)).toMatchObject({ code: 'oversized_evidence' })
  })

  it('isSupportedEvidenceCapability guards the four capabilities', () => {
    expect(isSupportedEvidenceCapability('extract_evidence')).toBe(true)
    expect(isSupportedEvidenceCapability('release_inventory')).toBe(false)
  })
})

describe('isValidConfidence', () => {
  it('accepts finite 0..1 and rejects everything else', () => {
    expect(isValidConfidence(0)).toBe(true)
    expect(isValidConfidence(1)).toBe(true)
    expect(isValidConfidence(0.5)).toBe(true)
    expect(isValidConfidence(-0.1)).toBe(false)
    expect(isValidConfidence(1.1)).toBe(false)
    expect(isValidConfidence(Number.NaN)).toBe(false)
    expect(isValidConfidence(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidConfidence('0.5')).toBe(false)
  })
})

describe('validateProviderEnvelope', () => {
  const good = syntheticSafeClassificationOutput()

  it('accepts a well-formed envelope', () => {
    expect(validateProviderEnvelope(good).ok).toBe(true)
  })

  it('rejects a non-object / unknown-field envelope as malformed', () => {
    expect(validateProviderEnvelope(42)).toMatchObject({ ok: false, code: 'malformed_output' })
    expect(validateProviderEnvelope({ ...good, surprise: true })).toMatchObject({ ok: false, code: 'malformed_output' })
  })

  it('rejects a null/absent value as empty', () => {
    expect(validateProviderEnvelope({ ...good, value: null })).toMatchObject({ ok: false, code: 'empty_output' })
  })

  it('rejects an invalid confidence', () => {
    expect(validateProviderEnvelope({ ...good, confidence: 2 })).toMatchObject({ ok: false, code: 'invalid_confidence' })
    expect(validateProviderEnvelope({ ...good, confidence: 'high' })).toMatchObject({ ok: false, code: 'invalid_confidence' })
  })

  it('rejects missing / malformed provenance', () => {
    expect(validateProviderEnvelope({ ...good, provenance: { actorType: 'human' } })).toMatchObject({ ok: false, code: 'missing_provenance' })
    const noReview = { ...good, provenance: { ...good.provenance, requiresHumanReview: false } }
    expect(validateProviderEnvelope(noReview)).toMatchObject({ ok: false, code: 'missing_provenance' })
  })
})

describe('validateExtractedValue', () => {
  const base = { fieldKey: 'batch_identifier', value: 'BATCH-SYN-0001', confidence: 0.6, sourceReferences: [{ section: 'header' }] }

  it('accepts a well-formed extracted value', () => {
    expect(validateExtractedValue(base).ok).toBe(true)
  })

  it('accepts a null value with no source reference', () => {
    expect(validateExtractedValue({ ...base, value: null, sourceReferences: [] }).ok).toBe(true)
  })

  it('rejects a non-null value that carries no provenance reference', () => {
    expect(validateExtractedValue({ ...base, sourceReferences: [] })).toMatchObject({ ok: false, code: 'missing_provenance_reference' })
  })

  it('rejects an invalid confidence and a non-string value', () => {
    expect(validateExtractedValue({ ...base, confidence: 5 })).toMatchObject({ ok: false, code: 'invalid_confidence' })
    expect(validateExtractedValue({ ...base, value: 123 })).toMatchObject({ ok: false, code: 'malformed_output' })
  })

  it('rejects malformed source references (unknown key / wrong type)', () => {
    expect(validateExtractedValue({ ...base, sourceReferences: [{ page: 'one' }] })).toMatchObject({ ok: false, code: 'malformed_output' })
    expect(validateExtractedValue({ ...base, sourceReferences: [{ bogus: 1 }] })).toMatchObject({ ok: false, code: 'malformed_output' })
  })
})

describe('capability draft validators', () => {
  it('classification: rejects unknown fields and unsupported enum values', () => {
    const good = { proposedType: 'coa', proposedOwnerType: 'laboratory', uncertaintyNote: '', alternativeTypes: [] }
    expect(validateClassificationDraft(good).ok).toBe(true)
    expect(validateClassificationDraft({ ...good, extra: 1 })).toMatchObject({ ok: false, code: 'malformed_output' })
    expect(validateClassificationDraft({ ...good, proposedType: 'banana' })).toMatchObject({ ok: false, code: 'unsupported_type' })
    expect(validateClassificationDraft({ ...good, alternativeTypes: ['banana'] })).toMatchObject({ ok: false, code: 'unsupported_type' })
  })

  it('extraction: validates nested extracted values and relationships', () => {
    const good = {
      extractedValues: [{ fieldKey: 'k', value: 'v', confidence: 0.5, sourceReferences: [{ section: 's' }] }],
      possibleRelationships: [{ relatesToEvidenceId: 'ev-2', natureOfRelationship: 'maybe related' }],
    }
    expect(validateExtractionDraft(good).ok).toBe(true)
    expect(validateExtractionDraft({ ...good, extra: 1 })).toMatchObject({ ok: false, code: 'malformed_output' })
    const badNested = { ...good, extractedValues: [{ fieldKey: 'k', value: 'v', confidence: 0.5, sourceReferences: [] }] }
    expect(validateExtractionDraft(badNested)).toMatchObject({ ok: false, code: 'missing_provenance_reference' })
  })

  it('summary: rejects an empty neutral summary and unknown fields', () => {
    const good = { neutralSummary: 'A neutral description.', observedUncertainties: '', sourceObservations: [] }
    expect(validateSummaryDraft(good).ok).toBe(true)
    expect(validateSummaryDraft({ ...good, neutralSummary: '   ' })).toMatchObject({ ok: false, code: 'empty_output' })
    expect(validateSummaryDraft({ ...good, extra: 1 })).toMatchObject({ ok: false, code: 'malformed_output' })
  })

  it('review questions: rejects an empty question set', () => {
    expect(validateReviewQuestionDraft({ reviewQuestions: ['What is the issuer?'] }).ok).toBe(true)
    expect(validateReviewQuestionDraft({ reviewQuestions: [] })).toMatchObject({ ok: false, code: 'empty_output' })
    expect(validateReviewQuestionDraft({ reviewQuestions: ['  '] })).toMatchObject({ ok: false, code: 'empty_output' })
  })
})

describe('collectDraftProse', () => {
  it('returns only AI-authored prose, never machine enum values', () => {
    const prose = collectDraftProse('classify_evidence', {
      proposedType: 'coa',
      proposedOwnerType: 'laboratory',
      uncertaintyNote: 'A neutral note.',
      alternativeTypes: ['sampling_record'],
    })
    expect(Object.keys(prose)).toEqual(['uncertaintyNote'])
  })
})
