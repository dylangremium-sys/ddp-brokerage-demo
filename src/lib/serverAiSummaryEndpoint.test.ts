import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NormalizedRequest, ServerAiSummaryDeps } from './serverAiSummary'

// The core is mocked so every exit path — success, 4xx, 5xx, and a thrown
// exception — can be driven precisely. The core's own behaviour is already
// covered by serverAiSummary.test.ts; what is under test here is the wrapper's
// contract: correlate every failure, log every server fault, leak nothing, and
// leave success completely untouched.
const core = vi.hoisted(() => ({ handleAiSummaryRequest: vi.fn() }))
vi.mock('./serverAiSummary', () => core)

const { runAiSummaryEndpoint } = await import('./serverAiSummaryEndpoint')

// Realistic sensitive material an exception near the AI call can carry.
const PROMPT = 'SUMMARISE_THIS_CONFIDENTIAL_LEGAL_TEXT'
const TOKEN = 'sk-ant-api03-SUPERSECRETVALUE'
const BEARER = `Bearer eyJhbGciOiJIUzI1NiJ9.SUPERSECRETJWT.sig`
const EMAIL = 'grower@example.com'
const VENDOR = 'Anthropic error: rate limit exceeded for account acct_9931'

const REQUEST: NormalizedRequest = {
  method: 'POST',
  contentType: 'application/json',
  authorization: BEARER,
  body: { capability: 'legal_update_summary', evidence: PROMPT, email: EMAIL },
}

const DEPS = { provider: null } as unknown as ServerAiSummaryDeps

const SUCCESS = {
  status: 200,
  body: {
    ok: true as const,
    sections: { draftSummary: 'd', possibleSignificance: 's', uncertainties: 'u', reviewQuestions: [], sourceReferences: [] },
    provenance: { provider: 'anthropic', model: 'claude-opus-4-8', generatedAt: '2026-07-14T00:00:00.000Z' },
    requiresHumanReview: true as const,
    label: 'AI DRAFT — NOT LEGAL ADVICE',
  },
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  core.handleAiSummaryRequest.mockReset()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

function loggedLines(): string[] {
  return errorSpy.mock.calls.map((c: unknown[]) => c[0] as string)
}

describe('misconfiguration (deps === null) — fail closed, correlated', () => {
  it('keeps the safe code, keeps the 503, and adds a requestId', async () => {
    const res = await runAiSummaryEndpoint(REQUEST, null, 'req-misconfig')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      ok: false,
      error: 'server_misconfigured',
      message: 'The service is not configured.',
      requestId: 'req-misconfig',
    })
  })

  it('logs one structured event carrying the same requestId', async () => {
    await runAiSummaryEndpoint(REQUEST, null, 'req-misconfig')

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const log = JSON.parse(loggedLines()[0]) as Record<string, unknown>
    expect(log.requestId).toBe('req-misconfig')
    expect(log.category).toBe('server_misconfigured')
    expect(log.status).toBe(503)
    expect(log.route).toBe('api/compliance/ai-summary')
  })

  it('never calls the core — no request is processed while misconfigured', async () => {
    await runAiSummaryEndpoint(REQUEST, null, 'req-misconfig')
    expect(core.handleAiSummaryRequest).not.toHaveBeenCalled()
  })
})

describe('thrown internal failure — the exception must not escape in any form', () => {
  const boom = () => {
    // Everything a real provider/Supabase exception can drag along with it.
    const e = new Error(`${VENDOR} | prompt=${PROMPT} | key=${TOKEN} | user=${EMAIL}`)
    e.stack = `Error: ${VENDOR}\n    at callProvider (/var/task/serverAiProvider.ts:88)\n    key=${TOKEN}`
    throw e
  }

  it('returns internal_error, a 500, and a requestId', async () => {
    core.handleAiSummaryRequest.mockImplementation(boom)

    const res = await runAiSummaryEndpoint(REQUEST, DEPS, 'req-boom')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: 'internal_error',
      message: 'An unexpected error occurred.',
      requestId: 'req-boom',
    })
  })

  it('calls console.error exactly ONCE', async () => {
    core.handleAiSummaryRequest.mockImplementation(boom)
    await runAiSummaryEndpoint(REQUEST, DEPS, 'req-boom')
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('the logged object carries the requestId and the safe category', async () => {
    core.handleAiSummaryRequest.mockImplementation(boom)
    await runAiSummaryEndpoint(REQUEST, DEPS, 'req-boom')

    const log = JSON.parse(loggedLines()[0]) as Record<string, unknown>
    expect(log.requestId).toBe('req-boom')
    expect(log.category).toBe('internal_error')
    expect(log.status).toBe(500)
    expect(log.method).toBe('post')
    expect(log.route).toBe('api/compliance/ai-summary')
  })

  it('the log contains NO prompt, token, JWT, vendor text, email, body or stack', async () => {
    core.handleAiSummaryRequest.mockImplementation(boom)
    await runAiSummaryEndpoint(REQUEST, DEPS, 'req-boom')

    const raw = loggedLines().join('\n')
    for (const secret of [
      PROMPT,
      TOKEN,
      BEARER,
      EMAIL,
      VENDOR,
      'acct_9931',
      'serverAiProvider.ts',   // stack frame
      'at callProvider',       // stack frame
      'legal_update_summary',  // request body field
      'eyJhbGciOiJIUzI1NiJ9',  // JWT header segment
    ]) {
      expect(raw, `log must not contain: ${secret}`).not.toContain(secret)
    }
  })

  it('the RESPONSE likewise contains none of it', async () => {
    core.handleAiSummaryRequest.mockImplementation(boom)
    const res = await runAiSummaryEndpoint(REQUEST, DEPS, 'req-boom')

    const raw = JSON.stringify(res.body)
    for (const secret of [PROMPT, TOKEN, BEARER, EMAIL, VENDOR, 'serverAiProvider.ts']) {
      expect(raw, `response must not contain: ${secret}`).not.toContain(secret)
    }
  })
})

describe('successful responses are unchanged', () => {
  it('passes the 200 body through byte-for-byte — no requestId, no added field', async () => {
    core.handleAiSummaryRequest.mockResolvedValue(SUCCESS)

    const res = await runAiSummaryEndpoint(REQUEST, DEPS, 'req-ok')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(SUCCESS.body)          // identical shape and values
    expect(res.body).not.toHaveProperty('requestId') // success is NOT altered
  })

  it('logs nothing on success', async () => {
    core.handleAiSummaryRequest.mockResolvedValue(SUCCESS)
    await runAiSummaryEndpoint(REQUEST, DEPS, 'req-ok')
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('core-returned failures', () => {
  it('a 4xx keeps its code, gains a requestId, and is NOT logged (caller error, not a fault)', async () => {
    core.handleAiSummaryRequest.mockResolvedValue({
      status: 403,
      body: { ok: false, error: 'forbidden', message: 'Admin role required.' },
    })

    const res = await runAiSummaryEndpoint(REQUEST, DEPS, 'req-403')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: 'forbidden', message: 'Admin role required.', requestId: 'req-403' })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('a 5xx (provider_error) IS logged — this is the AI outage we need to see', async () => {
    core.handleAiSummaryRequest.mockResolvedValue({
      status: 502,
      body: { ok: false, error: 'provider_error', message: 'The summary provider failed.' },
    })

    const res = await runAiSummaryEndpoint(REQUEST, DEPS, 'req-502')

    expect(res.status).toBe(502)
    expect(res.body).toHaveProperty('requestId', 'req-502')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const log = JSON.parse(loggedLines()[0]) as Record<string, unknown>
    expect(log.category).toBe('provider_error')
    expect(log.status).toBe(502)
  })
})

describe('correlation IDs', () => {
  it('are non-empty and DISTINCT between requests when defaulted', async () => {
    core.handleAiSummaryRequest.mockResolvedValue({
      status: 502,
      body: { ok: false, error: 'provider_error', message: 'x' },
    })

    const a = await runAiSummaryEndpoint(REQUEST, DEPS)
    const b = await runAiSummaryEndpoint(REQUEST, DEPS)

    const idA = (a.body as { requestId: string }).requestId
    const idB = (b.body as { requestId: string }).requestId

    expect(idA.length).toBeGreaterThan(15)
    expect(idB.length).toBeGreaterThan(15)
    expect(idA).not.toBe(idB)
  })

  it('the id in the response is the SAME id in the log — that pairing is the point', async () => {
    core.handleAiSummaryRequest.mockResolvedValue({
      status: 502,
      body: { ok: false, error: 'provider_error', message: 'x' },
    })

    const res = await runAiSummaryEndpoint(REQUEST, DEPS)

    const responseId = (res.body as { requestId: string }).requestId
    const log = JSON.parse(loggedLines()[0]) as Record<string, unknown>
    expect(log.requestId).toBe(responseId)
  })
})

// ─── Source sweep — the same invariants the existing AI boundary is held to ──
const SRC = Object.values(
  import.meta.glob('./serverAiSummaryEndpoint.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('endpoint source — on the AI boundary, so it inherits the boundary rules', () => {
  it('loaded', () => {
    expect(SRC.length).toBeGreaterThan(200)
  })

  it('never reads the exception, its message or its stack', () => {
    expect(SRC).not.toMatch(/catch\s*\(/)   // the catch binds NO variable at all
    expect(SRC).not.toMatch(/\.stack\b|\.message\b/)
  })

  it('writes nothing to the database and uses no browser storage or secret', () => {
    expect(SRC).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/)
    expect(SRC).not.toMatch(/localStorage|sessionStorage/)
    expect(SRC).not.toMatch(/import\.meta\.env|SERVICE_ROLE|service_role/)
  })
})
