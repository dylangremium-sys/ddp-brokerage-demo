// ─── COA-extraction throttle policy ──────────────────────────────────────────
//
// `api/compliance/coa-extract.ts` calls a paid model with a whole PDF attached.
// Until this module the endpoint's `reserveExtractionSlot` threw
// `coa_extract_not_implemented_spend_ceiling` on purpose, so the endpoint could
// not serve at all — fail-closed, and correct, but it means the ceiling has
// never actually bounded anything. This is the first version that does.
//
// The caller must already be a `ddp_admin`, so this is not primarily a defence
// against strangers. It bounds a compromised or careless admin session, a retry
// loop in the UI, and a script pointed at the endpoint — none of which need
// malice to be expensive.
//
// WHY THE NUMBERS ARE LOWER THAN THE AI SUMMARISER'S
// A summary sends a few thousand characters of legal text. An extraction sends a
// scanned laboratory PDF, which is an order of magnitude more input, and a
// five-report pack has been measured at 70-95 seconds of model time per call.
// The unit being rationed is simply more expensive, so fewer of them are
// allowed. See serverAiSummaryThrottle.ts for the shared reasoning about why
// policy lives in TypeScript and atomicity lives in SQL.
//
// WHY THIS REUSES THE PUBLIC-INTAKE LEDGER
// Same reason, and the same decisive argument: deployment state. The reservation
// goes through migration 36's `reserve_public_intake_slot` into
// `public.public_intake_attempts` — a generic `(bucket_key, occurred_at)` token
// ledger whose rules are entirely caller-supplied. Migration 36 IS APPLIED TO
// PRODUCTION. A purpose-built `coa_extraction_attempts` table would be a new
// migration sitting behind the rest of the backlog, and would therefore protect
// production on no known date.
//
// The three ledgers cannot interfere with each other's counting: a rule is
// evaluated against a single bucket key, and these keys are disjoint from the
// intake's and the AI summariser's by construction (see below).

/** The reservation result. Mirrors `ThrottleReservation` in the intake path. */
export interface CoaExtractionThrottleReservation {
  allowed: boolean
  /** The window that was exceeded, in seconds. Absent when allowed. */
  windowSeconds?: number
}

/**
 * Throttle windows, most specific first.
 *
 * Sized against what the feature is FOR. An administrator triggers extraction on
 * a document that has just been uploaded, then reads a five-report result and
 * decides what to accept — work measured in minutes per document, not seconds.
 * Four in an hour is already a brisk pace for a genuine reviewer.
 *
 * The global ceiling is the actual spend cap: it bounds total daily model calls
 * regardless of how many admin accounts exist or how many are compromised. At
 * 40 calls a day against packs of the size already measured, the worst case is a
 * bounded and affordable number — which is a statement that could not be made
 * about this endpoint at all before now.
 */
export const COA_EXTRACTION_THROTTLE_RULES = [
  { scope: 'client' as const, windowSeconds: 3_600, max: 4 },
  { scope: 'client' as const, windowSeconds: 86_400, max: 15 },
  { scope: 'global' as const, windowSeconds: 86_400, max: 40 },
]

/**
 * The key for the global (spend-cap) bucket.
 *
 * Three constraints, all load-bearing, and the first one has already taken a
 * production endpoint offline once in this repository:
 *
 *  1. Migration 36 declares `CHECK (length(bucket_key) BETWEEN 16 AND 128)`.
 *     The AI summariser's global key was originally 'global' — six characters —
 *     so every global reservation was rejected by that constraint and the
 *     handler's fail-closed path took the form down. This value is 28
 *     characters, asserted in the tests rather than counted by eye.
 *  2. It must not collide with an INTAKE bucket. Intake client buckets are
 *     sha256 hex (64 chars of [0-9a-f]) and the intake global key is
 *     'global-intake-ceiling'; this string is neither.
 *  3. It must not collide with the AI SUMMARY buckets, whose global key is
 *     'ai-summary-daily-ceiling' and whose client prefix is 'ai-summary:'.
 */
export const COA_EXTRACTION_GLOBAL_BUCKET_KEY = 'coa-extraction-daily-ceiling'

/**
 * Prefix for per-admin buckets.
 *
 * Contains ':', which cannot appear in an intake bucket key (pure hex) or in
 * either global key, and differs from the AI summariser's 'ai-summary:' prefix —
 * so no digest, however unlucky, can make a COA bucket collide with another
 * feature's.
 */
export const COA_EXTRACTION_CLIENT_BUCKET_PREFIX = 'coa-extract:'

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
export function coaExtractionClientBucketKey(digestHex: string): string {
  if (!SHA256_HEX_RE.test(digestHex)) {
    throw new Error(
      `coaExtractionClientBucketKey: expected a ${SHA256_HEX_LENGTH}-character hex sha256 digest`,
    )
  }
  return COA_EXTRACTION_CLIENT_BUCKET_PREFIX + digestHex.toLowerCase()
}

/**
 * The longest configured window, used as the fail-closed `retryAfterSeconds`.
 *
 * A refusal must always name a window. Defaulting to the longest rather than 0
 * matters: telling a caller to retry immediately is the one answer that turns a
 * throttle into a no-op.
 */
export const COA_EXTRACTION_MAX_WINDOW_SECONDS = Math.max(
  ...COA_EXTRACTION_THROTTLE_RULES.map((rule) => rule.windowSeconds),
)
