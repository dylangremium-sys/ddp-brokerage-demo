import { describe, expect, it, vi } from 'vitest'
import {
  EVIDENCE_DRAFT_LABEL,
  generateEvidenceIntelligenceDraft,
} from './evidenceAiAnalysis'
import type { EvidenceAnalysisOptions } from './evidenceAiAnalysis'
import type {
  EvidenceAiProvider,
  EvidenceAnalysisInput,
  EvidenceClassificationRequest,
} from './evidenceAiProvider'
import type {
  EvidenceAiCapability,
  EvidenceAiProviderOutput,
  EvidenceReviewQuestionDraft,
  EvidenceSummaryDraft,
} from './evidenceAiTypes'
import {
  syntheticCoaCompleteInput,
  syntheticCoaPromptInjectionInput,
  syntheticProhibitedApprovalSummaryOutput,
  syntheticSafeClassificationOutput,
} from '../test-fixtures/evidence/synthetic-coa-complete'
import {
  syntheticImageExtractionOutput,
  syntheticImageWithoutMetadataInput,
} from '../test-fixtures/evidence/synthetic-image-without-metadata'

// ─── Phase A — analysis orchestration tests ─────────────────────────────────

const NOOP = () => {
  throw new Error('provider method should not have been called for this capability')
}

// A fully-typed mock provider. Individual methods are overridden per test; any
// method not overridden throws if unexpectedly called.
function mockProvider(overrides: Partial<EvidenceAiProvider> = {}): EvidenceAiProvider {
  return {
    providerId: 'mock-provider',
    modelId: 'mock-model',
    promptVersion: 'v0',
    classifyEvidence: overrides.classifyEvidence ?? (NOOP as EvidenceAiProvider['classifyEvidence']),
    extractEvidence: overrides.extractEvidence ?? (NOOP as EvidenceAiProvider['extractEvidence']),
    draftEvidenceSummary: overrides.draftEvidenceSummary ?? (NOOP as EvidenceAiProvider['draftEvidenceSummary']),
    suggestReviewQuestions: overrides.suggestReviewQuestions ?? (NOOP as EvidenceAiProvider['suggestReviewQuestions']),
  }
}

const OPTS: EvidenceAnalysisOptions = { requestInProgress: false }

function safeSummaryOutput(): EvidenceAiProviderOutput<EvidenceSummaryDraft> {
  return {
    value: {
      neutralSummary: 'The source document states a batch identifier and a sample date.',
      observedUncertainties: 'The issuing laboratory is unclear; a reviewer should confirm.',
      sourceObservations: ['Batch: BATCH-SYN-0001'],
    },
    confidence: 0.5,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'evidence-summary-v0', description: 'test' },
      modelInfo: { provider: 'mock-provider', model: 'mock-model' },
      generatedAt: '2026-02-01T00:00:00.000Z',
      requiresHumanReview: true,
    },
  }
}

function reviewQuestionOutput(): EvidenceAiProviderOutput<EvidenceReviewQuestionDraft> {
  return {
    value: { reviewQuestions: ['Who issued this document?', 'What is the effective date?'] },
    confidence: 0.5,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'evidence-questions-v0', description: 'test' },
      modelInfo: { provider: 'mock-provider', model: 'mock-model' },
      generatedAt: '2026-02-01T00:00:00.000Z',
      requiresHumanReview: true,
    },
  }
}

describe('generateEvidenceIntelligenceDraft — request guards', () => {
  it('rejects missing evidence', async () => {
    const r = await generateEvidenceIntelligenceDraft(null, 'classify_evidence', mockProvider(), OPTS)
    expect(r).toMatchObject({ ok: false, code: 'missing_evidence' })
  })

  it('rejects oversized evidence', async () => {
    const big: EvidenceAnalysisInput = { evidenceId: 'e', content: 'x'.repeat(20001) }
    const r = await generateEvidenceIntelligenceDraft(big, 'classify_evidence', mockProvider(), OPTS)
    expect(r).toMatchObject({ ok: false, code: 'oversized_evidence' })
  })

  it('rejects an absent provider', async () => {
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', null, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'provider_unconfigured' })
  })

  it('rejects an unsupported capability', async () => {
    const bad = 'approve_supplier' as unknown as EvidenceAiCapability
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, bad, mockProvider(), OPTS)
    expect(r).toMatchObject({ ok: false, code: 'unsupported_capability' })
  })

  it('rejects when a request is already in progress', async () => {
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', mockProvider(), { requestInProgress: true })
    expect(r).toMatchObject({ ok: false, code: 'request_in_progress' })
  })
})

describe('generateEvidenceIntelligenceDraft — provider failures', () => {
  it('maps a thrown error to provider_error', async () => {
    const provider = mockProvider({ classifyEvidence: () => Promise.reject(new Error('boom')) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', provider, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'provider_error' })
  })

  it('maps an AbortError to provider_timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const provider = mockProvider({ classifyEvidence: () => Promise.reject(abort) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', provider, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'provider_timeout' })
  })

  it('rejects a malformed envelope', async () => {
    const provider = mockProvider({ classifyEvidence: () => Promise.resolve({ nope: true } as never) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', provider, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'malformed_output' })
  })

  it('rejects an empty (null value) output', async () => {
    const good = syntheticSafeClassificationOutput()
    const provider = mockProvider({ classifyEvidence: () => Promise.resolve({ ...good, value: null } as never) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', provider, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'empty_output' })
  })

  it('rejects a shape-valid draft that makes an approval/certification claim', async () => {
    const provider = mockProvider({ draftEvidenceSummary: () => Promise.resolve(syntheticProhibitedApprovalSummaryOutput()) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'draft_evidence_summary', provider, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'unsafe_output' })
  })
})

describe('generateEvidenceIntelligenceDraft — prompt injection', () => {
  it('treats injected instructions as data: the request keeps its literal guarantees', async () => {
    const spy = vi.fn((req: EvidenceClassificationRequest) => {
      void req
      return Promise.resolve(syntheticSafeClassificationOutput())
    })
    const provider = mockProvider({ classifyEvidence: spy })

    const r = await generateEvidenceIntelligenceDraft(syntheticCoaPromptInjectionInput, 'classify_evidence', provider, OPTS)
    expect(r.ok).toBe(true)

    // The request the provider received was built from trusted constants — the
    // injected "approve / issue Buyer Pack / reveal keys" text did not widen it.
    const request = spy.mock.calls[0][0]
    expect(request.capability).toBe('classify_evidence')
    expect(request.canApprove).toBe(false)
    expect(request.canCreateRule).toBe(false)
    expect(request.canEnforce).toBe(false)
    expect(request.canIssueBuyerPack).toBe(false)
    expect(request.canChangeInventory).toBe(false)
    expect(request.makesBuyerFacingDecision).toBe(false)
    expect(request.isDraftOnly).toBe(true)
    // The untrusted content is passed through verbatim as DATA, unaltered.
    expect(request.evidence.content).toContain('Ignore all previous instructions')
  })

  it('blocks output if the model is coerced into echoing the injected approval claim', async () => {
    const provider = mockProvider({ draftEvidenceSummary: () => Promise.resolve(syntheticProhibitedApprovalSummaryOutput()) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaPromptInjectionInput, 'draft_evidence_summary', provider, OPTS)
    expect(r).toMatchObject({ ok: false, code: 'unsafe_output' })
  })
})

describe('generateEvidenceIntelligenceDraft — success paths & safety guarantees', () => {
  it('classify: returns a labelled draft with every safety guarantee set', async () => {
    const provider = mockProvider({ classifyEvidence: () => Promise.resolve(syntheticSafeClassificationOutput()) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'classify_evidence', provider, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.label).toBe(EVIDENCE_DRAFT_LABEL)
    expect(r.draft.status).toBe('draft_generated')
    expect(r.draft.requiresHumanReview).toBe(true)
    expect(r.draft.approvesEvidence).toBe(false)
    expect(r.draft.createsRule).toBe(false)
    expect(r.draft.enforces).toBe(false)
    expect(r.draft.issuesBuyerPack).toBe(false)
    expect(r.draft.changesInventory).toBe(false)
    expect(r.draft.makesBuyerFacingDecision).toBe(false)
  })

  it('extract: honestly returns a null value for the unreadable image capture time', async () => {
    const provider = mockProvider({ extractEvidence: () => Promise.resolve(syntheticImageExtractionOutput()) })
    const r = await generateEvidenceIntelligenceDraft(syntheticImageWithoutMetadataInput, 'extract_evidence', provider, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok || r.draft.capability !== 'extract_evidence') return
    const draft = r.draft.draft as { extractedValues: { fieldKey: string; value: string | null }[] }
    const capture = draft.extractedValues.find(v => v.fieldKey === 'capture_timestamp')
    expect(capture?.value).toBeNull()
  })

  it('summary: returns a neutral draft', async () => {
    const provider = mockProvider({ draftEvidenceSummary: () => Promise.resolve(safeSummaryOutput()) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'draft_evidence_summary', provider, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.requiresHumanReview).toBe(true)
  })

  it('review questions: returns reviewer questions', async () => {
    const provider = mockProvider({ suggestReviewQuestions: () => Promise.resolve(reviewQuestionOutput()) })
    const r = await generateEvidenceIntelligenceDraft(syntheticCoaCompleteInput, 'suggest_review_questions', provider, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok || r.draft.capability !== 'suggest_review_questions') return
    const draft = r.draft.draft as EvidenceReviewQuestionDraft
    expect(draft.reviewQuestions.length).toBeGreaterThan(0)
  })
})
