// ─── Feed-retrieval throttle policy ──────────────────────────────────────────
//
// `api/compliance/feed-retrieve.ts` makes an OUTBOUND request to a third-party
// regulator on demand. The exposure it bounds is different in kind from the AI
// summariser's, and the difference is why this file exists rather than reusing
// AI_SUMMARY_THROTTLE_RULES:
//
//   * There is no per-call money. The cost of one retrieval is a couple of
//     seconds of function time and up to `maxBytes` of transfer.
//   * There IS reputational and access risk. Every request carries DDP's
//     User-Agent to a government host. An unbounded loop here is DDP appearing
//     in a Thai FDA or EUR-Lex access log as a scraper, and the plausible
//     consequence is an IP block that takes regulatory monitoring offline
//     entirely — a self-inflicted outage of the exact feature this enables.
//   * It is a fetch primitive reachable by an authenticated admin, so it is
//     also the natural place for an SSRF attempt to be retried in bulk. The
//     retrieval guard refuses each such attempt individually; a ceiling is what
//     stops the ATTEMPTS from being free and unlimited.
//
// So the numbers are set by politeness to the upstream host, not by spend.
//
// Everything else follows serverAiSummaryThrottle.ts deliberately — same
// ledger, same reasoning, same failure mode. See that file for why migration
// 36's `reserve_public_intake_slot` is reused instead of a purpose-built table:
// 36 is applied to production and 39-46 are not, so a new ledger would protect
// production on no known date.

/** The reservation result. Mirrors the AI summariser's shape exactly. */
export interface FeedRetrievalThrottleReservation {
  allowed: boolean
  /** The window that was exceeded, in seconds. Absent when allowed. */
  windowSeconds?: number
}

/**
 * Throttle windows, most specific first.
 *
 * Sized against the real workload rather than a round number. The source
 * registry holds 8 sources. A human clicking "Run ingestion now" spends 8
 * retrievals; doing that every ten minutes for an hour is 48. 60/hour therefore
 * leaves an operator room to work while a runaway loop hits the wall inside a
 * minute.
 *
 * The global ceiling is the one that actually protects the upstream regulators:
 * 400/day across all admins is roughly 50 full registry sweeps, comfortably
 * more than the scheduled daily run plus a heavy day of manual checking, and far
 * below anything a regulator would read as abuse.
 */
export const FEED_RETRIEVAL_THROTTLE_RULES = [
  { scope: 'client' as const, windowSeconds: 3_600, max: 60 },
  { scope: 'client' as const, windowSeconds: 86_400, max: 200 },
  { scope: 'global' as const, windowSeconds: 86_400, max: 400 },
]

/**
 * The key for the global bucket.
 *
 * Three constraints, all load-bearing, and the first one has already taken a
 * production endpoint offline once in this repository (see
 * serverAiSummaryThrottle.ts):
 *
 *  1. Migration 36 declares `CHECK (length(bucket_key) BETWEEN 16 AND 128)`.
 *     This string is 27 characters. Asserted in the tests rather than counted
 *     by eye, because eye-counting is precisely how a six-character key once
 *     reached production and failed closed.
 *  2. It must not collide with any other global bucket: the intake's
 *     'global-intake-ceiling' or the AI summariser's
 *     'ai-summary-daily-ceiling'. It is neither.
 *  3. It must contain no ':', so it cannot collide with any prefixed CLIENT
 *     bucket in the shared ledger.
 */
export const FEED_RETRIEVAL_GLOBAL_BUCKET_KEY = 'feed-retrieve-daily-ceiling'

/**
 * Prefix for per-admin buckets.
 *
 * Contains ':' for the same reason the AI summariser's does — it makes
 * collision with the intake's pure-hex client buckets, and with either global
 * key, impossible by construction rather than by luck of the digest. It also
 * differs from 'ai-summary:', so an admin's feed allowance and their AI
 * allowance cannot consume one another.
 */
export const FEED_RETRIEVAL_CLIENT_BUCKET_PREFIX = 'feed-retrieve:'

const SHA256_HEX_LENGTH = 64
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

/**
 * Builds a per-admin bucket key from an already-computed sha256 digest.
 *
 * The HASHING stays in the api adapter (`node:crypto` is unavailable to the app
 * tsconfig); the CONSTRUCTION lives here because that is the part with testable
 * properties — the length bound migration 36 enforces, and disjointness from
 * every other key in the shared ledger. `api/` is outside the vitest include
 * glob, so anything placed there is asserted only by source-text matching.
 *
 * Throws on a malformed digest rather than returning a key the ledger's CHECK
 * would reject: a rejected reservation raises inside the SQL function and the
 * endpoint fails closed, so catching it here turns an outage into a caught error.
 */
export function feedRetrievalClientBucketKey(digestHex: string): string {
  if (!SHA256_HEX_RE.test(digestHex)) {
    throw new Error(
      `feedRetrievalClientBucketKey: expected a ${SHA256_HEX_LENGTH}-character hex sha256 digest`,
    )
  }
  return FEED_RETRIEVAL_CLIENT_BUCKET_PREFIX + digestHex.toLowerCase()
}

/**
 * The longest configured window, used as the fail-closed `retryAfterSeconds`.
 * Defaulting to the longest rather than 0 matters: telling a caller to retry
 * immediately is the one answer that turns a throttle into a no-op.
 */
export const FEED_RETRIEVAL_MAX_WINDOW_SECONDS = Math.max(
  ...FEED_RETRIEVAL_THROTTLE_RULES.map(rule => rule.windowSeconds),
)
