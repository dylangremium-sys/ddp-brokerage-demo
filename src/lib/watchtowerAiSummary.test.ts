import { describe, expect, it, vi } from 'vitest'
import type { LegalUpdate, LegalUpdateStatus } from '../types'
import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'
import type { AIComplianceOutput } from './aiComplianceTypes'
import { AI_DRAFT_LABEL, DEFAULT_MAX_EVIDENCE_CHARS } from './complianceAiSummarisation'
import {
  AI_SUMMARY_MESSAGES,
  evaluateAiSummaryEligibility,
  isAiSummaryProviderAvailable,
  messageForAiSummaryCode,
  runAiDraftSummary,
} from './watchtowerAiSummary'

// ─── Phase 2H — Watchtower AI draft-summary controller tests ────────────────
//
// Unit tests for the framework-agnostic controller, using MOCK providers only.
// No real AI provider, no vendor SDK, and no network is ever exercised (the
// module never imports one — asserted statically below). Component-level manual-
// invocation / wording / discard guarantees are proven separately against the
// .tsx source in watchtowerAiSummaryIntegration.test.ts.

const SAFE_SECTIONS: AiDraftSummarySections = {
  draftSummary: 'The notice describes a change to permitted cultivation record-keeping.',
  possibleSignificance: 'May affect how farms log harvest batches; a reviewer should confirm.',
  uncertainties: 'The effective date is unclear and should be checked against the source.',
  reviewQuestions: ['Does this apply to existing licences?'],
  sourceReferences: ['Thai FDA notice', 'https://example.test/notice'],
}

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
      modelInfo: { provider: overrides?.provider ?? 'mock', model: overrides?.model ?? 'mock-1' },
      generatedAt: overrides?.generatedAt ?? new Date().toISOString(),
      requiresHumanReview: true,
    },
  }
}

function mockProvider(
  impl: (input: AiSummaryProviderInput) => Promise<AIComplianceOutput<AiDraftSummarySections>>,
): ComplianceAiSummaryProvider {
  return { draftSummary: vi.fn(impl) }
}

let seq = 0
function makeUpdate(overrides: Partial<LegalUpdate> = {}): LegalUpdate {
  seq += 1
  return {
    id: `lu-${seq}`,
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

const ALWAYS_SELECTED = { isStillSelected: () => true }

describe('isAiSummaryProviderAvailable', () => {
  it('is false when no provider is injected (production default) and true otherwise', () => {
    expect(isAiSummaryProviderAvailable(null)).toBe(false)
    expect(isAiSummaryProviderAvailable(mockProvider(async () => makeOutput(SAFE_SECTIONS)))).toBe(true)
  })
})

describe('evaluateAiSummaryEligibility — button state via the shared guard', () => {
  const provider = mockProvider(async () => makeOutput(SAFE_SECTIONS))

  it('allows an eligible new draft with a provider available', () => {
    const e = evaluateAiSummaryEligibility(makeUpdate(), { provider, requestInProgress: false })
    expect(e.canGenerate).toBe(true)
    expect(e.code).toBe('ok')
  })

  it('disables when no update is selected', () => {
    const e = evaluateAiSummaryEligibility(null, { provider, requestInProgress: false })
    expect(e).toMatchObject({ canGenerate: false, code: 'missing_update' })
  })

  it('disables when no provider is configured', () => {
    const e = evaluateAiSummaryEligibility(makeUpdate(), { provider: null, requestInProgress: false })
    expect(e).toMatchObject({ canGenerate: false, code: 'provider_unconfigured' })
    expect(e.reason).toBe('No AI provider is configured for this build.')
  })

  it('disables for evidence-missing / oversized / unsupported-status / in-progress', () => {
    expect(evaluateAiSummaryEligibility(makeUpdate({ rawText: '  ' }), { provider, requestInProgress: false }).code).toBe('missing_evidence')
    expect(
      evaluateAiSummaryEligibility(makeUpdate({ rawText: 'x'.repeat(DEFAULT_MAX_EVIDENCE_CHARS + 1) }), { provider, requestInProgress: false }).code,
    ).toBe('oversized_evidence')
    const locked: LegalUpdateStatus[] = ['needs_review', 'reviewed', 'rule_suggested', 'sent_to_legal', 'archived', 'rejected']
    for (const status of locked) {
      expect(evaluateAiSummaryEligibility(makeUpdate({ status }), { provider, requestInProgress: false }).code).toBe('unsupported_status')
    }
    expect(evaluateAiSummaryEligibility(makeUpdate(), { provider, requestInProgress: true }).code).toBe('request_in_progress')
  })
})

describe('runAiDraftSummary — guarded run with stale-selection handling', () => {
  it('returns a labelled, human-review-required, transient draft on success', async () => {
    const provider = mockProvider(async () => makeOutput(SAFE_SECTIONS, { provider: 'acme', model: 'acme-1', generatedAt: '2026-07-10T00:00:00.000Z' }))
    const update = makeUpdate()
    const outcome = await runAiDraftSummary(update, provider, { requestInProgress: false, ...ALWAYS_SELECTED })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.draft.legalUpdateId).toBe(update.id)
    expect(outcome.draft.label).toBe(AI_DRAFT_LABEL)
    expect(outcome.draft.requiresHumanReview).toBe(true)
    expect(outcome.draft.status).toBe('draft_generated')
    // Capability guarantees: a draft, nothing more.
    expect(outcome.draft.approvesUpdate).toBe(false)
    expect(outcome.draft.createsRule).toBe(false)
    expect(outcome.draft.enforces).toBe(false)
    expect(outcome.draft.certifiesCompliance).toBe(false)
    expect(outcome.draft.providerId).toBe('acme')
    expect(outcome.draft.modelId).toBe('acme-1')
  })

  it('does not overwrite the legal update — the input update object is untouched', async () => {
    const provider = mockProvider(async () => makeOutput(SAFE_SECTIONS))
    const update = makeUpdate({ summary: 'original human summary' })
    const snapshot = JSON.stringify(update)
    await runAiDraftSummary(update, provider, { requestInProgress: false, ...ALWAYS_SELECTED })
    expect(JSON.stringify(update)).toBe(snapshot) // no mutation, no persistence
    expect(update.summary).toBe('original human summary')
  })

  it('does not invoke the provider when a request is already running (concurrency block)', async () => {
    const spy = vi.fn(async () => makeOutput(SAFE_SECTIONS))
    const provider = mockProvider(spy)
    const outcome = await runAiDraftSummary(makeUpdate(), provider, { requestInProgress: true, ...ALWAYS_SELECTED })
    expect(outcome).toMatchObject({ ok: false, code: 'request_in_progress' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not invoke the provider when the guard rejects (unsupported status)', async () => {
    const spy = vi.fn(async () => makeOutput(SAFE_SECTIONS))
    const provider = mockProvider(spy)
    const outcome = await runAiDraftSummary(makeUpdate({ status: 'reviewed' }), provider, { requestInProgress: false, ...ALWAYS_SELECTED })
    expect(outcome).toMatchObject({ ok: false, code: 'unsupported_status' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a missing update, missing evidence, and oversized evidence safely', async () => {
    const provider = mockProvider(async () => makeOutput(SAFE_SECTIONS))
    expect((await runAiDraftSummary(null, provider, { requestInProgress: false, ...ALWAYS_SELECTED })).ok).toBe(false)
    expect(await runAiDraftSummary(makeUpdate({ rawText: '' }), provider, { requestInProgress: false, ...ALWAYS_SELECTED })).toMatchObject({ ok: false, code: 'missing_evidence' })
    expect(
      await runAiDraftSummary(makeUpdate({ rawText: 'x'.repeat(DEFAULT_MAX_EVIDENCE_CHARS + 1) }), provider, { requestInProgress: false, ...ALWAYS_SELECTED }),
    ).toMatchObject({ ok: false, code: 'oversized_evidence' })
  })

  it('reports provider_unconfigured when the provider is null', async () => {
    expect(await runAiDraftSummary(makeUpdate(), null, { requestInProgress: false, ...ALWAYS_SELECTED })).toMatchObject({ ok: false, code: 'provider_unconfigured' })
  })

  it('maps provider timeout and provider error to safe coded messages', async () => {
    const timeoutProvider = mockProvider(async () => {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err
    })
    const errorProvider = mockProvider(async () => { throw new Error('boom') })
    expect(await runAiDraftSummary(makeUpdate(), timeoutProvider, { requestInProgress: false, ...ALWAYS_SELECTED })).toMatchObject({ ok: false, code: 'provider_timeout' })
    expect(await runAiDraftSummary(makeUpdate(), errorProvider, { requestInProgress: false, ...ALWAYS_SELECTED })).toMatchObject({ ok: false, code: 'provider_error' })
  })

  it('rejects malformed and empty provider output', async () => {
    const malformed = mockProvider(async () => makeOutput({ ...SAFE_SECTIONS, reviewQuestions: 'nope' as unknown as string[] }))
    const empty = mockProvider(async () => makeOutput({ ...SAFE_SECTIONS, draftSummary: '   ' }))
    expect(await runAiDraftSummary(makeUpdate(), malformed, { requestInProgress: false, ...ALWAYS_SELECTED })).toMatchObject({ ok: false, code: 'malformed_output' })
    expect(await runAiDraftSummary(makeUpdate(), empty, { requestInProgress: false, ...ALWAYS_SELECTED })).toMatchObject({ ok: false, code: 'empty_output' })
  })

  it('discards a draft whose update is no longer selected (stale selection)', async () => {
    const provider = mockProvider(async () => makeOutput(SAFE_SECTIONS))
    const outcome = await runAiDraftSummary(makeUpdate(), provider, { requestInProgress: false, isStillSelected: () => false })
    expect(outcome).toMatchObject({ ok: false, code: 'stale_selection' })
  })

  it('preserves Thai and Unicode evidence through to the draft unchanged', async () => {
    const thai = 'ประกาศกระทรวงสาธารณสุข เรื่อง การเพาะปลูกกัญชา ฉบับที่ ๒ 🌿'
    const provider = mockProvider(async (input) => {
      // The provider receives the raw evidence verbatim.
      expect(input.rawEvidence).toContain(thai)
      return makeOutput({ ...SAFE_SECTIONS, draftSummary: `สรุปร่าง: ${thai}` })
    })
    const outcome = await runAiDraftSummary(makeUpdate({ rawText: thai }), provider, { requestInProgress: false, ...ALWAYS_SELECTED })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.draft.draftSummary).toContain(thai)
  })

  it('every outcome code maps to a safe message with no prohibited certification wording', () => {
    const prohibited = /AI-approved|legally confirmed|compliance verified|certified compliant|regulation validated|rule approved|ready for enforcement/i
    for (const code of Object.keys(AI_SUMMARY_MESSAGES) as (keyof typeof AI_SUMMARY_MESSAGES)[]) {
      const msg = messageForAiSummaryCode(code)
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toMatch(prohibited)
    }
  })
})

describe('controller module source — no vendor SDK, network, persistence, or scheduler', () => {
  const RAW = import.meta.glob('./watchtowerAiSummary.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const SRC = Object.values(RAW)[0] ?? ''

  it('has a non-empty source', () => {
    expect(SRC.length).toBeGreaterThan(500)
  })

  it('imports no vendor AI SDK and makes no direct network/fetch call', () => {
    expect(SRC).not.toMatch(/from ['"]openai['"]|from ['"]@anthropic|require\(['"]openai/i)
    expect(SRC).not.toMatch(/\bfetch\(/)
    expect(SRC).not.toMatch(/XMLHttpRequest|WebSocket/)
  })

  it('introduces no timer, scheduler, cron, or polling', () => {
    expect(SRC).not.toMatch(/setInterval|setTimeout/)
    expect(SRC).not.toMatch(/\bcron\b/)
  })

  it('performs no persistence (no supabase / localStorage writes)', () => {
    expect(SRC).not.toMatch(/supabase/i)
    expect(SRC).not.toMatch(/localStorage|saveStored|insertLegalUpdate|updateLegalUpdateStatus|insertRule|updateRuleStatus/)
  })

  it('creates or approves no rule and enforces nothing', () => {
    expect(SRC).not.toMatch(/createRule|approveRule|enforceRule|insertRule|updateRuleStatus/)
  })
})
