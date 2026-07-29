import { describe, it, expect } from 'vitest'
import {
  handleAccessRequest,
  validateSubmission,
  normaliseSubmission,
  THROTTLE_RULES,
  GLOBAL_BUCKET_KEY,
  type IntakeDeps,
  type ThrottleReservation,
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

/**
 * In-memory stand-in for public.reserve_public_intake_slot() — the SAME
 * algorithm the SQL function implements: RESERVE first, then evaluate, so a
 * caller's own reservation is counted by its own check. Because JavaScript runs
 * this synchronously between awaits, it is genuinely atomic here, which is what
 * lets the concurrency test below assert the ceiling rather than a schedule.
 *
 * The real serialisation is done by an advisory lock in the database; that half
 * is proven separately, on real Postgres with real parallel connections, in
 * scripts/disposable-pg/migration-36-throttle-concurrency.test.mjs.
 */
function reserveAgainst(rec: Recorder, clientBucketKey: string, at: Date): ThrottleReservation {
  rec.attempts.push({ bucketKey: clientBucketKey, at })
  rec.attempts.push({ bucketKey: GLOBAL_BUCKET_KEY, at })

  for (const rule of THROTTLE_RULES) {
    const key = rule.scope === 'global' ? GLOBAL_BUCKET_KEY : clientBucketKey
    const since = new Date(at.getTime() - rule.windowSeconds * 1000)
    const count = rec.attempts.filter(a => a.bucketKey === key && a.at > since).length
    // Strictly greater: the reservation above is already included in `count`.
    if (count > rule.max) return { allowed: false, windowSeconds: rule.windowSeconds }
  }
  return { allowed: true }
}

function deps(overrides: Partial<IntakeDeps> = {}, seedAttempts: Array<{ bucketKey: string; at: Date }> = []) {
  const rec: Recorder = { attempts: [...seedAttempts], inserted: [] }
  const base: IntakeDeps = {
    now: () => T0,
    bucketKeyForClient: () => 'a'.repeat(64),
    reserveThrottleSlot(clientBucketKey) {
      return Promise.resolve(reserveAgainst(rec, clientBucketKey, T0))
    },
    hasOpenRequestForEmail: () => Promise.resolve(false),
    insertRequest(input) {
      rec.inserted.push(input)
      return Promise.resolve()
    },
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
    // An unreachable ledger must never read as "no attempts yet".
    const { deps: d, rec } = deps({
      reserveThrottleSlot: () => Promise.reject(new Error('connection failure')),
    })
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(503)
    expect(rec.inserted).toHaveLength(0)
  })

  it('fails closed on a refusal that names no window, rather than saying "retry now"', async () => {
    // A malformed reply must not become retryAfterSeconds: 0.
    const { deps: d } = deps({
      reserveThrottleSlot: () => Promise.resolve({ allowed: false }),
    })
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(429)
    expect(out.body).toMatchObject({ retryAfterSeconds: Math.max(...THROTTLE_RULES.map(rule => rule.windowSeconds)) })
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

  it('checks every rule, not just the first', async () => {
    // A caller inside the 10-minute allowance can still be outside the daily one.
    const { deps: d } = deps({}, Array.from({ length: 10 }, (_, i) => ({
      bucketKey: CLIENT, at: new Date(T0.getTime() - (i + 1) * 3_600_000),
    })))
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(429)
    expect(out.body).toMatchObject({ retryAfterSeconds: 86_400 })
  })

  it('the rule set has both a per-client and a global scope', () => {
    // A regression here would silently remove a whole class of protection.
    expect(THROTTLE_RULES.some(rule => rule.scope === 'client')).toBe(true)
    expect(THROTTLE_RULES.some(rule => rule.scope === 'global')).toBe(true)
  })
})

describe('duplicate suppression', () => {
  it('reports success without inserting a second open request', async () => {
    const { deps: d, rec } = deps({ hasOpenRequestForEmail: () => Promise.resolve(true) })
    const out = await handleAccessRequest('POST', VALID, d)

    // Reported as SUCCESS deliberately: telling an anonymous caller "that address
    // already has a request" would make the endpoint an oracle for which
    // suppliers have applied.
    expect(out.status).toBe(200)
    expect(rec.inserted).toHaveLength(0)
  })

  it('still consumes the caller\'s allowance', async () => {
    // Otherwise re-submitting one address would be an unlimited free probe.
    const { deps: d, rec } = deps({ hasOpenRequestForEmail: () => Promise.resolve(true) })
    await handleAccessRequest('POST', VALID, d)
    expect(rec.attempts).toHaveLength(2)
  })
})

describe('failures do not leak driver detail', () => {
  it('an insert failure returns a generic message', async () => {
    const { deps: d } = deps({
      insertRequest: () => Promise.reject(
        new Error('duplicate key value violates unique constraint "farmer_access_requests_pkey"'),
      ),
    })
    const out = await handleAccessRequest('POST', VALID, d)
    expect(out.status).toBe(500)
    expect(JSON.stringify(out.body)).not.toMatch(/constraint|pkey|duplicate key/)
  })
})

// ─── Codex P1: the throttle must bound CONCURRENT requests, not just serial ──
//
// The first cut counted attempts in one step and recorded them in a later one.
// Every test above drives requests sequentially, so none of them could see the
// race: with a parallel burst, all callers finish counting before any records,
// every one passes, and the ceiling is blown. Vercel functions share no lock, so
// the fix had to move both halves into one database operation
// (public.reserve_public_intake_slot, migration 36).
//
// These tests run the requests genuinely concurrently with Promise.all.

describe('concurrent bursts cannot exceed the ceiling', () => {
  const CLIENT_KEY = 'a'.repeat(64)

  /** Deps sharing ONE ledger across every concurrent call. */
  function sharedDeps(reserve: (rec: Recorder, key: string) => Promise<ThrottleReservation>) {
    const rec: Recorder = { attempts: [], inserted: [] }
    const intakeDeps: IntakeDeps = {
      now: () => T0,
      bucketKeyForClient: () => CLIENT_KEY,
      reserveThrottleSlot: key => reserve(rec, key),
      hasOpenRequestForEmail: () => Promise.resolve(false),
      insertRequest(input) {
        rec.inserted.push(input)
        return Promise.resolve()
      },
    }
    return { deps: intakeDeps, rec }
  }

  /** The atomic reservation: reserve, then evaluate. What ships now. */
  function atomicReserve(rec: Recorder, key: string): Promise<ThrottleReservation> {
    return Promise.resolve(reserveAgainst(rec, key, T0))
  }

  /**
   * The OLD check-then-act shape, reproduced exactly: count every rule first,
   * yielding to the event loop between calls the way a real network round trip
   * does, and only then record. This is the defect, kept as an executable
   * demonstration so the fix cannot silently regress into it.
   */
  async function checkThenActReserve(rec: Recorder, key: string): Promise<ThrottleReservation> {
    for (const rule of THROTTLE_RULES) {
      const bucket = rule.scope === 'global' ? GLOBAL_BUCKET_KEY : key
      const since = new Date(T0.getTime() - rule.windowSeconds * 1000)
      await Promise.resolve() // the await that lets every other caller interleave
      const count = rec.attempts.filter(a => a.bucketKey === bucket && a.at > since).length
      if (count >= rule.max) return { allowed: false, windowSeconds: rule.windowSeconds }
    }
    await Promise.resolve()
    rec.attempts.push({ bucketKey: key, at: T0 })
    rec.attempts.push({ bucketKey: GLOBAL_BUCKET_KEY, at: T0 })
    return { allowed: true }
  }

  const PER_CLIENT_MAX = THROTTLE_RULES.find(rule => rule.scope === 'client')!.max

  it('DEMONSTRATES the defect: check-then-act admits a whole parallel burst', async () => {
    const { deps: burstDeps, rec } = sharedDeps(checkThenActReserve)

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => handleAccessRequest('POST', VALID, burstDeps)),
    )

    const accepted = outcomes.filter(o => o.status === 200).length
    // Every one of the 20 gets in, against a ceiling of 3.
    expect(accepted).toBeGreaterThan(PER_CLIENT_MAX)
    expect(rec.inserted.length).toBeGreaterThan(PER_CLIENT_MAX)
  })

  it('the atomic reservation holds the per-client ceiling under a parallel burst', async () => {
    const { deps: burstDeps, rec } = sharedDeps(atomicReserve)

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => handleAccessRequest('POST', VALID, burstDeps)),
    )

    const accepted = outcomes.filter(o => o.status === 200).length
    const refused = outcomes.filter(o => o.status === 429).length

    expect(accepted).toBe(PER_CLIENT_MAX)
    expect(refused).toBe(20 - PER_CLIENT_MAX)
    expect(rec.inserted).toHaveLength(PER_CLIENT_MAX)
  })

  it('holds the GLOBAL ceiling when every caller is a different client', async () => {
    const globalRule = THROTTLE_RULES.find(rule => rule.scope === 'global')!
    const rec: Recorder = { attempts: [], inserted: [] }

    // Each request carries its own client bucket, so no per-client rule can fire
    // — only the global ceiling stands between this burst and the queue.
    const outcomes = await Promise.all(
      Array.from({ length: globalRule.max + 25 }, (_, index) => {
        const bucketKey = String(index).padStart(64, '0')
        const callerDeps: IntakeDeps = {
          now: () => T0,
          bucketKeyForClient: () => bucketKey,
          reserveThrottleSlot: reserveKey => Promise.resolve(reserveAgainst(rec, reserveKey, T0)),
          hasOpenRequestForEmail: () => Promise.resolve(false),
          insertRequest(input) {
            rec.inserted.push(input)
            return Promise.resolve()
          },
        }
        return handleAccessRequest('POST', VALID, callerDeps)
      }),
    )

    expect(outcomes.filter(o => o.status === 200)).toHaveLength(globalRule.max)
    expect(rec.inserted).toHaveLength(globalRule.max)
  })

  it('a refused caller still consumed its reservation', async () => {
    // Otherwise a flood would reset its own allowance and never be bounded.
    const { deps: burstDeps, rec } = sharedDeps(atomicReserve)
    await Promise.all(Array.from({ length: 10 }, () => handleAccessRequest('POST', VALID, burstDeps)))
    expect(rec.attempts.filter(a => a.bucketKey === CLIENT_KEY)).toHaveLength(10)
  })
})

describe('the global bucket key is storable', () => {
  it('satisfies migration 36 length CHECK (16..128)', () => {
    // The ledger declares CHECK (length(bucket_key) BETWEEN 16 AND 128). The
    // original 'global' was SIX characters, so every global reservation was
    // rejected by the constraint and — because a ledger failure fails closed —
    // applying migration 36 would have returned 503 for every submission. No
    // mock-based test could catch it; this one asserts the contract directly.
    expect(GLOBAL_BUCKET_KEY.length).toBeGreaterThanOrEqual(16)
    expect(GLOBAL_BUCKET_KEY.length).toBeLessThanOrEqual(128)
  })

  it('cannot collide with a client bucket, which is always sha256 hex', () => {
    expect(GLOBAL_BUCKET_KEY).not.toMatch(/^[0-9a-f]{64}$/)
  })
})
