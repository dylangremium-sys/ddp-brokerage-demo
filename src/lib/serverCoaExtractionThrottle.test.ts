import { describe, it, expect } from 'vitest'
import {
  COA_EXTRACTION_CLIENT_BUCKET_PREFIX,
  COA_EXTRACTION_GLOBAL_BUCKET_KEY,
  COA_EXTRACTION_MAX_WINDOW_SECONDS,
  COA_EXTRACTION_THROTTLE_RULES,
  coaExtractionClientBucketKey,
} from './serverCoaExtractionThrottle'
import {
  AI_SUMMARY_CLIENT_BUCKET_PREFIX,
  AI_SUMMARY_GLOBAL_BUCKET_KEY,
} from './serverAiSummaryThrottle'

// ─── The COA-extraction throttle, tested for the properties that bite ────────
//
// Not "does the constant equal the constant". These assert the two things that
// have actually gone wrong in this repository: a bucket key outside migration
// 36's length CHECK (which took the AI-summary form down in production, because
// a rejected reservation raises and the handler fails closed), and a key that
// collides with another feature's bucket in the SHARED public_intake_attempts
// ledger — which would make two unrelated features count against each other.

const DIGEST = 'a'.repeat(64)

/** Migration 36: CHECK (length(bucket_key) BETWEEN 16 AND 128). */
const MIN_KEY = 16
const MAX_KEY = 128

describe('COA extraction bucket keys satisfy migration 36', () => {
  it('the global key is inside the length CHECK', () => {
    expect(COA_EXTRACTION_GLOBAL_BUCKET_KEY.length).toBeGreaterThanOrEqual(MIN_KEY)
    expect(COA_EXTRACTION_GLOBAL_BUCKET_KEY.length).toBeLessThanOrEqual(MAX_KEY)
  })

  it('a client key is inside the length CHECK', () => {
    const key = coaExtractionClientBucketKey(DIGEST)
    expect(key.length).toBeGreaterThanOrEqual(MIN_KEY)
    expect(key.length).toBeLessThanOrEqual(MAX_KEY)
  })

  it('rejects a malformed digest instead of building a key the CHECK would refuse', () => {
    // A short digest would produce a short key, the ledger would refuse it, the
    // SQL function would raise, and the endpoint would fail closed — the feature
    // goes dark for everyone. Catching it here turns an outage into an error.
    expect(() => coaExtractionClientBucketKey('deadbeef')).toThrow()
    expect(() => coaExtractionClientBucketKey('')).toThrow()
    expect(() => coaExtractionClientBucketKey('z'.repeat(64))).toThrow()
  })

  it('lower-cases the digest so the same admin cannot hold two buckets', () => {
    expect(coaExtractionClientBucketKey('A'.repeat(64))).toBe(
      coaExtractionClientBucketKey('a'.repeat(64)),
    )
  })
})

describe('COA extraction buckets cannot collide with the ledger’s other tenants', () => {
  it('the global key differs from the AI summariser’s and the intake’s', () => {
    expect(COA_EXTRACTION_GLOBAL_BUCKET_KEY).not.toBe(AI_SUMMARY_GLOBAL_BUCKET_KEY)
    expect(COA_EXTRACTION_GLOBAL_BUCKET_KEY).not.toBe('global-intake-ceiling')
  })

  it('the client prefix differs from the AI summariser’s', () => {
    expect(COA_EXTRACTION_CLIENT_BUCKET_PREFIX).not.toBe(AI_SUMMARY_CLIENT_BUCKET_PREFIX)
  })

  it('a client key can never look like an intake key, whatever the digest', () => {
    // Intake client buckets are bare sha256 hex. The ':' in the prefix is the
    // structural guarantee: it cannot appear in hex, so no digest — however
    // unlucky — produces a key an intake bucket could equal.
    const key = coaExtractionClientBucketKey(DIGEST)
    expect(key).toContain(':')
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(false)
    expect(key.startsWith(AI_SUMMARY_CLIENT_BUCKET_PREFIX)).toBe(false)
  })

  it('a client key can never equal a global key', () => {
    const key = coaExtractionClientBucketKey(DIGEST)
    expect(key).not.toBe(COA_EXTRACTION_GLOBAL_BUCKET_KEY)
    expect(key).not.toBe(AI_SUMMARY_GLOBAL_BUCKET_KEY)
  })
})

describe('the rules bound spending rather than decorate it', () => {
  it('carries both a per-admin and a global ceiling', () => {
    // A per-admin limit alone is not a spend cap: it multiplies by the number of
    // admin accounts. The global rule is the term that makes the daily cost
    // bounded regardless of how many accounts exist or are compromised.
    expect(COA_EXTRACTION_THROTTLE_RULES.some((r) => r.scope === 'client')).toBe(true)
    expect(COA_EXTRACTION_THROTTLE_RULES.some((r) => r.scope === 'global')).toBe(true)
  })

  it('every rule has a positive window and a positive maximum', () => {
    for (const rule of COA_EXTRACTION_THROTTLE_RULES) {
      expect(rule.windowSeconds).toBeGreaterThan(0)
      expect(rule.max).toBeGreaterThan(0)
    }
  })

  it('is stricter than the AI summariser, because the unit costs more', () => {
    // A scanned laboratory PDF is an order of magnitude more input than a few
    // thousand characters of legal text, and a five-report pack has been
    // measured at 70-95 seconds of model time. If this ever loosens past the
    // summariser's global ceiling of 200/day, that is a deliberate spend
    // decision and should fail here first.
    const global = COA_EXTRACTION_THROTTLE_RULES.find((r) => r.scope === 'global')
    expect(global?.max).toBeLessThan(200)
  })

  it('the fail-closed retry hint is the LONGEST window, never zero', () => {
    // Telling a refused caller to retry immediately is the one answer that turns
    // a throttle into a no-op.
    expect(COA_EXTRACTION_MAX_WINDOW_SECONDS).toBe(
      Math.max(...COA_EXTRACTION_THROTTLE_RULES.map((r) => r.windowSeconds)),
    )
    expect(COA_EXTRACTION_MAX_WINDOW_SECONDS).toBeGreaterThan(0)
  })
})
