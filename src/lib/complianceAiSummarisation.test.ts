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
  // Both are grounded against makeUpdate()'s recorded metadata, so the
  // reference guard keeps them and the happy path stays a happy path.
  sourceReferences: ['Thai FDA', 'https://example.test/notice'],
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
    expect(draft.droppedSourceReferences).toBe(0)

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
    // "certified" here is quoted source text, not an AI-authored claim, so it
    // must not trip the wording guard (which runs over prose only). The
    // quotation is grounded in the evidence, so the reference guard keeps it —
    // proving the draft survives both guards rather than passing one by luck.
    const quotation = 'produce certified by an accredited laboratory'
    const update = makeUpdate({
      rawText: `Licence holders may export only ${quotation} before shipment.`,
    })
    const provider = stubProvider(async () =>
      makeOutput({ ...SAFE_SECTIONS, sourceReferences: [quotation] }),
    )

    const result = await generateAiDraftSummary(update, provider, RUN)

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Rendered as the enclosing sentence read back out of the evidence, so
      // the reviewer sees the claim in its actual context.
      expect(result.draft.sourceReferences).toEqual([
        `Licence holders may export only ${quotation} before shipment.`,
      ])
      expect(result.draft.droppedSourceReferences).toBe(0)
    }
  })

  it('discards a fabricated source reference without failing the draft', async () => {
    // A model-invented citation renders under "Source references", where it
    // reads as provenance. It must not reach a reviewer — but the prose may be
    // perfectly good, so an ungrounded citation is dropped, not fatal.
    const provider = stubProvider(async () =>
      makeOutput({
        ...SAFE_SECTIONS,
        sourceReferences: ['Thai FDA', 'Ministerial Regulation No. 8 (2565), Annex IV'],
      }),
    )

    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.sourceReferences).toEqual(['Thai FDA'])
      expect(result.draft.droppedSourceReferences).toBe(1)
      // The prose is untouched — only the citation list is filtered.
      expect(result.draft.draftSummary).toBe(SAFE_SECTIONS.draftSummary)
    }
  })

  it('adds an upstream layer’s discards to its own count', async () => {
    // The browser receives sections the server already filtered, so its own
    // pass finds nothing to drop. Without carrying the server's count the
    // reviewer is told nothing was discarded from a draft that was pruned.
    const provider = stubProvider(async () => {
      const output = makeOutput({ ...SAFE_SECTIONS, sourceReferences: ['Thai FDA'] })
      return { ...output, provenance: { ...output.provenance, upstreamDroppedReferences: 2 } }
    })

    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.sourceReferences).toEqual(['Thai FDA'])
      expect(result.draft.droppedSourceReferences).toBe(2)
    }
  })

  it('reports provider_rejected, not provider_error, when the request shape is refused', async () => {
    // A rejected request is a configuration fault (unknown model, unsupported
    // parameter) that no retry fixes. Collapsing it into provider_error makes
    // a misconfigured deployment indistinguishable from a vendor outage.
    const provider = stubProvider(async () => {
      const error = new Error('AI provider request failed.')
      error.name = 'AiProviderRequestRejectedError'
      throw error
    })

    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('provider_rejected')
      // Still no vendor text, status, or key in what reaches the caller.
      expect(result.reason).not.toMatch(/\b[45]\d\d\b|anthropic|api[_-]?key/i)
    }
  })

  it('returns no references at all when none can be grounded', async () => {
    const provider = stubProvider(async () =>
      makeOutput({ ...SAFE_SECTIONS, sourceReferences: ['Invented Act s.1', 'Invented Act s.2'] }),
    )

    const result = await generateAiDraftSummary(makeUpdate(), provider, RUN)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.sourceReferences).toEqual([])
      expect(result.draft.droppedSourceReferences).toBe(2)
    }
  })
})

// ─── Cannamonitor authoritative execution gate (server-bypass fix) ──────────
//
// The Cannamonitor AI restriction is enforced HERE, in the shared execution
// function every caller funnels through, so no path — client controller OR the
// server endpoint (serverAiSummary.ts calls generateAiDraftSummary directly) —
// can reach the provider for a correctly-attributed Cannamonitor source while
// permission is unverified. Synthetic fixtures only; no live Cannamonitor request.
describe('generateAiDraftSummary — Cannamonitor authoritative gate', () => {
  const RUN_OPTS = { requestInProgress: false }
  const CANNAMONITOR_URL = 'https://www.cannamonitor.com/brief/some-item'
  const RAW_MARKER = 'CANNAMONITOR_RAW_TEXT_MARKER_MUST_NOT_REACH_PROVIDER'

  function spyProvider() {
    const inputs: AiSummaryProviderInput[] = []
    const provider = stubProvider(async input => {
      inputs.push(input)
      return makeOutput(SAFE_SECTIONS)
    })
    return { provider, inputs }
  }

  it('denies a correctly-attributed Cannamonitor update — provider not called, raw text never sent', async () => {
    const { provider, inputs } = spyProvider()
    const update = makeUpdate({ sourceUrl: CANNAMONITOR_URL, sourceName: 'Cannamonitor', rawText: RAW_MARKER })
    const result = await generateAiDraftSummary(update, provider, RUN_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('cannamonitor_permission_unverified')
    expect(inputs).toHaveLength(0) // provider never invoked
    expect(inputs.some(i => JSON.stringify(i).includes(RAW_MARKER))).toBe(false)
  })

  it('cannot be bypassed by a DIRECT call that skips evaluateAiSummaryEligibility', async () => {
    // Mirrors the server path: no client-side eligibility pre-check, straight into
    // the shared layer. Still blocked; the provider is unreachable.
    const { provider, inputs } = spyProvider()
    const update = makeUpdate({ sourceUrl: 'https://cannamonitor.com/feed/', rawText: RAW_MARKER })
    const result = await generateAiDraftSummary(update, provider, RUN_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('cannamonitor_permission_unverified')
    expect(inputs).toHaveLength(0)
  })

  it('blocks before the generic guard (an otherwise-eligible new draft is still denied)', async () => {
    const { provider, inputs } = spyProvider()
    const update = makeUpdate({ sourceUrl: CANNAMONITOR_URL, status: 'new', rawText: RAW_MARKER })
    const result = await generateAiDraftSummary(update, provider, RUN_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('cannamonitor_permission_unverified')
    expect(inputs).toHaveLength(0)
  })

  it('REGRESSION: an unrelated official source still reaches the provider', async () => {
    const { provider, inputs } = spyProvider()
    const update = makeUpdate({ sourceUrl: 'https://regulator.example.gov/rss/item-1' })
    const result = await generateAiDraftSummary(update, provider, RUN_OPTS)
    expect(result.ok).toBe(true)
    expect(inputs).toHaveLength(1)
  })

  it('REGRESSION: a blank source URL is NOT falsely blocked (documented attribution limitation)', async () => {
    const { provider, inputs } = spyProvider()
    const update = makeUpdate({ sourceUrl: '', rawText: 'pasted text with no attribution' })
    const result = await generateAiDraftSummary(update, provider, RUN_OPTS)
    expect(result.ok).toBe(true)
    if (!result.ok) expect(result.code).not.toBe('cannamonitor_permission_unverified')
    expect(inputs).toHaveLength(1)
  })

  it('REGRESSION: an unrelated commercial source retains ordinary behaviour', async () => {
    const { provider, inputs } = spyProvider()
    const update = makeUpdate({ sourceUrl: 'https://unrelated-intel.example.com/article' })
    const result = await generateAiDraftSummary(update, provider, RUN_OPTS)
    expect(result.ok).toBe(true)
    expect(inputs).toHaveLength(1)
  })
})
