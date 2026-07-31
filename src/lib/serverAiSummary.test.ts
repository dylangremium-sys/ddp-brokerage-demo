import { describe, expect, it } from 'vitest'
import type { LegalUpdate } from '../types'
import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'
import type { AIComplianceOutput } from './aiComplianceTypes'
import { AI_DRAFT_LABEL } from './complianceAiSummarisation'
import {
  MAX_REQUEST_CHARS,
  handleAiSummaryRequest,
  validateAiSummaryBody,
} from './serverAiSummary'
import type { NormalizedRequest, ServerAiSummaryDeps } from './serverAiSummary'

// ─── Phase 2I — secure server-side AI draft-summary boundary tests ──────────
//
// Mocks only. No real Supabase, AI provider, or network. Exercises the full
// gate order (method → content-type → auth → admin authz → validation →
// guarded orchestration → safe error mapping) and proves the server itself
// owns the capability lock and never trusts client-supplied role/flags.

const SAFE_SECTIONS: AiDraftSummarySections = {
  draftSummary: 'The notice changes permitted cultivation record-keeping.',
  possibleSignificance: 'May affect how farms log harvest batches; a reviewer should confirm.',
  uncertainties: 'The effective date is unclear and should be checked against the source.',
  reviewQuestions: ['Does this apply to existing licences?', 'What is the effective date?'],
  sourceReferences: ['Thai FDA notice', 'https://example.test/notice'],
}

function output(value: AiDraftSummarySections): AIComplianceOutput<AiDraftSummarySections> {
  return {
    value,
    confidence: 0.5,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'test', description: 'stub' },
      modelInfo: { provider: 'test-provider', model: 'test-model' },
      generatedAt: '2026-07-10T00:00:00.000Z',
      requiresHumanReview: true,
    },
  }
}

interface SpyProvider extends ComplianceAiSummaryProvider {
  calls: AiSummaryProviderInput[]
}

function spyProvider(
  impl: (input: AiSummaryProviderInput) => Promise<AIComplianceOutput<AiDraftSummarySections>> = async () =>
    output(SAFE_SECTIONS),
): SpyProvider {
  const calls: AiSummaryProviderInput[] = []
  return {
    calls,
    draftSummary: async (input) => {
      calls.push(input)
      return impl(input)
    },
  }
}

/** The STORED row. The endpoint reads its evidence from here, never from the
 *  request body — these values mirror VALID_BODY so existing expectations hold,
 *  and the tests that matter deliberately make them disagree. */
const STORED_UPDATE: LegalUpdate = {
  id: 'lu-1',
  sourceId: null,
  title: 'Cultivation record-keeping notice',
  jurisdiction: 'Thailand',
  sourceName: 'Thai FDA',
  sourceUrl: 'https://example.test/notice',
  publishedAt: '2026-06-01T00:00:00.000Z',
  detectedAt: '',
  rawText: 'Full raw source evidence text describing the regulatory change.',
  summary: '',
  affectedAreas: [],
  aiRiskLevel: null,
  status: 'new',
  reviewerNotes: '',
  createdAt: '',
  updatedAt: '',
}

function makeDeps(overrides: Partial<ServerAiSummaryDeps> = {}): ServerAiSummaryDeps {
  return {
    authenticate: async () => ({ userId: 'user-1' }),
    getProfileRole: async () => 'ddp_admin',
    getLegalUpdate: async (id) => (id === STORED_UPDATE.id ? STORED_UPDATE : null),
    provider: spyProvider(),
    ...overrides,
  }
}

/**
 * Deps whose STORED row differs from the default fixture. Since the endpoint
 * reads its evidence from the database, a test that wants a Cannamonitor URL,
 * a non-`new` status, or oversized evidence has to put it HERE — putting it in
 * the request body is exactly what no longer has any effect.
 */
function depsWithStored(
  stored: Partial<LegalUpdate>,
  overrides: Partial<ServerAiSummaryDeps> = {},
): ServerAiSummaryDeps {
  return makeDeps({
    getLegalUpdate: async (id) => (id === STORED_UPDATE.id ? { ...STORED_UPDATE, ...stored } : null),
    ...overrides,
  })
}

const VALID_BODY: Record<string, unknown> = {
  legalUpdateId: 'lu-1',
  sourceName: 'Thai FDA',
  sourceUrl: 'https://example.test/notice',
  jurisdiction: 'Thailand',
  itemTitle: 'Cultivation record-keeping notice',
  publishedAt: '2026-06-01T00:00:00.000Z',
  rawEvidence: 'Full raw source evidence text describing the regulatory change.',
  provenanceChecksum: null,
  status: 'new',
  capability: 'draft_summarisation',
}

function req(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: 'POST',
    contentType: 'application/json',
    authorization: 'Bearer valid-token',
    body: { ...VALID_BODY },
    ...overrides,
  }
}

describe('handleAiSummaryRequest — transport + auth gates', () => {
  it('rejects a non-POST method with 405', async () => {
    const r = await handleAiSummaryRequest(req({ method: 'GET' }), makeDeps())
    expect(r.status).toBe(405)
  })

  it('rejects a non-JSON content type with 415', async () => {
    const r = await handleAiSummaryRequest(req({ contentType: 'text/plain' }), makeDeps())
    expect(r.status).toBe(415)
  })

  it('accepts application/json with a charset', async () => {
    const r = await handleAiSummaryRequest(req({ contentType: 'application/json; charset=utf-8' }), makeDeps())
    expect(r.status).toBe(200)
  })

  it('rejects a missing Authorization header with 401', async () => {
    const r = await handleAiSummaryRequest(req({ authorization: null }), makeDeps())
    expect(r.status).toBe(401)
  })

  it('rejects a non-bearer / empty Authorization with 401', async () => {
    expect((await handleAiSummaryRequest(req({ authorization: 'Basic abc' }), makeDeps())).status).toBe(401)
    expect((await handleAiSummaryRequest(req({ authorization: 'Bearer   ' }), makeDeps())).status).toBe(401)
  })

  it('rejects an invalid bearer token (authenticate → null) with 401', async () => {
    const r = await handleAiSummaryRequest(req(), makeDeps({ authenticate: async () => null }))
    expect(r.status).toBe(401)
  })

  it('rejects a thrown authentication error with 401 (no leak)', async () => {
    const r = await handleAiSummaryRequest(
      req(),
      makeDeps({ authenticate: async () => { throw new Error('supabase down: secret-token') } }),
    )
    expect(r.status).toBe(401)
    expect(JSON.stringify(r.body)).not.toContain('secret-token')
  })
})

describe('handleAiSummaryRequest — admin authorisation', () => {
  it('rejects a farmer (non-admin) with 403', async () => {
    const r = await handleAiSummaryRequest(req(), makeDeps({ getProfileRole: async () => 'farmer' }))
    expect(r.status).toBe(403)
  })

  it('rejects a missing/null profile role with 403', async () => {
    const r = await handleAiSummaryRequest(req(), makeDeps({ getProfileRole: async () => null }))
    expect(r.status).toBe(403)
  })

  it('IGNORES a client-supplied admin role in the body — real profile decides', async () => {
    // Body claims admin, but the authenticated profile is a farmer → 403.
    const r = await handleAiSummaryRequest(
      req({ body: { ...VALID_BODY, role: 'ddp_admin', isAdmin: true } }),
      makeDeps({ getProfileRole: async () => 'farmer' }),
    )
    expect(r.status).toBe(403)
  })

  it('never calls the provider for an unauthorised caller', async () => {
    const provider = spyProvider()
    await handleAiSummaryRequest(req(), makeDeps({ provider, getProfileRole: async () => 'farmer' }))
    expect(provider.calls).toHaveLength(0)
  })
})

describe('handleAiSummaryRequest — strict request validation', () => {
  it('rejects an unknown field (e.g. a client capability flag) with 400', async () => {
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, canApprove: true } }), makeDeps())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('unknown_field')
  })

  it('rejects a missing/unsupported capability with 400', async () => {
    const { capability: _omit, ...noCap } = VALID_BODY
    void _omit
    expect((await handleAiSummaryRequest(req({ body: noCap }), makeDeps())).status).toBe(400)
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, capability: 'approve_update' } }), makeDeps())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_capability')
  })

  it('rejects malformed JSON / non-object body with 400', async () => {
    expect((await handleAiSummaryRequest(req({ body: '{ not json' }), makeDeps())).status).toBe(400)
    expect((await handleAiSummaryRequest(req({ body: 'null' }), makeDeps())).status).toBe(400)
    expect((await handleAiSummaryRequest(req({ body: [1, 2, 3] }), makeDeps())).status).toBe(400)
  })

  it('rejects an invalid sourceUrl with 400', async () => {
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, sourceUrl: 'not a url' } }), makeDeps())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_url')
  })

  it('rejects a non-hex provenanceChecksum with 400', async () => {
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, provenanceChecksum: 'zzz' } }), makeDeps())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_checksum')
  })

  it('rejects a wrong-typed field with 400', async () => {
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, sourceName: 123 } }), makeDeps())
    expect(r.status).toBe(400)
  })

  it('rejects an unknown status value with 400', async () => {
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, status: 'banana' } }), makeDeps())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_status')
  })

  it('rejects missing (whitespace) evidence with 400', async () => {
    const r = await handleAiSummaryRequest(req({ body: { ...VALID_BODY, rawEvidence: '   ' } }), makeDeps())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('missing_evidence')
  })

  it('rejects an oversized request body with 413', async () => {
    const r = await handleAiSummaryRequest(
      req({ body: { ...VALID_BODY, rawEvidence: 'x'.repeat(MAX_REQUEST_CHARS + 10) } }),
      makeDeps(),
    )
    expect(r.status).toBe(413)
  })
})

describe('handleAiSummaryRequest — guard reuse (never re-implemented)', () => {
  it('rejects a non-new STORED status via the request guard (422) without calling the provider', async () => {
    const provider = spyProvider()
    // Status comes from the row. The body still declares 'new' — and is ignored.
    const r = await handleAiSummaryRequest(
      req({ body: { ...VALID_BODY, status: 'new' } }),
      depsWithStored({ status: 'reviewed' }, { provider }),
    )
    expect(r.status).toBe(422)
    expect((r.body as { error: string }).error).toBe('unsupported_status')
    expect(provider.calls).toHaveLength(0)
  })

  it('rejects oversized STORED evidence (over the summarisation bound) via the guard', async () => {
    // Exceeds the 20k summarisation evidence bound → guard rejects → 413.
    const r = await handleAiSummaryRequest(
      req(),
      depsWithStored({ rawText: 'y'.repeat(20_001) }),
    )
    expect(r.status).toBe(413)
    expect((r.body as { error: string }).error).toBe('oversized_evidence')
  })

  it('fails closed to provider_unconfigured (503) when no provider is wired', async () => {
    const r = await handleAiSummaryRequest(req(), makeDeps({ provider: null }))
    expect(r.status).toBe(503)
    expect((r.body as { error: string }).error).toBe('provider_unconfigured')
  })
})

describe('handleAiSummaryRequest — provider failures safely mapped', () => {
  it('maps a provider timeout (AbortError) to 504', async () => {
    const provider = spyProvider(async () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    })
    const r = await handleAiSummaryRequest(req(), makeDeps({ provider }))
    expect(r.status).toBe(504)
    expect((r.body as { error: string }).error).toBe('provider_timeout')
  })

  it('maps a provider auth failure / rate limit (generic throw) to 502, no vendor detail', async () => {
    const provider = spyProvider(async () => { throw new Error('401 Unauthorized: sk-secret-key rate_limit') })
    const r = await handleAiSummaryRequest(req(), makeDeps({ provider }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('provider_error')
    expect(JSON.stringify(r.body)).not.toContain('sk-secret-key')
  })

  it('rejects a malformed provider output with 502', async () => {
    const provider = spyProvider(async () => output({ ...SAFE_SECTIONS, reviewQuestions: 'nope' as unknown as string[] }))
    const r = await handleAiSummaryRequest(req(), makeDeps({ provider }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('malformed_output')
  })

  it('rejects an empty provider output with 502', async () => {
    const provider = spyProvider(async () => output({ ...SAFE_SECTIONS, draftSummary: '   ' }))
    const r = await handleAiSummaryRequest(req(), makeDeps({ provider }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('empty_output')
  })

  it.each([
    ['approval', 'This confirms the batch is approved for export.'],
    ['certification', 'The farm is certified compliant with all requirements.'],
    ['rule-creation', 'This is legally compliant and export-ready.'],
    ['enforcement', 'The product is guaranteed and verified for shipment.'],
  ])('rejects unsafe %s wording in the AI prose with 502', async (_label, draftSummary) => {
    const provider = spyProvider(async () => output({ ...SAFE_SECTIONS, draftSummary }))
    const r = await handleAiSummaryRequest(req(), makeDeps({ provider }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('unsafe_output')
  })
})

describe('handleAiSummaryRequest — success is always a labelled draft', () => {
  it('returns 200 with a human-review draft, label, and normalized sections', async () => {
    const r = await handleAiSummaryRequest(req(), makeDeps())
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    if (!r.body.ok) return
    expect(r.body.requiresHumanReview).toBe(true)
    expect(r.body.label).toBe(AI_DRAFT_LABEL)
    expect(r.body.sections.draftSummary).toBe(SAFE_SECTIONS.draftSummary)
    expect(r.body.sections.reviewQuestions).toEqual(SAFE_SECTIONS.reviewQuestions)
    expect(r.body.provenance.provider).toBe('test-provider')
    expect(r.body.provenance.model).toBe('test-model')
  })

  it('preserves Thai / Unicode evidence through the boundary', async () => {
    const thai = 'ประกาศกรมวิชาการเกษตรเรื่องการเพาะปลูกกัญชา 🌿'
    const provider = spyProvider(async (input) =>
      output({ ...SAFE_SECTIONS, draftSummary: `Draft: ${input.rawEvidence}` }),
    )
    const r = await handleAiSummaryRequest(req(), depsWithStored({ rawText: thai }, { provider }))
    expect(r.status).toBe(200)
    if (!r.body.ok) return
    expect(r.body.sections.draftSummary).toContain(thai)
  })

  it('gives the server-constructed capability lock to the provider (never a client flag)', async () => {
    const provider = spyProvider()
    await handleAiSummaryRequest(
      // The body declares a DIFFERENT checksum; the stored row's is the one
      // that must reach the provider.
      req({ body: { ...VALID_BODY, provenanceChecksum: 'b'.repeat(64) } }),
      depsWithStored({ reviewerNotes: `Checksum: ${'a'.repeat(64)}` }, { provider }),
    )
    const input = provider.calls[0] as unknown as Record<string, unknown>
    expect(input.canApprove).toBe(false)
    expect(input.canCreateRule).toBe(false)
    expect(input.canEnforce).toBe(false)
    expect(input.makesBuyerFacingDecision).toBe(false)
    expect(input.requiresHumanReview).toBe(true)
    // Evidence and checksum both come from the STORED row, not the body.
    expect(input.rawEvidence).toBe(STORED_UPDATE.rawText)
    expect(input.provenanceChecksum).toBe('a'.repeat(64))
    expect(input.provenanceChecksum).not.toBe('b'.repeat(64))
  })

  it('error bodies expose only {ok,error,message} — no stack, token, or secret', async () => {
    const r = await handleAiSummaryRequest(req({ authorization: 'Bearer super-secret-token' }), makeDeps({ authenticate: async () => null }))
    expect(Object.keys(r.body).sort()).toEqual(['error', 'message', 'ok'])
    const s = JSON.stringify(r.body)
    expect(s).not.toContain('super-secret-token')
    expect(s).not.toMatch(/at .*\(.*:\d+:\d+\)/) // no stack frames
  })
})

describe('validateAiSummaryBody — direct unit checks', () => {
  it('accepts a minimal valid body', () => {
    expect(validateAiSummaryBody({ ...VALID_BODY }).ok).toBe(true)
  })

  it('accepts a valid 64-hex checksum and a null publishedAt', () => {
    const v = validateAiSummaryBody({ ...VALID_BODY, provenanceChecksum: 'F'.repeat(64), publishedAt: null })
    expect(v.ok).toBe(true)
  })
})

// ─── Cannamonitor source blocked server-side (P1 bypass fix) ────────────────
//
// An authenticated admin cannot reach the AI provider by POSTing a Cannamonitor
// sourceUrl: the shared execution gate (generateAiDraftSummary) denies it, and
// the server maps that to a deterministic 403. There is no database-write
// dependency in ServerAiSummaryDeps at all, so no write can occur on any path.
describe('handleAiSummaryRequest — Cannamonitor source blocked server-side', () => {
  const RAW_MARKER = 'CANNAMONITOR_SERVER_RAW_MARKER_MUST_NOT_REACH_PROVIDER'

  it('STORED Cannamonitor sourceUrl → 403, provider never called, raw evidence never sent', async () => {
    const provider = spyProvider()
    const r = await handleAiSummaryRequest(
      req(),
      depsWithStored(
        { sourceUrl: 'https://www.cannamonitor.com/brief/x', rawText: RAW_MARKER },
        { provider },
      ),
    )
    expect(r.status).toBe(403)
    expect(r.body.ok).toBe(false)
    if (!r.body.ok) expect(r.body.error).toBe('cannamonitor_permission_unverified') // the SOURCE gate, not an auth reject
    expect(provider.calls).toHaveLength(0)
    expect(provider.calls.some(c => JSON.stringify(c).includes(RAW_MARKER))).toBe(false)
  })

  it('denial occurs after admin authz and yields no summary body', async () => {
    const provider = spyProvider()
    const r = await handleAiSummaryRequest(
      req(),
      depsWithStored({ sourceUrl: 'https://cannamonitor.com/feed/' }, { provider }),
    )
    expect(r.status).toBe(403)
    expect(r.body.ok).toBe(false)
    if (!r.body.ok) expect(r.body.error).toBe('cannamonitor_permission_unverified')
    expect('sections' in r.body).toBe(false)
    expect(provider.calls).toHaveLength(0)
  })

  it('REGRESSION: an unrelated official source still succeeds (200) through the server', async () => {
    const provider = spyProvider()
    const r = await handleAiSummaryRequest(
      req(),
      depsWithStored({ sourceUrl: 'https://regulator.example.gov/notice' }, { provider }),
    )
    expect(r.status).toBe(200)
    expect(provider.calls).toHaveLength(1)
  })

  it('CANNOT be walked around by declaring a benign sourceUrl in the body', async () => {
    // The gate attributes by source URL. While the update was rebuilt from the
    // request, a caller could declare a benign URL and have Cannamonitor
    // evidence forwarded to the provider anyway. The stored row decides now.
    const provider = spyProvider()
    const r = await handleAiSummaryRequest(
      req({ body: { ...VALID_BODY, sourceUrl: 'https://regulator.example.gov/notice' } }),
      depsWithStored(
        { sourceUrl: 'https://cannamonitor.com/feed/', rawText: RAW_MARKER },
        { provider },
      ),
    )
    expect(r.status).toBe(403)
    expect(provider.calls).toHaveLength(0)
    expect(JSON.stringify(provider.calls)).not.toContain(RAW_MARKER)
  })
})
