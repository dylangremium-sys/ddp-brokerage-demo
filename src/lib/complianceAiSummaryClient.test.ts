import { describe, expect, it } from 'vitest'
import type { LegalUpdate } from '../types'
import type { AiSummaryProviderInput } from './aiComplianceProvider'
import { AI_DRAFT_LABEL, generateAiDraftSummary } from './complianceAiSummarisation'
import { createComplianceAiSummaryHttpClient } from './complianceAiSummaryClient'

// ─── Phase 2I — browser client adapter tests ────────────────────────────────
//
// Mocked fetch + injected session-token getter — no real Supabase, no network.
// Proves the adapter attaches the Supabase session token, posts ONLY the
// permitted fields, fails closed without a token, blocks concurrent calls, and
// round-trips a server draft back through the SAME guarded orchestration.

const SERVER_SECTIONS = {
  draftSummary: 'The notice changes cultivation record-keeping.',
  possibleSignificance: 'May affect batch logging; a reviewer should confirm.',
  uncertainties: 'The effective date is unclear.',
  reviewQuestions: ['Does this apply to existing licences?'],
  sourceReferences: ['Thai FDA notice', 'https://example.test/notice'],
}

function serverSuccess(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      sections: SERVER_SECTIONS,
      provenance: { provider: 'anthropic', model: 'claude-test', generatedAt: '2026-07-10T00:00:00.000Z' },
      requiresHumanReview: true,
      label: AI_DRAFT_LABEL,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const INPUT: AiSummaryProviderInput = {
  legalUpdateId: 'lu-1',
  sourceName: 'Thai FDA',
  sourceUrl: 'https://example.test/notice',
  jurisdiction: 'Thailand',
  itemTitle: 'Cultivation notice',
  publishedAt: '2026-06-01T00:00:00.000Z',
  rawEvidence: 'Raw source evidence.',
  provenanceChecksum: null,
  status: 'new',
}

function makeUpdate(overrides: Partial<LegalUpdate> = {}): LegalUpdate {
  return {
    id: 'lu-1',
    sourceId: null,
    title: 'Cultivation notice',
    jurisdiction: 'Thailand',
    sourceName: 'Thai FDA',
    sourceUrl: 'https://example.test/notice',
    publishedAt: '2026-06-01T00:00:00.000Z',
    detectedAt: '2026-06-02T00:00:00.000Z',
    rawText: 'Raw source evidence.',
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

describe('createComplianceAiSummaryHttpClient — request shaping', () => {
  it('attaches the Supabase session token and posts ONLY permitted fields', async () => {
    let url = ''
    let init: RequestInit | undefined
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'session-access-token',
      fetchImpl: async (u, i) => { url = String(u); init = i; return serverSuccess() },
    })

    // Simulate the orchestration passing a full request object (with capability
    // flags at runtime) — the adapter must NOT forward those.
    await client.draftSummary({ ...INPUT, canApprove: false, isDraftOnly: true } as unknown as AiSummaryProviderInput)

    expect(url).toBe('/api/compliance/ai-summary')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer session-access-token')

    const body = JSON.parse(String(init?.body))
    expect(Object.keys(body).sort()).toEqual([
      'capability',
      'itemTitle',
      'jurisdiction',
      'legalUpdateId',
      'provenanceChecksum',
      'publishedAt',
      'rawEvidence',
      'sourceName',
      'sourceUrl',
      'status',
    ])
    expect(body.capability).toBe('draft_summarisation')
    expect(body).not.toHaveProperty('canApprove')
    expect(body).not.toHaveProperty('isDraftOnly')
  })

  it('fails closed (no request made) when there is no access token', async () => {
    let called = false
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => null,
      fetchImpl: async () => { called = true; return serverSuccess() },
    })
    await expect(client.draftSummary(INPUT)).rejects.toThrow(/No authenticated session/)
    expect(called).toBe(false)
  })

  it('blocks a duplicate concurrent request', async () => {
    let resolveFirst: () => void = () => {}
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'token',
      fetchImpl: () => new Promise<Response>((resolve) => { resolveFirst = () => resolve(serverSuccess()) }),
    })
    const first = client.draftSummary(INPUT)
    await expect(client.draftSummary(INPUT)).rejects.toThrow(/already in progress/)
    resolveFirst()
    await expect(first).resolves.toBeTruthy()
  })
})

describe('createComplianceAiSummaryHttpClient — orchestration integration', () => {
  it('round-trips a server draft through the guarded orchestration into a labelled draft', async () => {
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'token',
      fetchImpl: async () => serverSuccess(),
    })
    const result = await generateAiDraftSummary(makeUpdate(), client, { requestInProgress: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.label).toBe(AI_DRAFT_LABEL)
    expect(result.draft.requiresHumanReview).toBe(true)
    expect(result.draft.approvesUpdate).toBe(false)
    expect(result.draft.createsRule).toBe(false)
    expect(result.draft.enforces).toBe(false)
    expect(result.draft.certifiesCompliance).toBe(false)
    expect(result.draft.providerId).toBe('anthropic')
    expect(result.draft.draftSummary).toBe(SERVER_SECTIONS.draftSummary)
  })

  // Was: "maps a server error into provider_error". It mapped EVERY status that
  // way, so a 4xx this endpoint rejected on its own — bad field, wrong role —
  // was reported as an AI provider outage for a request no provider ever saw.
  it('maps a 4xx into request_invalid via the orchestration', async () => {
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'token',
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'forbidden', message: 'x' }), { status: 403 }),
    })
    const result = await generateAiDraftSummary(makeUpdate(), client, { requestInProgress: false })
    expect(result).toMatchObject({ ok: false, code: 'request_invalid' })
  })

  it('still maps a 5xx into provider_error via the orchestration', async () => {
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'token',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, error: 'provider_error', message: 'x' }), { status: 502 }),
    })
    const result = await generateAiDraftSummary(makeUpdate(), client, { requestInProgress: false })
    expect(result).toMatchObject({ ok: false, code: 'provider_error' })
  })

  it('re-runs the wording guard client-side on the server draft (defence in depth)', async () => {
    const unsafe = new Response(
      JSON.stringify({
        ok: true,
        sections: { ...SERVER_SECTIONS, draftSummary: 'This is legally compliant and export-ready.' },
        provenance: { provider: 'anthropic', model: 'claude-test', generatedAt: '2026-07-10T00:00:00.000Z' },
      }),
      { status: 200 },
    )
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'token',
      fetchImpl: async () => unsafe,
    })
    const result = await generateAiDraftSummary(makeUpdate(), client, { requestInProgress: false })
    expect(result).toMatchObject({ ok: false, code: 'unsafe_output' })
  })
})
