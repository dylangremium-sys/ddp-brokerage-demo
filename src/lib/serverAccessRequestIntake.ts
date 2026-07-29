// ─── Public supplier-intake handler (audit R5) ──────────────────────────────
//
// Pure, dependency-injected core for POST /api/public/access-request. It holds
// every decision — validation, throttling, duplicate suppression — so all of it
// is testable without a network, a database or a Vercel runtime. The adapter
// (api/public/access-request.ts) supplies IO and nothing else, exactly as
// serverFarmerProvisioning.ts + api/admin/provision-farmer.ts do.
//
// WHY THIS EXISTS
// ---------------
// `farmer_access_requests: public submit` was the only anon-satisfiable write
// policy in production. The write went browser → Supabase directly and never
// traversed Vercel, so migration 34's own note that "rate limiting belongs at the
// edge" described a mitigation that could not reach the path. Routing the write
// through this function is what makes an edge throttle possible at all; migration
// 36 then revokes the anon INSERT so the direct path is closed rather than merely
// discouraged.
//
// FAIL CLOSED. If the function is not configured, it reports that plainly and
// accepts nothing. It never falls back to an unthrottled path.

/** Mirrors the migration-34 column CHECKs. */
export interface AccessRequestSubmission {
  fullName: string
  email: string
  phone: string
  province: string
  position: string
  preferredLanguage: 'en' | 'th'
  note: string
}

export type IntakeOutcome =
  | { status: 200; body: { ok: true } }
  | { status: 400; body: { ok: false; error: string; field?: string } }
  | { status: 405; body: { ok: false; error: string } }
  | { status: 429; body: { ok: false; error: string; retryAfterSeconds: number } }
  | { status: 500; body: { ok: false; error: string } }
  | { status: 503; body: { ok: false; error: string } }

/**
 * Throttle windows, most specific first.
 *
 * Two layers deliberately. The per-client window stops one source flooding the
 * queue; the global window bounds the damage from a distributed flood, which no
 * per-client rule can see. The global ceiling is set far above any plausible
 * legitimate rate — a real supplier funnel does not produce 60 enquiries an hour
 * — so it degrades an attack into a nuisance without locking out real users at
 * any realistic volume.
 */
export const THROTTLE_RULES = [
  { scope: 'client' as const, windowSeconds: 600, max: 3 },
  { scope: 'client' as const, windowSeconds: 86_400, max: 10 },
  { scope: 'global' as const, windowSeconds: 3_600, max: 60 },
]

/**
 * The key used for the global bucket.
 *
 * Two constraints, both load-bearing:
 *
 *  1. It must satisfy the ledger's own CHECK — migration 36 declares
 *     `CHECK (length(bucket_key) BETWEEN 16 AND 128)`. The original value here
 *     was 'global', six characters, so the global reservation was rejected by
 *     that constraint on every single submission. Because the handler turns a
 *     ledger write failure into a fail-closed 503, applying migration 36 would
 *     have taken the public intake form completely offline. No test caught it:
 *     every unit test mocks the database, and the VERIFY script never exercised
 *     the global key.
 *  2. It must never collide with a client bucket. Client buckets are sha256 hex
 *     digests — exactly 64 characters of [0-9a-f] — so any string containing a
 *     character outside that alphabet is collision-proof by construction. This
 *     one contains hyphens and letters beyond 'f'.
 */
export const GLOBAL_BUCKET_KEY = 'global-intake-ceiling'

/** The outcome of an atomic slot reservation. */
export interface ThrottleReservation {
  allowed: boolean
  /** Present only when `allowed` is false — the window that was exceeded. */
  windowSeconds?: number
}

export interface IntakeDeps {
  /**
   * Atomically reserve one intake slot and report whether a rule is exceeded.
   *
   * This is deliberately ONE operation rather than a count followed by a write.
   * Splitting them is check-then-act: concurrent invocations across serverless
   * instances all finish counting before any of them records, so a parallel
   * burst passes every rule at once. Vercel functions share no lock, so the
   * database has to be the thing that serialises — see
   * public.reserve_public_intake_slot() in migration 36.
   *
   * MUST THROW rather than return `{allowed: true}` when the ledger cannot be
   * reached; the caller turns a throw into a fail-closed 503.
   */
  reserveThrottleSlot(clientBucketKey: string): Promise<ThrottleReservation>
  /** True when an unresolved request already exists for this email. */
  hasOpenRequestForEmail(email: string): Promise<boolean>
  /** Insert the request. Throws on failure. */
  insertRequest(input: AccessRequestSubmission): Promise<void>
  /** Salted, non-reversible client identifier. Never the raw address. */
  bucketKeyForClient(): string | null
  now(): Date
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Validates against migration 34's CHECK constraints.
 *
 * Returns the offending field name, or null. Deliberately mirrors the DB rather
 * than being looser: a value this accepts and the database rejects becomes a 500
 * for a user who did nothing wrong.
 */
export function validateSubmission(input: Partial<AccessRequestSubmission>): string | null {
  const name = (input.fullName ?? '').trim()
  const email = (input.email ?? '').trim()
  const phone = (input.phone ?? '').trim()

  if (name.length < 1 || name.length > 120) return 'fullName'
  if (email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) return 'email'
  if (phone.length < 5 || phone.length > 40) return 'phone'
  if ((input.province ?? '').length > 80) return 'province'
  if ((input.position ?? '').length > 60) return 'position'
  if (input.preferredLanguage !== 'en' && input.preferredLanguage !== 'th') return 'preferredLanguage'
  if ((input.note ?? '').length > 2000) return 'note'
  return null
}

/** Normalises a submission once, so validation and insertion cannot disagree. */
export function normaliseSubmission(input: Partial<AccessRequestSubmission>): AccessRequestSubmission {
  return {
    fullName: (input.fullName ?? '').trim(),
    email: (input.email ?? '').trim(),
    phone: (input.phone ?? '').trim(),
    province: input.province ?? '',
    position: input.position ?? '',
    preferredLanguage: input.preferredLanguage === 'th' ? 'th' : 'en',
    note: (input.note ?? '').trim(),
  }
}

/**
 * Handle one submission.
 *
 * Never throws: every failure becomes an outcome, so the adapter has no error
 * handling of its own to get wrong.
 */
export async function handleAccessRequest(
  method: string | undefined,
  rawBody: unknown,
  deps: IntakeDeps | null,
): Promise<IntakeOutcome> {
  if ((method ?? '').toUpperCase() !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Method not allowed.' } }
  }

  // FAIL CLOSED. An unconfigured deployment accepts nothing. 503 rather than 500
  // because it is a deployment state, not a request fault — and the client maps
  // it to the same honest "not available yet" message migration 34's client
  // already showed, rather than asking the visitor to retry something that
  // cannot succeed.
  if (!deps) {
    return {
      status: 503,
      body: { ok: false, error: 'The request form is not available yet.' },
    }
  }

  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    return { status: 400, body: { ok: false, error: 'A JSON object body is required.' } }
  }

  const submission = normaliseSubmission(rawBody as Partial<AccessRequestSubmission>)
  const invalidField = validateSubmission(submission)
  if (invalidField) {
    return { status: 400, body: { ok: false, error: 'A field is not valid.', field: invalidField } }
  }

  // No client identity means no throttle is possible. Refusing is the only safe
  // answer: accepting would restore exactly the unbounded path this endpoint
  // exists to close.
  const clientBucket = deps.bucketKeyForClient()
  if (!clientBucket) {
    return {
      status: 503,
      body: { ok: false, error: 'The request form is not available yet.' },
    }
  }

  // Reserve and evaluate in ONE atomic operation. The reservation happens even
  // when the caller is then refused, which is deliberate: re-submitting must keep
  // consuming the caller's allowance rather than resetting it.
  let reservation: ThrottleReservation
  try {
    reservation = await deps.reserveThrottleSlot(clientBucket)
  } catch {
    // The throttle could not be evaluated, so the request cannot be accepted
    // within a known bound. Fail closed rather than waving it through.
    return { status: 503, body: { ok: false, error: 'The request form is not available yet.' } }
  }

  if (!reservation.allowed) {
    return {
      status: 429,
      body: {
        ok: false,
        error: 'Too many requests from this connection. Please try again later, or contact the DDP team directly.',
        // A refusal always names a window. Defaulting to the longest configured
        // window rather than 0 keeps a malformed reply fail-closed: telling a
        // caller to retry immediately would be the one unsafe answer.
        retryAfterSeconds: reservation.windowSeconds ?? Math.max(...THROTTLE_RULES.map(rule => rule.windowSeconds)),
      },
    }
  }

  // Duplicate suppression. Reported as SUCCESS, not as an error: telling an
  // anonymous caller "that address already has a request" would turn the endpoint
  // into an oracle for which suppliers have applied. The queue stays clean and
  // the visitor sees the same confirmation either way.
  try {
    if (await deps.hasOpenRequestForEmail(submission.email)) {
      return { status: 200, body: { ok: true } }
    }
    await deps.insertRequest(submission)
  } catch {
    // The driver message can name columns and constraints. Keep it server-side.
    return { status: 500, body: { ok: false, error: 'The request could not be sent. Please try again.' } }
  }

  return { status: 200, body: { ok: true } }
}
