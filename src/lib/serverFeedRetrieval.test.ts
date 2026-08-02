// Unit tests for the server-side feed-retrieval boundary.
//
// Every dependency is injected, so no test opens a socket or reaches Supabase.
// The focus is the gate sequence and, above all, the property that gives this
// endpoint its safety: the URL that gets fetched comes from the STORED source
// row and can never come from the request.

import { describe, it, expect, vi } from 'vitest'
import {
  handleFeedRetrieveRequest,
  validateFeedRetrieveBody,
  SUPPORTED_CAPABILITY,
  type NormalizedRequest,
  type ServerFeedRetrievalDeps,
} from './serverFeedRetrieval'
import type { RegulatorySource } from '../types'
import type { SourceRetrievalRecord } from './serverSourceRetrieval'
import {
  FEED_RETRIEVAL_GLOBAL_BUCKET_KEY,
  FEED_RETRIEVAL_CLIENT_BUCKET_PREFIX,
  FEED_RETRIEVAL_THROTTLE_RULES,
  feedRetrievalClientBucketKey,
} from './serverFeedRetrievalThrottle'

const NOW = '2026-08-02T12:00:00.000Z'
const STORED_URL = 'https://sukl.gov.cz/feed/'

const STORED_SOURCE: RegulatorySource = {
  id: 'src-1',
  name: 'SUKL Czech Republic',
  jurisdiction: 'CZ',
  sourceType: 'regulator',
  url: STORED_URL,
  isActive: true,
  monitoringMethod: 'rss',
  createdAt: '',
  updatedAt: '',
}

function retrieved(overrides: Partial<SourceRetrievalRecord> = {}): SourceRetrievalRecord {
  return {
    status: 'retrieved',
    requestedUrl: STORED_URL,
    finalUrl: STORED_URL,
    httpStatus: 200,
    contentType: 'application/rss+xml',
    byteLength: 42,
    contentFingerprint: 'a'.repeat(64),
    retrievedAt: NOW,
    redirectChain: [STORED_URL],
    reason: null,
    content: '<rss><channel/></rss>',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<ServerFeedRetrievalDeps> = {}): ServerFeedRetrievalDeps {
  return {
    authenticate: () => Promise.resolve(({ userId: 'user-1' })),
    getProfileRole: () => Promise.resolve('ddp_admin'),
    getRegulatorySource: () => Promise.resolve(STORED_SOURCE),
    reserveFeedRetrievalSlot: () => Promise.resolve(({ allowed: true })),
    retrieve: () => Promise.resolve(retrieved()),
    now: () => NOW,
    ...overrides,
  }
}

function request(body: unknown, overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: 'POST',
    contentType: 'application/json',
    authorization: 'Bearer token-abc',
    body,
    ...overrides,
  }
}

const validBody = { sourceId: 'src-1', capability: SUPPORTED_CAPABILITY }

describe('validateFeedRetrieveBody', () => {
  it('accepts the minimal valid body', () => {
    expect(validateFeedRetrieveBody(validBody)).toEqual({ ok: true, value: { sourceId: 'src-1' } })
  })

  it('parses a JSON string body', () => {
    expect(validateFeedRetrieveBody(JSON.stringify(validBody))).toEqual({ ok: true, value: { sourceId: 'src-1' } })
  })

  it('rejects a caller-supplied url outright rather than ignoring it', () => {
    // Rejecting is better than ignoring. A caller who sends `url` has a mistaken
    // model of what this endpoint does, and a silent 200 would confirm it.
    const result = validateFeedRetrieveBody({ ...validBody, url: 'https://evil.example.com/' })
    expect(result).toMatchObject({ ok: false, code: 'unknown_field' })
  })

  it.each([
    [{ sourceId: 'src-1' }, 'invalid_capability'],
    [{ sourceId: 'src-1', capability: 'something_else' }, 'invalid_capability'],
    [{ capability: SUPPORTED_CAPABILITY }, 'invalid_field'],
    [{ sourceId: '', capability: SUPPORTED_CAPABILITY }, 'invalid_field'],
    [{ sourceId: 42, capability: SUPPORTED_CAPABILITY }, 'invalid_field'],
    [{ sourceId: 'x'.repeat(201), capability: SUPPORTED_CAPABILITY }, 'invalid_field'],
  ])('rejects %j as %s', (body, code) => {
    expect(validateFeedRetrieveBody(body)).toMatchObject({ ok: false, code })
  })

  it('rejects a non-object and malformed JSON', () => {
    expect(validateFeedRetrieveBody('[1,2,3]')).toMatchObject({ ok: false, code: 'malformed_body' })
    expect(validateFeedRetrieveBody('{not json')).toMatchObject({ ok: false, code: 'malformed_body' })
  })

  it('rejects an oversized body as 413 material', () => {
    expect(validateFeedRetrieveBody('x'.repeat(5_000))).toMatchObject({ ok: false, code: 'oversized_request' })
  })
})

describe('handleFeedRetrieveRequest — gate sequence', () => {
  it('rejects a non-POST method', async () => {
    const result = await handleFeedRetrieveRequest(request(validBody, { method: 'GET' }), makeDeps())
    expect(result.status).toBe(405)
  })

  it('rejects a non-JSON content type', async () => {
    const result = await handleFeedRetrieveRequest(request(validBody, { contentType: 'text/plain' }), makeDeps())
    expect(result.status).toBe(415)
  })

  it.each([
    [null, 'no header'],
    ['token-abc', 'no Bearer prefix'],
    ['Bearer   ', 'empty token'],
  ] as const)('rejects %s (%s) as 401', async (authorization, why) => {
    const result = await handleFeedRetrieveRequest(request(validBody, { authorization }), makeDeps())
    expect(result.status, `expected 401 for ${why}`).toBe(401)
  })

  it('rejects an invalid token as 401 and never reaches the fetch', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ authenticate: () => Promise.resolve(null), retrieve }),
    )
    expect(result.status).toBe(401)
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('rejects a non-admin as 403 and never reaches the fetch', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ getProfileRole: () => Promise.resolve('farmer'), retrieve }),
    )
    expect(result.status).toBe(403)
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('does not spend an admin allowance on an unauthenticated request', async () => {
    // A throttle in front of the auth gate would hand any stranger a
    // denial-of-service against the whole feature.
    const reserve = vi.fn(async () => ({ allowed: true }))
    await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ authenticate: () => Promise.resolve(null), reserveFeedRetrievalSlot: reserve }),
    )
    expect(reserve).not.toHaveBeenCalled()
  })

  it('does not spend an allowance on a malformed body', async () => {
    const reserve = vi.fn(async () => ({ allowed: true }))
    await handleFeedRetrieveRequest(
      request({ nonsense: true }),
      makeDeps({ reserveFeedRetrievalSlot: reserve }),
    )
    expect(reserve).not.toHaveBeenCalled()
  })
})

describe('handleFeedRetrieveRequest — the target is always the stored URL', () => {
  it('fetches the stored source URL', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(request(validBody), makeDeps({ retrieve }))
    expect(result.status).toBe(200)
    expect(retrieve).toHaveBeenCalledWith({
      url: STORED_URL,
      allowedHosts: ['sukl.gov.cz'],
      retrievedAt: NOW,
    })
  })

  it('allowlists ONLY the stored host, so a redirect cannot land elsewhere', async () => {
    const seen: string[][] = []
    const retrieve: ServerFeedRetrievalDeps['retrieve'] = input => {
      seen.push(input.allowedHosts)
      return Promise.resolve(retrieved())
    }
    await handleFeedRetrieveRequest(request(validBody), makeDeps({ retrieve }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(['sukl.gov.cz'])
  })

  it('returns 404 for an unknown source and never fetches', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ getRegulatorySource: () => Promise.resolve(null), retrieve }),
    )
    expect(result.status).toBe(404)
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('fails closed to 404 when the source read throws', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({
        getRegulatorySource: () => Promise.reject(new Error('db down')),
        retrieve,
      }),
    )
    expect(result.status).toBe(404)
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('refuses a disabled source, so the registry toggle is not decorative', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({
        getRegulatorySource: () => Promise.resolve(({ ...STORED_SOURCE, isActive: false })),
        retrieve,
      }),
    )
    expect(result.status).toBe(422)
    expect(result.body).toMatchObject({ error: 'source_disabled' })
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('refuses a stored URL that is not a URL at all', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({
        getRegulatorySource: () => Promise.resolve(({ ...STORED_SOURCE, url: 'not a url' })),
        retrieve,
      }),
    )
    expect(result.status).toBe(422)
    expect(retrieve).not.toHaveBeenCalled()
  })
})

describe('handleFeedRetrieveRequest — throttle', () => {
  it('returns 429 with a retry window when refused', async () => {
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ reserveFeedRetrievalSlot: async () => ({ allowed: false, windowSeconds: 3_600 }) }),
    )
    expect(result.status).toBe(429)
    expect(result.body).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 3_600 })
  })

  it('never tells a refused caller to retry immediately', async () => {
    // A refusal that names no window, or names 0, is a throttle that is a no-op.
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ reserveFeedRetrievalSlot: async () => ({ allowed: false }) }),
    )
    expect(result.status).toBe(429)
    const body = result.body as { retryAfterSeconds?: number }
    expect(body.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('fails CLOSED with 503 when the ledger is unreachable', async () => {
    const retrieve = vi.fn(async () => retrieved())
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({
        reserveFeedRetrievalSlot: () => Promise.reject(new Error('ledger unreachable')),
        retrieve,
      }),
    )
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ error: 'throttle_unavailable' })
    // The decisive assertion: an unreachable ledger must not become an
    // unmetered fetch.
    expect(retrieve).not.toHaveBeenCalled()
  })
})

describe('handleFeedRetrieveRequest — outcome mapping', () => {
  it('returns the retrieval record on success', async () => {
    const result = await handleFeedRetrieveRequest(request(validBody), makeDeps())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      retrieval: { status: 'retrieved', contentFingerprint: 'a'.repeat(64), content: '<rss><channel/></rss>' },
      source: { id: 'src-1', url: STORED_URL },
    })
  })

  it.each([
    ['rejected_not_allowlisted', 422],
    ['rejected_private_network', 422],
    ['rejected_resolved_private', 422],
    ['rejected_content_type', 422],
    ['too_large', 422],
    ['too_many_redirects', 422],
    ['http_error', 502],
    ['fetch_failed', 502],
    ['timeout', 504],
  ] as const)('maps %s to %i', async (status, expected) => {
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ retrieve: async () => retrieved({ status, reason: 'because', content: null }) }),
    )
    expect(result.status).toBe(expected)
    expect(result.body).toMatchObject({ ok: false, error: status })
  })

  it('distinguishes a policy refusal from an upstream fault', async () => {
    // The recurring defect in this codebase's AI client is mapping every
    // non-OK status to "the provider failed", which sends an operator to the
    // wrong place. A 4xx-class policy refusal must never read as a 5xx.
    const policyRefusal = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ retrieve: async () => retrieved({ status: 'rejected_not_allowlisted', content: null }) }),
    )
    const upstreamFault = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({ retrieve: async () => retrieved({ status: 'http_error', content: null }) }),
    )
    expect(policyRefusal.status).toBeLessThan(500)
    expect(upstreamFault.status).toBeGreaterThanOrEqual(500)
  })

  it('turns a throwing retriever into a safe 502 rather than an unhandled error', async () => {
    const result = await handleFeedRetrieveRequest(
      request(validBody),
      makeDeps({
        retrieve: () => Promise.reject(new Error('socket exploded with secret-token-in-message')),
      }),
    )
    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).not.toContain('secret-token')
  })
})

describe('throttle policy constants', () => {
  it('satisfies migration 36 CHECK (length(bucket_key) BETWEEN 16 AND 128)', () => {
    // Measured, not counted by eye. A six-character global key once took a
    // production endpoint offline in this repository.
    expect(FEED_RETRIEVAL_GLOBAL_BUCKET_KEY.length).toBeGreaterThanOrEqual(16)
    expect(FEED_RETRIEVAL_GLOBAL_BUCKET_KEY.length).toBeLessThanOrEqual(128)

    const clientKey = feedRetrievalClientBucketKey('b'.repeat(64))
    expect(clientKey.length).toBeGreaterThanOrEqual(16)
    expect(clientKey.length).toBeLessThanOrEqual(128)
  })

  it('cannot collide with the intake or AI-summary buckets', () => {
    // Intake client buckets are pure hex; the two other global keys are these.
    expect(FEED_RETRIEVAL_GLOBAL_BUCKET_KEY).not.toBe('global-intake-ceiling')
    expect(FEED_RETRIEVAL_GLOBAL_BUCKET_KEY).not.toBe('ai-summary-daily-ceiling')
    expect(FEED_RETRIEVAL_GLOBAL_BUCKET_KEY).not.toContain(':')
    expect(FEED_RETRIEVAL_CLIENT_BUCKET_PREFIX).toContain(':')
    expect(FEED_RETRIEVAL_CLIENT_BUCKET_PREFIX).not.toBe('ai-summary:')
    expect(feedRetrievalClientBucketKey('c'.repeat(64))).not.toMatch(/^[0-9a-f]+$/)
  })

  it('throws on a malformed digest rather than building a key the CHECK rejects', () => {
    expect(() => feedRetrievalClientBucketKey('short')).toThrow()
    expect(() => feedRetrievalClientBucketKey('z'.repeat(64))).toThrow()
  })

  it('declares a global rule, which is the ceiling that actually bounds fetching', () => {
    expect(FEED_RETRIEVAL_THROTTLE_RULES.some(rule => rule.scope === 'global')).toBe(true)
    for (const rule of FEED_RETRIEVAL_THROTTLE_RULES) {
      expect(rule.max).toBeGreaterThan(0)
      expect(rule.windowSeconds).toBeGreaterThan(0)
    }
  })
})
