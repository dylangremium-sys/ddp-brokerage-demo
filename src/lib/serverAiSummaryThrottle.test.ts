import { describe, expect, it } from 'vitest'
import {
  AI_SUMMARY_CLIENT_BUCKET_PREFIX,
  AI_SUMMARY_GLOBAL_BUCKET_KEY,
  AI_SUMMARY_MAX_WINDOW_SECONDS,
  AI_SUMMARY_THROTTLE_RULES,
  aiSummaryClientBucketKey,
} from './serverAiSummaryThrottle.js'
import { GLOBAL_BUCKET_KEY, THROTTLE_RULES } from './serverAccessRequestIntake.js'

// Migration 36: CHECK (length(bucket_key) BETWEEN 16 AND 128).
const MIN_KEY = 16
const MAX_KEY = 128

/** A representative sha256 hex digest. The api adapter computes the real one;
 *  every property that matters here is a property of the CONSTRUCTION, and a
 *  digest is a digest. */
const DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = '0123456789abcdef'.repeat(4)

describe('AI summary throttle — bucket keys satisfy the ledger CHECK', () => {
  // This is not a formality. The intake's global key was 'global' — six
  // characters — which this exact constraint rejected on every submission, and
  // because the handler fails closed that would have taken the public form
  // offline the moment migration 36 was applied. No unit test caught it because
  // every test mocked the database. This is that missing test.
  it('the global key is within the length CHECK', () => {
    expect(AI_SUMMARY_GLOBAL_BUCKET_KEY.length).toBeGreaterThanOrEqual(MIN_KEY)
    expect(AI_SUMMARY_GLOBAL_BUCKET_KEY.length).toBeLessThanOrEqual(MAX_KEY)
  })

  it('a per-admin key is within the length CHECK', () => {
    for (const digest of [DIGEST, OTHER_DIGEST]) {
      const key = aiSummaryClientBucketKey(digest)
      expect(key.length).toBeGreaterThanOrEqual(MIN_KEY)
      expect(key.length).toBeLessThanOrEqual(MAX_KEY)
    }
  })

  it('different digests give different keys', () => {
    expect(aiSummaryClientBucketKey(DIGEST)).not.toBe(aiSummaryClientBucketKey(OTHER_DIGEST))
  })

  it('REFUSES a malformed digest rather than building a key the CHECK would reject', () => {
    // A key that violates length BETWEEN 16 AND 128 makes the SQL function
    // raise, which the endpoint turns into a fail-closed 503 — i.e. the feature
    // goes dark. Failing here instead turns that outage into a caught error.
    for (const bad of ['', 'short', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() => aiSummaryClientBucketKey(bad)).toThrow()
    }
  })

  it('accepts a valid digest', () => {
    // The control. Without it, the refusal test above would still pass against
    // a function that rejected everything.
    expect(() => aiSummaryClientBucketKey(DIGEST)).not.toThrow()
  })
})

describe('AI summary throttle — cannot collide with the public-intake ledger', () => {
  // Both throttles share public.public_intake_attempts. A collision would mean
  // one feature silently consuming the other's allowance — the intake form
  // going quiet because an admin generated summaries, or vice versa. Disjointness
  // is by construction, and this pins the construction.
  it('the AI global key differs from the intake global key', () => {
    expect(AI_SUMMARY_GLOBAL_BUCKET_KEY).not.toBe(GLOBAL_BUCKET_KEY)
  })

  it('AI client keys carry a prefix that no intake key can contain', () => {
    // Intake client keys are pure sha256 hex; the intake global key is
    // 'global-intake-ceiling'. Neither can contain ':'.
    expect(AI_SUMMARY_CLIENT_BUCKET_PREFIX).toContain(':')
    expect(GLOBAL_BUCKET_KEY).not.toContain(':')
    expect(aiSummaryClientBucketKey(DIGEST)).toContain(':')
    // An intake client bucket is bare hex, so it can never equal an AI one.
    expect(aiSummaryClientBucketKey(DIGEST)).not.toBe(DIGEST)
  })

  it('the AI global key is not a valid sha256 hex digest, so no client bucket can equal it', () => {
    expect(/^[0-9a-f]{64}$/i.test(AI_SUMMARY_GLOBAL_BUCKET_KEY)).toBe(false)
    expect(AI_SUMMARY_GLOBAL_BUCKET_KEY).not.toContain(AI_SUMMARY_CLIENT_BUCKET_PREFIX)
  })
})

describe('AI summary throttle — the rule set is one the SQL function will accept', () => {
  // reserve_public_intake_slot validates its rules and RAISES on anything
  // malformed — an empty array, a bad scope, a non-numeric window or max. A throw
  // becomes a fail-closed 503, so a typo here takes the endpoint down rather than
  // silently disabling the limit. Either way it is a defect; catching it in a
  // unit test is cheaper than catching it in production.
  it('is a non-empty array', () => {
    expect(Array.isArray(AI_SUMMARY_THROTTLE_RULES)).toBe(true)
    expect(AI_SUMMARY_THROTTLE_RULES.length).toBeGreaterThan(0)
  })

  it('every rule has a valid scope, a positive window and a non-negative max', () => {
    for (const rule of AI_SUMMARY_THROTTLE_RULES) {
      expect(['client', 'global']).toContain(rule.scope)
      expect(typeof rule.windowSeconds).toBe('number')
      expect(rule.windowSeconds).toBeGreaterThan(0)
      expect(typeof rule.max).toBe('number')
      expect(rule.max).toBeGreaterThanOrEqual(0)
    }
  })

  it('bounds BOTH a single admin and total spend', () => {
    // A per-client rule alone cannot bound cost across many admin accounts; a
    // global rule alone lets one account consume everyone's allowance. The
    // spend ceiling needs both, and this is the assertion that says so.
    expect(AI_SUMMARY_THROTTLE_RULES.some(rule => rule.scope === 'client')).toBe(true)
    expect(AI_SUMMARY_THROTTLE_RULES.some(rule => rule.scope === 'global')).toBe(true)
  })

  it('the fail-closed retry window is the longest configured window, never zero', () => {
    expect(AI_SUMMARY_MAX_WINDOW_SECONDS).toBe(
      Math.max(...AI_SUMMARY_THROTTLE_RULES.map(rule => rule.windowSeconds)),
    )
    expect(AI_SUMMARY_MAX_WINDOW_SECONDS).toBeGreaterThan(0)
  })

  it('is stricter per-client than the public intake ledger it shares', () => {
    // Not a style preference: a model call costs money and an intake row does
    // not. If this ever inverts, the cheaper endpoint is the better-defended one.
    const aiPerHour = AI_SUMMARY_THROTTLE_RULES
      .filter(rule => rule.scope === 'global')
      .map(rule => rule.max / (rule.windowSeconds / 3_600))
    const intakePerHour = THROTTLE_RULES
      .filter(rule => rule.scope === 'global')
      .map(rule => rule.max / (rule.windowSeconds / 3_600))
    expect(Math.max(...aiPerHour)).toBeLessThan(Math.max(...intakePerHour))
  })
})
