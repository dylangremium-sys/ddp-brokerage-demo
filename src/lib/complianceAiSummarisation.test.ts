import { describe, expect, it } from 'vitest'
import type { LegalUpdate, LegalUpdateStatus } from '../types'
import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'
import type { AIComplianceOutput } from './aiComplianceTypes'
import {
  AI_DRAFT_LABEL,
  DEFAULT_MAX_EVIDENCE_CHARS,
  buildAiSummaryRequest,
  generateAiDraftSummary,
  guardAiSummarisationRequest,
} from './complianceAiSummarisation'

// ─── Phase 2G — guarded AI draft summarisation tests ────────────────────────
//
// Covers the three surfaces of complianceAiSummarisation.ts:
//   1. buildAiSummaryRequest  — extracts ONLY permitted evidence + asserts the
//      literal capability guarantees (draft only, cannot approve/rule/enforce).
//   2. guardAiSummarisationRequest — the pure eligibility gate, every reject
//      code plus the allow path.
//   3. generateAiDraftSummary — the orchestration: happy path, guard
//      propagation, provider error/timeout, malformed/empty/unsafe output, and
//      the guarantee that echoed source references are NOT treated as AI claims.

function makeOutput(
  value: AiDraftSummarySections,
  overrides?: { provider?: string; model?: string; generatedAt?: string },
): AIComplianceOutput<AiDraftSummarySections> {
  return {
    value,
    confidence: 0.5,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'test-prompt-v0', description: 'test stub' },
      modelInfo: {
        provider: overrides?.provider ?? 'test-provider',
        model: overrides?.model ?? 'stub-model',
      },
      generatedAt: overrides?.generatedAt ?? new Date().toISOString(),
      requiresHumanReview: true,
    },
  }
}

const SAFE_SECTIONS: AiDraftSummarySections = {
  draftSummary: 'The notice describes a change to permitted cultivation record-keeping.',
  possibleSignificance: 'May affect how farms log harvest batches; a reviewer should confirm.',
  uncertainties: 'The effective date is unclear and should be checked against the source.',
  reviewQuestions: ['Does this apply to existing licences?', 'What is the effective date?'],
  sourceReferences: ['Thai FDA notice', 'https://example.test/notice'],
}

// A provider that can be built inline for each case. Compile-time proof that
// ComplianceAiSummaryProvider is implementable exactly as specified — a type
// error here would fail `tsc -b`, not just this test.
function stubProvider(
  impl: (input: AiSummaryProviderInput) => Promise<AIComplianceOutput<AiDraftSummarySections>>,
): ComplianceAiSummaryProvider {
  return { draftSummary: impl }
}

let updateSeq = 0
function makeUpdate(overrides: Partial<LegalUpdate> = {}): LegalUpdate {
  updateSeq += 1
  return {
    id: `lu-${updateSeq}`,
    sourceId: null,
    title: 'Draft cultivation record-keeping notice',
    jurisdiction: 'Thailand',
    sourceName: 'Thai FDA',
    sourceUrl: 'https://example.test/notice',
    publishedAt: '2026-06-01T00:00:00.000Z',
    detectedAt: '2026-06-02T00:00:00.000Z',
    rawText: 'Full raw source evidence text describing the regulatory change.',
    summary: '',
    affectedAreas: ['Thai cultivation'],
    aiRiskLevel: null,
    status: 'new',
    reviewerNotes: '',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...overrides,
  }
}

const OPEN_GUARD = { providerAvailable: true, requestInProgress: false }

describe('buildAiSummaryRequest — extracts only permitted evidence + capability guarantees', () => {
  it('maps the permitted evidence fields and defaults the checksum to null', () => {
    const update = makeUpdate({ reviewerNotes: 'Some free-form reviewer note without a checksum.' })
    const req = buildAiSummaryRequest(update)

    expect(req.legalUpdateId).toBe(update.id)
    expect(req.sourceName).toBe(update.sourceName)
    expect(req.sourceUrl).toBe(update.sourceUrl)
    expect(req.jurisdiction).toBe(update.jurisdiction)
    expect(req.itemTitle).toBe(update.title)
    expect(req.publishedAt).toBe(update.publishedAt)
    expect(req.rawEvidence).toBe(update.rawText)
    expect(req.provenanceChecksum).toBeNull()
  })

  it('parses a provenance checksum out of the reviewer notes when present', () => {
    const checksum = 'a'.repeat(64)
    const update = makeUpdate({ reviewerNotes: `Ingested via RSS. Checksum: ${checksum}` })
    expect(buildAiSummaryRequest(update).provenanceChecksum).toBe(checksum)
  })

  it('carries the literal capability guarantees — draft only, cannot approve/rule/enforce', () => {
    const req = buildAiSummaryRequest(makeUpdate())
    expect(req.isDraftOnly).toBe(true)
    expect(req.requiresHumanReview).toBe(true)
    expect(req.canApprove).toBe(false)
    expect(req.canCreateRule).toBe(false)
    expect(req.canEnforce).toBe(false)
    expect(req.makesBuyerFacingDecision).toBe(false)
  })

  it('does not leak the reviewer notes body itself into the request payload', () => {
    const update = makeUpdate({ reviewerNotes: 'Internal reviewer secret note.' })
    const req = buildAiSummaryRequest(update)
    expect(JSON.stringify(req)).not.toContain('Internal reviewer secret note.')
  })
})

describe('guardAiSummarisationRequest — pure eligibility gate', () => {
  it('allows a new, evidence-bearing draft with a configured provider', () => {
    const decision = guardAiSummarisationRequest(makeUpdate(), OPEN_GUARD)
    expect(decision.action).toBe('allow')
    if (decision.action === 'allow') {
      expect(decision.request.legalUpdateId).toMatch(/^lu-/)
    }
  })

  it('rejects when a request is already in progress (checked before everything else)', () => {
    // requestInProgress wins even with an otherwise-valid update.
    const decision = guardAiSummarisationRequest(makeUpdate(), { ...OPEN_GUARD, requestInProgress: true })
    expect(decision).toMatchObject({ action: 'reject', code: 'request_in_progress' })
  })

  it('rejects a missing update', () => {
    const decision = guardAiSummarisationRequest(null, OPEN_GUARD)
    expect(decision).toMatchObject({ action: 'reject', code: 'missing_update' })
  })

  it('rejects when no provider is configured', () => {
    const decision = guardAiSummarisationRequest(makeUpdate(), { ...OPEN_GUARD, providerAvailable: false })
    expect(decision).toMatchObject({ action: 'reject', code: 'provider_unconfigured' })
  })

  it('rejects every non-new (already-actioned) status as locked', () => {
    const lockedStatuses: LegalUpdateStatus[] = [
      'needs_review',
      'reviewed',
      'rule_suggested',
      'sent_to_legal',
      'archived',
      'rejected',
    ]
    for (const status of lockedStatuses) {
      const decision = guardAiSummarisationRequest(makeUpdate({ status }), OPEN_GUARD)
      expect(decision, `status ${status} should be locked`).toMatchObject({
        action: 'reject',
        code: 'unsupported_status',
      })
    }
  })

  it('rejects an update with no source evidence', () => {
    const decision = guardAiSummarisationRequest(makeUpdate({ rawText: '   ' }), OPEN_GUARD)
    expect(decision).toMatchObject({ action: 'reject', code: 'missing_evidence' })
  })

  it('rejects evidence larger than the (default) size bound', () => {
    const decision = guardAiSummarisationRequest(
      makeUpdate({ rawText: 'x'.repeat(DEFAULT_MAX_EVIDENCE_CHARS + 1) }),
      OPEN_GUARD,
    )
    expect(decision).toMatchObject({ action: 'reject', code: 'oversized_evidence' })
  })

  it('honours a custom maxEvidenceChars override', () => {
    const update = makeUpdate({ rawText: 'x'.repeat(50) })
    expect(guardAiSummarisationRequest(update, { ...OPEN_GUARD, maxEvidenceChars: 10 })).toMatchObject({
      action: 'reject',
      code: 'oversized_evidence',
    })
    expect(guardAiSummarisationRequest(update, { ...OPEN_GUARD, maxEvidenceChars: 100 }).action).toBe('allow')
  })
})

describe('generateAiDraftSummary — guarded orchestration', () => {
  const RUN = { requestInProgress: false }

  it('returns a labelled, draft-only summary on the happy path', async () => {
    const update = makeUpdate()
    const provider = stubProvider(async () =>
      makeOutput(SAFE_SECTIONS, { provider: 'acme-ai', model: 'acme-1', generatedAt: '2026-07-10T00:00:00.000Z' }),
    )

    const result = await generateAiDraftSummary(update, provider, RUN)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { draft } = result
    expect(draft.legalUpdateId).toBe(update.id)
    expect(draft.providerId).toBe('acme-ai')
    expect(draft.modelId).toBe('acme-1')
    expect(draft.generatedAt).toBe('2026-07-10T00:00:00.000Z')
    expect(draft.draftSummary).toBe(SAFE_SECTIONS.draftSummary)
    expect(draft.reviewQuestions).toEqual(SAFE_SECTIONS.reviewQuestions)
    expect(draft.sourceReferences).toEqual(SAFE_SECTIONS.sourceReferences)

    // Non-negotiable labelling + capability guarantees.
    expect(draft.status).toBe('draft_generated')
    expect(draft.guardDecision).toBe('allowed')
    expect(draft.requiresHumanReview).toBe(true)
    expect(draft.label).toBe(AI_DRAFT_LABEL)
    expect(draft.approvesUpdate).toBe(false)
    expect(draft.createsRule).toBe(false)
    expect(draft.enforces).toBe(false)
    expect(draft.certifiesCompliance).toBe(false)
  })

  it('never calls the provider when the request guard rejects', async () => {
    let called = false
    const provider = stubProvider(async () => {
      called = true
      return makeOutput(SAFE_SECTIONS)
    })
    // status !== 'new' → guard rejects before the provider is touched.
    const result = await generateAiDraftSummary(makeUpdate({ status: 'reviewed' }), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'unsupported_status' })
    expect(called).toBe(false)
  })

  it('reports provider_unconfigured when no provider is injected', async () => {
    const result = await generateAiDraftSummary(makeUpdate(), null, RUN)
    expect(result).toMatchObject({ ok: false, code: 'provider_unconfigured' })
  })

  it('maps a thrown provider error to provider_error', async () => {
    const provider = stubProvider(async () => {
      throw new Error('boom')
    })
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'provider_error' })
  })

  it('maps an AbortError to provider_timeout', async () => {
    const provider = stubProvider(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'provider_timeout' })
  })

  it('rejects a malformed provider output shape', async () => {
    const provider = stubProvider(async () =>
      // reviewQuestions is not a string[] → fails the shape check.
      makeOutput({ ...SAFE_SECTIONS, reviewQuestions: 'not-an-array' as unknown as string[] }),
    )
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'malformed_output' })
  })

  it('rejects an empty draft summary', async () => {
    const provider = stubProvider(async () => makeOutput({ ...SAFE_SECTIONS, draftSummary: '   ' }))
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'empty_output' })
  })

  it('blocks an unqualified compliance claim in the AI-authored prose (wording guard)', async () => {
    const provider = stubProvider(async () =>
      makeOutput({ ...SAFE_SECTIONS, draftSummary: 'This confirms the batch is legally compliant and export-ready.' }),
    )
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'unsafe_output' })
  })

  it('blocks an unqualified claim that appears only in a review question', async () => {
    const provider = stubProvider(async () =>
      makeOutput({ ...SAFE_SECTIONS, reviewQuestions: ['Is the product certified for export?', 'The farm is certified.'] }),
    )
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result).toMatchObject({ ok: false, code: 'unsafe_output' })
  })

  it('does NOT treat echoed source references as AI claims', async () => {
    // "certified" here is an echo of a source name, not an AI-authored claim,
    // so it must not trip the wording guard (which runs over prose only).
    const provider = stubProvider(async () =>
      makeOutput({
        ...SAFE_SECTIONS,
        sourceReferences: ['Certified Organic Board circular', 'https://example.test/certified'],
      }),
    )
    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.sourceReferences).toContain('Certified Organic Board circular')
    }
  })
})
