// ─── AI-summary throttle policy ──────────────────────────────────────────────
//
// `api/compliance/ai-summary.ts` calls a paid model. Before this module the only
// bound on it was `max_tokens: 8000`, which caps ONE call and says nothing about
// how many calls may be made — so the endpoint's cost ceiling was, in effect,
// "how fast can an authenticated admin's browser loop". That is a spend exposure
// rather than an abuse exposure: the caller must already be a `ddp_admin`, so
// this is not primarily a defence against strangers. It bounds the damage from a
// compromised or careless admin session, a retry loop in the UI, or a script
// someone points at the endpoint — none of which need malice to be expensive.
//
// WHY THE RULES LIVE HERE AND NOT IN SQL
// `reserve_public_intake_slot` takes its rules as an argument and documents the
// division explicitly: "the application owns the policy, this function owns only
// the atomicity". Keeping the numbers in TypeScript means changing them is a code
// review, not a migration — and, more importantly, means they are covered by the
// same tests as the endpoint they govern.
//
// WHY THIS REUSES THE PUBLIC-INTAKE LEDGER
// The reservation goes through migration 36's `reserve_public_intake_slot` and
// lands in `public.public_intake_attempts`. The names say "public intake"; the
// structure is a generic `(bucket_key, occurred_at)` token ledger with an
// opaque, length-checked key, and the function's rules are entirely
// caller-supplied.
//
// The decisive reason is deployment state, not elegance: **migration 36 is
// applied to production, and migrations 39-45 are not.** A purpose-built
// `ai_summary_attempts` table would be migration 46, would sit behind the whole
// unapplied backlog, and would therefore protect production on no known date.
// This protects it at deploy time. When the backlog lands and a dedicated ledger
// is worth having, only `reserveAiSummarySlot` in the api adapter changes — the
// policy here and the endpoint logic do not.
//
// The two ledgers cannot interfere with each other's counting, because a rule is
// evaluated against a single bucket key and these keys are disjoint from the
// intake's by construction (see below). They do share one advisory lock inside
// the function, so reservations serialise globally; both paths are low-volume
// and this is not a throughput concern at any plausible rate.

/** The reservation result. Mirrors `ThrottleReservation` in the intake path. */
export interface AiSummaryThrottleReservation {
  allowed: boolean
  /** The window that was exceeded, in seconds. Absent when allowed. */
  windowSeconds?: number
}

/**
 * Throttle windows, most specific first.
 *
 * Sized against what the feature is FOR. An admin triages legal updates one at a
 * time and reads a several-hundred-word draft before acting on it, so a genuine
 * reviewer does not produce ten summaries in an hour, let alone forty in a day.
 * The global ceiling is the actual spend cap: it bounds total daily model calls
 * regardless of how many admin accounts exist or how many are compromised.
 *
 * 200 calls/day x `max_tokens: 8000` is the worst-case daily output the endpoint
 * can now buy. Before these rules that product had no second term.
 */
export const AI_SUMMARY_THROTTLE_RULES = [
  { scope: 'client' as const, windowSeconds: 3_600, max: 10 },
  { scope: 'client' as const, windowSeconds: 86_400, max: 40 },
  { scope: 'global' as const, windowSeconds: 86_400, max: 200 },
]

/**
 * The key for the global (spend-cap) bucket.
 *
 * Three constraints, all load-bearing, and the first one has already taken a
 * production endpoint offline once in this repository:
 *
 *  1. Migration 36 declares `CHECK (length(bucket_key) BETWEEN 16 AND 128)`.
 *     `GLOBAL_BUCKET_KEY` was originally 'global' — six characters — so every
 *     global reservation was rejected by that constraint and the handler's
 *     fail-closed path took the form down. This value is 24 characters, and the
 *     per-admin key is 75 — both measured against staging, not counted by eye,
 *     and both asserted in the tests.
 *  2. It must not collide with an INTAKE bucket. Intake client buckets are
 *     sha256 hex (64 chars of [0-9a-f]) and the intake global key is
 *     'global-intake-ceiling'; this string is neither.
 *  3. It must not collide with an AI CLIENT bucket, which is why those carry a
 *     prefix containing ':' — a character that cannot appear here.
 */
export const AI_SUMMARY_GLOBAL_BUCKET_KEY = 'ai-summary-daily-ceiling'

/**
 * Prefix for per-admin buckets.
 *
 * Contains ':', which appears in no other bucket key in the system, so an AI
 * client bucket cannot collide with an intake client bucket (pure hex), the
 * intake global key, or the AI global key above — regardless of what the hash
 * digest happens to be.
 */
export const AI_SUMMARY_CLIENT_BUCKET_PREFIX = 'ai-summary:'

/** Length of a hex sha256 digest. */
const SHA256_HEX_LENGTH = 64
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

/**
 * Builds a per-admin bucket key from an already-computed sha256 digest.
 *
 * The HASHING stays in the api adapter, because `node:crypto` is unavailable to
 * the app tsconfig; the CONSTRUCTION lives here, because that is the part with
 * properties worth testing — the length bound migration 36 enforces, and
 * disjointness from every other key in the shared ledger. Splitting it this way
 * is what makes those properties testable at all: `api/` is outside the vitest
 * include glob, so anything placed there is asserted only by source-text
 * matching, which is how a six-character bucket key once reached production.
 *
 * Throws on a malformed digest rather than returning a key the ledger's CHECK
 * would reject. A rejected reservation raises inside the SQL function, the
 * endpoint fails closed on the throw, and the feature goes dark — so catching a
 * bad digest here turns a production outage into a caught error.
 */
export function aiSummaryClientBucketKey(digestHex: string): string {
  if (!SHA256_HEX_RE.test(digestHex)) {
    throw new Error(
      `aiSummaryClientBucketKey: expected a ${SHA256_HEX_LENGTH}-character hex sha256 digest`,
    )
  }
  return AI_SUMMARY_CLIENT_BUCKET_PREFIX + digestHex.toLowerCase()
}

/**
 * The longest configured window, used as the fail-closed `retryAfterSeconds`.
 *
 * A refusal must always name a window. Defaulting to the longest rather than 0
 * matters: telling a caller to retry immediately is the one answer that turns a
 * throttle into a no-op.
 */
export const AI_SUMMARY_MAX_WINDOW_SECONDS = Math.max(
  ...AI_SUMMARY_THROTTLE_RULES.map(rule => rule.windowSeconds),
)
