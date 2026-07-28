import { describe, it, expect } from 'vitest'
import {
  handleAccessRequest,
  validateSubmission,
  normaliseSubmission,
  firstExceededRule,
  THROTTLE_RULES,
  GLOBAL_BUCKET_KEY,
  type IntakeDeps,
} from './serverAccessRequestIntake'

// ─── Audit R5: the public intake must be bounded ────────────────────────────
//
// `farmer_access_requests: public submit` was the only anon-satisfiable write
// policy in production, reached browser -> Supabase without traversing Vercel —
// so migration 34's own "rate limiting belongs at the edge" note described a
// mitigation that could not reach the path. This handler is what makes a throttle
// possible; these tests are what make it real.

const VALID = {
  fullName: 'Somchai Farmer',
  email: 'somchai@example.com',
  phone: '+66 81 234 5678',
  province: 'Buriram',
  position: 'Owner',
  preferredLanguage: 'th' as const,
  note: 'Interested in supplying.',
}

const T0 = new Date('2026-07-28T12:00:00.000Z')

interface Recorder {
  attempts: Array<{ bucketKey: string; at: Date }>
  inserted: unknown[]
}

function deps(overrides: Partial<IntakeDeps> = {}, seedAttempts: Array<{ bucketKey: string; at: Date }> = []) {
  const rec: Recorder = { attempts: [...seedAttempts], inserted: [] }
  const base: IntakeDeps = {
    now: () => T0,
    bucketKeyForClient: () => 'a'.repeat(64),
    async countAttempts(bucketKey, since) {
      return rec.attempts.filter(a => a.bucketKey === bucketKey && a.at > since).length
    },
    async recordAttempt(bucketKey) {
      rec.attempts.push({ bucketKey, at: T0 })
    },
    async hasOpenRequestForEmail() { return false },
    async insertRequest(input) { rec.inserted.push(input) },
    ...overrides,
  }
  return { deps: base, rec }
}

describe('method and configuration', () => {
  it('rejects anything but POST', async () => {
    const { deps: d } = deps()
    expect((await handleAccessRequest('GET', {}, d)).status).toBe(405)
    expect((await handleAccessRequest('PUT', {}, d)).status).toBe(405)
  })

  it('fails CLOSED when the function is not configured', async () => {
    // The alternative — accepting the submission some other way — would restore
    // the unbounded path this endpoint exists to close.
    const out = await handleAccessRequest('POST', VALID, null)
    expect(out.status).toBe(503)
    expect(out.body).toEqual({ ok: false, error: 'The request form is not available yet.' })
  })

  it('fails closed when the client cannot be identified', async () => {
    // No client identity means no throttle is possible.
    const { deps: d, rec } = deps({ bucketKeyForClient: () => null })
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(503)
    expect(rec.inserted).toHaveLength(0)
  })

  it('fails closed when the throttle cannot be evaluated', async () => {
    // An unreadable ledger must never read as "no attempts yet".
    const { deps: d, rec } = deps({
      async countAttempts() { throw new Error('connection failure') },
    })
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(503)
    expect(rec.inserted).toHaveLength(0)
  })
})

describe('validation mirrors the migration-34 CHECK constraints', () => {
  it('accepts a valid submission', () => {
    expect(validateSubmission(VALID)).toBeNull()
  })

  const bad: Array<[string, Record<string, unknown>]> = [
    ['fullName', { fullName: '' }],
    ['fullName', { fullName: 'x'.repeat(121) }],
    ['email', { email: 'not-an-email' }],
    ['email', { email: 'a@b' }],
    ['email', { email: `${'x'.repeat(250)}@example.com` }],
    ['phone', { phone: '123' }],
    ['phone', { phone: '1'.repeat(41) }],
    ['province', { province: 'x'.repeat(81) }],
    ['position', { position: 'x'.repeat(61) }],
    ['preferredLanguage', { preferredLanguage: 'fr' }],
    ['note', { note: 'x'.repeat(2001) }],
  ]

  for (const [field, patch] of bad) {
    it(`rejects a bad ${field}: ${JSON.stringify(patch).slice(0, 40)}`, () => {
      expect(validateSubmission({ ...VALID, ...patch })).toBe(field)
    })
  }

  it('reports the offending field to the caller', async () => {
    const { deps: d } = deps()
    const out = await handleAccessRequest('POST', { ...VALID, phone: '1' }, d)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ ok: false, field: 'phone' })
  })

  it('rejects a non-object body', async () => {
    const { deps: d } = deps()
    expect((await handleAccessRequest('POST', 'a string', d)).status).toBe(400)
    expect((await handleAccessRequest('POST', ['a', 'list'], d)).status).toBe(400)
    expect((await handleAccessRequest('POST', null, d)).status).toBe(400)
  })

  it('trims before validating, so whitespace is not a valid name', () => {
    expect(normaliseSubmission({ ...VALID, fullName: '   ' }).fullName).toBe('')
    expect(validateSubmission({ ...VALID, fullName: '   ' })).toBe('fullName')
  })

  it('defaults an unknown language to en rather than failing the insert', () => {
    expect(normaliseSubmission({ ...VALID, preferredLanguage: undefined }).preferredLanguage).toBe('en')
  })
})

describe('throttling', () => {
  const CLIENT = 'a'.repeat(64)

  it('accepts a first submission and records both buckets', async () => {
    const { deps: d, rec } = deps()
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(200)
    expect(rec.inserted).toHaveLength(1)
    // Per-client AND global, so a distributed flood is still bounded.
    expect(rec.attempts.map(a => a.bucketKey)).toEqual([CLIENT, GLOBAL_BUCKET_KEY])
  })

  it('refuses once the per-client short window is full', async () => {
    const recent = Array.from({ length: 3 }, () => ({
      bucketKey: CLIENT, at: new Date(T0.getTime() - 60_000),
    }))
    const { deps: d, rec } = deps({}, recent)
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(429)
    expect(out.body).toMatchObject({ retryAfterSeconds: 600 })
    expect(rec.inserted).toHaveLength(0)
  })

  it('releases the bucket once attempts age out of the window', async () => {
    // Attempts older than the window must not count, or a client would be
    // throttled forever after three submissions.
    const old = Array.from({ length: 3 }, () => ({
      bucketKey: CLIENT, at: new Date(T0.getTime() - 3 * 3_600_000),
    }))
    const { deps: d } = deps({}, old)
    expect((await handleAccessRequest('POST', VALID, d)).status).toBe(200)
  })

  it('applies the daily window even when the short one passes', async () => {
    // 10 attempts spread over the day: none within 10 minutes, so a
    // short-circuiting check would wave this through.
    const spread = Array.from({ length: 10 }, (_, i) => ({
      bucketKey: CLIENT, at: new Date(T0.getTime() - (i + 1) * 3_600_000),
    }))
    const { deps: d } = deps({}, spread)
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(429)
    expect(out.body).toMatchObject({ retryAfterSeconds: 86_400 })
  })

  it('bounds a distributed flood through the global window', async () => {
    // Every attempt from a DIFFERENT client, so no per-client rule fires.
    const flood = Array.from({ length: 60 }, (_, i) => ({
      bucketKey: GLOBAL_BUCKET_KEY, at: new Date(T0.getTime() - i * 1_000),
    }))
    const { deps: d, rec } = deps({}, flood)
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(429)
    expect(rec.inserted).toHaveLength(0)
  })

  it('one client cannot exhaust another client\'s allowance', async () => {
    const other = Array.from({ length: 3 }, () => ({
      bucketKey: 'b'.repeat(64), at: new Date(T0.getTime() - 60_000),
    }))
    const { deps: d } = deps({}, other)
    expect((await handleAccessRequest('POST', VALID, d)).status).toBe(200)
  })

  it('firstExceededRule checks every rule, not just the first', async () => {
    const { deps: d } = deps({}, Array.from({ length: 10 }, (_, i) => ({
      bucketKey: CLIENT, at: new Date(T0.getTime() - (i + 1) * 3_600_000),
    })))
    const hit = await firstExceededRule(d, CLIENT)
    expect(hit).toEqual({ windowSeconds: 86_400 })
  })

  it('the rule set has both a per-client and a global scope', () => {
    // A regression here would silently remove a whole class of protection.
    expect(THROTTLE_RULES.some(r => r.scope === 'client')).toBe(true)
    expect(THROTTLE_RULES.some(r => r.scope === 'global')).toBe(true)
  })
})

describe('duplicate suppression', () => {
  it('reports success without inserting a second open request', async () => {
    const { deps: d, rec } = deps({ async hasOpenRequestForEmail() { return true } })
    const out = await handleAccessRequest('POST', VALID, d)

    // Reported as SUCCESS deliberately: telling an anonymous caller "that address
    // already has a request" would make the endpoint an oracle for which
    // suppliers have applied.
    expect(out.status).toBe(200)
    expect(rec.inserted).toHaveLength(0)
  })

  it('still consumes the caller\'s allowance', async () => {
    // Otherwise re-submitting one address would be an unlimited free probe.
    const { deps: d, rec } = deps({ async hasOpenRequestForEmail() { return true } })
    await handleAccessRequest('POST', VALID, d)
    expect(rec.attempts).toHaveLength(2)
  })
})

describe('failures do not leak driver detail', () => {
  it('an insert failure returns a generic message', async () => {
    const { deps: d } = deps({
      async insertRequest() {
        throw new Error('duplicate key value violates unique constraint "farmer_access_requests_pkey"')
      },
    })
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(500)
    expect(JSON.stringify(out.body)).not.toMatch(/constraint|pkey|duplicate key/)
  })
})
