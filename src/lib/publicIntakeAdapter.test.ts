import { describe, it, expect } from 'vitest'
import { bucketKeyFor, clientAddress, normaliseAddress, GLOBAL_BUCKET_KEY } from '../../api/public/access-request'

// ─── The rate limiter's adapter (audit R5 follow-up) ────────────────────────
//
// Before this file, NO test imported api/public/access-request.ts at all:
// clientAddress() (IP derivation and header precedence) and bucketKeyFor()
// (canonicalisation + hashing) were entirely uncovered, while being the two
// functions that decide WHO gets throttled. A throttle whose key derivation is
// untested is a throttle in name only.
//
// The specific defect this closes: bucketKeyFor() hashed the raw address string
// with no normalisation, so
//   * `::1` and `0:0:0:0:0:0:0:1` were different buckets;
//   * `2001:DB8::1` and `2001:db8::1` were different buckets;
//   * and an attacker holding a routine IPv6 /64 had 2^64 distinct buckets,
//     which defeats every per-client rule completely.

/** Minimal request stand-in — the adapter only ever reads headers. */
function req(headers: Record<string, string | string[] | undefined>) {
  return { method: 'POST', headers, body: {} }
}

const SALT = 'test-salt-not-a-real-value'

describe('clientAddress — header precedence', () => {
  it('prefers x-real-ip over x-forwarded-for', () => {
    // x-forwarded-for is client-controllable; x-real-ip is set by the proxy.
    expect(clientAddress(req({
      'x-real-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.1, 203.0.113.9',
    }))).toBe('203.0.113.7')
  })

  it('falls back to the FIRST x-forwarded-for entry', () => {
    // On Vercel the leftmost entry is the client; the rest are proxies.
    expect(clientAddress(req({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }))).toBe('198.51.100.1')
  })

  it('handles a repeated header arriving as an array', () => {
    expect(clientAddress(req({ 'x-real-ip': ['203.0.113.7', '203.0.113.8'] }))).toBe('203.0.113.7')
  })

  it('ignores a blank x-real-ip rather than treating it as an identity', () => {
    expect(clientAddress(req({ 'x-real-ip': '   ', 'x-forwarded-for': '198.51.100.1' }))).toBe('198.51.100.1')
  })

  it('returns null when no address header is present at all', () => {
    // The core turns this into a fail-closed 503 — an unthrottleable request is
    // refused rather than accepted.
    expect(clientAddress(req({}))).toBeNull()
    expect(clientAddress(req({ 'x-forwarded-for': '  ' }))).toBeNull()
  })
})

describe('normaliseAddress — one client must be one bucket', () => {
  it('treats every spelling of an IPv6 address as the same address', () => {
    const spellings = ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001']
    const canonical = spellings.map(normaliseAddress)
    expect(new Set(canonical).size, `these must all canonicalise alike: ${canonical.join(' | ')}`).toBe(1)
  })

  it('is case-insensitive for IPv6 hex', () => {
    expect(normaliseAddress('2001:DB8:ABCD:0012::1')).toBe(normaliseAddress('2001:db8:abcd:12::1'))
  })

  it('buckets IPv6 by the /64 prefix, not the address', () => {
    // The important one. A routine end-site allocation is a /64, so per-address
    // bucketing hands one attacker 2^64 buckets and no per-client limit at all.
    const sameAllocation = [
      '2001:db8:1:2::1',
      '2001:db8:1:2::dead:beef',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
    ].map(normaliseAddress)
    expect(new Set(sameAllocation).size).toBe(1)

    // ...while a DIFFERENT /64 is still a different bucket, so one abuser cannot
    // lock out an unrelated network.
    expect(normaliseAddress('2001:db8:1:3::1')).not.toBe(normaliseAddress('2001:db8:1:2::1'))
  })

  it('keeps IPv4 per-address, where the address IS the allocation', () => {
    expect(normaliseAddress('203.0.113.7')).toBe('v4:203.0.113.7')
    expect(normaliseAddress('203.0.113.8')).not.toBe(normaliseAddress('203.0.113.7'))
  })

  it('strips brackets and ports without changing identity', () => {
    expect(normaliseAddress('[2001:db8:1:2::1]')).toBe(normaliseAddress('2001:db8:1:2::1'))
    expect(normaliseAddress('203.0.113.7:44321')).toBe(normaliseAddress('203.0.113.7'))
  })

  it('never confuses an IPv4 address with an IPv6 one', () => {
    expect(normaliseAddress('203.0.113.7')).not.toBe(normaliseAddress('::203.0.113.7'))
  })

  it('rejects anything it cannot canonicalise', () => {
    // A value that cannot be parsed must not be hashed: that would let a caller
    // choose its own bucket by sending garbage.
    for (const bad of ['', '   ', 'not-an-address', '999.1.1.1', '203.0.113', 'g::1', '::1::2']) {
      expect(normaliseAddress(bad), `${JSON.stringify(bad)} must be rejected`).toBeNull()
    }
  })
})

describe('bucketKeyFor — salted, non-reversible, and stable', () => {
  it('produces a sha256 hex digest', () => {
    expect(bucketKeyFor('203.0.113.7', SALT)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never contains the address itself', () => {
    // The raw address is never stored; the ledger holds only this digest.
    expect(bucketKeyFor('203.0.113.7', SALT)).not.toContain('203.0.113')
  })

  it('is stable for the same address and salt', () => {
    expect(bucketKeyFor('203.0.113.7', SALT)).toBe(bucketKeyFor('203.0.113.7', SALT))
  })

  it('differs across salts, so one deployment cannot correlate another', () => {
    expect(bucketKeyFor('203.0.113.7', SALT)).not.toBe(bucketKeyFor('203.0.113.7', `${SALT}-other`))
  })

  it('gives the SAME bucket for equivalent spellings of one address', () => {
    // The regression that mattered: these used to be three separate buckets, so
    // one client got three times its allowance just by varying notation.
    const keys = ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001']
      .map(a => bucketKeyFor(a, SALT))
    expect(new Set(keys).size).toBe(1)
  })

  it('gives the SAME bucket across an IPv6 /64, so 2^64 buckets is not available', () => {
    const keys = ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:abcd:ef01:2345:6789']
      .map(a => bucketKeyFor(a, SALT))
    expect(new Set(keys).size).toBe(1)
  })

  it('returns null for an address it cannot canonicalise', () => {
    // Fails closed: the core refuses the request rather than hashing a
    // caller-chosen string into a bucket of its choosing.
    expect(bucketKeyFor('not-an-address', SALT)).toBeNull()
  })

  it('can never collide with the global bucket key', () => {
    // The global rule must not be evadable by a client that lands on its key.
    expect(bucketKeyFor('203.0.113.7', SALT)).not.toBe(GLOBAL_BUCKET_KEY)
    expect(GLOBAL_BUCKET_KEY).not.toMatch(/^[0-9a-f]{64}$/)
  })
})
