import { describe, expect, it } from 'vitest'
import type { LegalUpdate } from '../types'
import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'
import type { AIComplianceOutput } from './aiComplianceTypes'
import { AI_DRAFT_LABEL, generateAiDraftSummary } from './complianceAiSummarisation'
import { createComplianceAiSummaryHttpClient } from './complianceAiSummaryClient'
import { handleAiSummaryRequest } from './serverAiSummary'
import type { ServerAiSummaryDeps } from './serverAiSummary'

// ─── Phase 2I — full-stack boundary integration + security source sweep ─────
//
// Wires the REAL client adapter to the REAL server core in-process (the mocked
// fetch invokes handleAiSummaryRequest), so the whole chain — token → auth →
// admin authz → validation → guarded orchestration → labelled draft → client
// re-guard — is exercised without any real Supabase, AI provider, or network.
// It then asserts the security invariants directly against the source of the
// boundary files.

function output(value: AiDraftSummarySections): AIComplianceOutput<AiDraftSummarySections> {
  return {
    value,
    confidence: 0.5,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'srv', description: 'stub' },
      modelInfo: { provider: 'anthropic', model: 'claude-test' },
      generatedAt: '2026-07-10T00:00:00.000Z',
      requiresHumanReview: true,
    },
  }
}

function adminDeps(
  impl: (input: AiSummaryProviderInput) => Promise<AIComplianceOutput<AiDraftSummarySections>>,
): ServerAiSummaryDeps {
  const provider: ComplianceAiSummaryProvider = { draftSummary: impl }
  return {
    authenticate: async (token) => (token ? { userId: 'admin-user' } : null),
    getProfileRole: async () => 'ddp_admin',
    provider,
  }
}

/** A fetch that routes the client adapter's POST into the real server core. */
function inProcessFetch(
  deps: ServerAiSummaryDeps,
  captured: { authorization?: string },
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    captured.authorization = headers.authorization
    const result = await handleAiSummaryRequest(
      {
        method: init?.method ?? 'GET',
        contentType: headers['content-type'] ?? null,
        authorization: headers.authorization ?? null,
        body: init?.body,
      },
      deps,
    )
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
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
    rawText: 'ประกาศเรื่องการเพาะปลูก 🌿 record-keeping change.',
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

const SAFE: AiDraftSummarySections = {
  draftSummary: 'A drafted summary.',
  possibleSignificance: 'Possible significance.',
  uncertainties: 'Uncertainties.',
  reviewQuestions: ['A question?'],
  sourceReferences: ['Thai FDA'],
}

describe('AI summary boundary — full client→server→guard round trip', () => {
  it('sends the Supabase session token and returns a labelled human-review draft', async () => {
    const captured: { authorization?: string } = {}
    const deps = adminDeps(async (input) => output({ ...SAFE, draftSummary: `Draft: ${input.rawEvidence}` }))
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'supabase-session-token',
      fetchImpl: inProcessFetch(deps, captured),
    })

    const result = await generateAiDraftSummary(makeUpdate(), client, { requestInProgress: false })

    expect(captured.authorization).toBe('Bearer supabase-session-token')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.label).toBe(AI_DRAFT_LABEL)
    expect(result.draft.requiresHumanReview).toBe(true)
    // Thai/Unicode evidence survives the whole boundary.
    expect(result.draft.draftSummary).toContain('ประกาศ')
    // Capability lock holds end-to-end.
    expect(result.draft.approvesUpdate).toBe(false)
    expect(result.draft.createsRule).toBe(false)
    expect(result.draft.enforces).toBe(false)
    expect(result.draft.certifiesCompliance).toBe(false)
  })

  it('rejects a non-admin caller end-to-end (server 403 → client provider_error)', async () => {
    const captured: { authorization?: string } = {}
    const deps: ServerAiSummaryDeps = { ...adminDeps(async () => output(SAFE)), getProfileRole: async () => 'farmer' }
    const client = createComplianceAiSummaryHttpClient({
      getAccessToken: async () => 'token',
      fetchImpl: inProcessFetch(deps, captured),
    })
    const result = await generateAiDraftSummary(makeUpdate(), client, { requestInProgress: false })
    expect(result).toMatchObject({ ok: false, code: 'provider_error' })
  })
})

// ─── Security source sweep over the boundary files ──────────────────────────

const API_SRC = Object.values(
  import.meta.glob('../../api/compliance/ai-summary.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string
const CLIENT_SRC = Object.values(
  import.meta.glob('./complianceAiSummaryClient.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string
const CORE_SRC = Object.values(
  import.meta.glob('./serverAiSummary.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string
const PROVIDER_SRC = Object.values(
  import.meta.glob('./serverAiProvider.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('boundary source — no persistence, rules, approval, enforcement, or scheduling', () => {
  const boundary = [
    ['api', API_SRC],
    ['client', CLIENT_SRC],
    ['core', CORE_SRC],
    ['provider', PROVIDER_SRC],
  ] as const

  it('every boundary source loaded', () => {
    for (const [, src] of boundary) expect(src.length).toBeGreaterThan(200)
  })

  it('writes nothing to Supabase and creates/approves/enforces no rule', () => {
    for (const [name, src] of boundary) {
      expect(src, `${name}: no db writes`).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/)
      expect(src, `${name}: no rule ops`).not.toMatch(/insertRule|approveRule|enforceRule|updateRuleStatus|createRule/)
    }
  })

  it('introduces no scheduler, cron, or polling', () => {
    for (const [name, src] of boundary) {
      expect(src, `${name}: no cron/schedule`).not.toMatch(/\bcron\b|setInterval|schedule/i)
    }
    // The provider's only timer is the AbortController timeout — no other setTimeout.
    expect((PROVIDER_SRC.match(/setTimeout/g) ?? []).length).toBe(1)
    expect(PROVIDER_SRC).toMatch(/AbortController/)
    expect(CLIENT_SRC).not.toMatch(/setTimeout|setInterval/)
    expect(CORE_SRC).not.toMatch(/setTimeout|setInterval/)
  })

  it('uses no browser storage', () => {
    for (const [name, src] of boundary) {
      expect(src, `${name}: no storage`).not.toMatch(/localStorage|sessionStorage/)
    }
  })
})

describe('boundary source — secret handling', () => {
  it('the API reads server-only env, never a VITE_ provider secret, and holds no literal key', () => {
    expect(API_SRC).toMatch(/process\.env\.ANTHROPIC_API_KEY/)
    expect(API_SRC).toMatch(/process\.env\.SUPABASE_URL/)
    expect(API_SRC).not.toMatch(/import\.meta\.env/)
    expect(API_SRC).not.toMatch(/VITE_[A-Z_]*(OPENAI|ANTHROPIC|AI_KEY|API_KEY)/)
    expect(API_SRC).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    // No service-role key is introduced.
    expect(API_SRC).not.toMatch(/SERVICE_ROLE|service_role/)
  })

  it('the browser client knows only our own endpoint — no vendor host, key, or provider header', () => {
    expect(CLIENT_SRC).toMatch(/\/api\/compliance\/ai-summary/)
    expect(CLIENT_SRC).not.toMatch(/api\.anthropic\.com|api\.openai\.com|generativelanguage/i)
    expect(CLIENT_SRC).not.toMatch(/x-api-key|anthropic-version|ANTHROPIC_API_KEY/i)
    expect(CLIENT_SRC).not.toMatch(/import\.meta\.env|process\.env/)
    // Only the caller's session bearer token is attached — no provider secret.
    expect(CLIENT_SRC).toMatch(/Bearer \$\{accessToken\}/)
  })

  it('the provider keeps the key in a header and never in the request body or logs', () => {
    expect(PROVIDER_SRC).toMatch(/'x-api-key': config\.apiKey/)
    expect(PROVIDER_SRC).not.toMatch(/console\.(log|error|warn|info)/)
    expect(PROVIDER_SRC).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
  })
})
