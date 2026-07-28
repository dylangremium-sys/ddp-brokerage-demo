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

/** The key used for the global bucket. Never collides with a sha256 hex digest. */
export const GLOBAL_BUCKET_KEY = 'global'

export interface IntakeDeps {
  /** Attempts recorded for a bucket since `since`. */
  countAttempts(bucketKey: string, since: Date): Promise<number>
  /** Append one attempt. */
  recordAttempt(bucketKey: string): Promise<void>
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
 * The first rule this caller has exceeded, or null.
 *
 * Evaluated before the write, and every rule is checked rather than
 * short-circuiting on the first pass — a caller inside the 10-minute allowance
 * can still be outside the daily one.
 */
export async function firstExceededRule(
  deps: IntakeDeps,
  clientBucket: string,
): Promise<{ windowSeconds: number } | null> {
  const now = deps.now()
  for (const rule of THROTTLE_RULES) {
    const key = rule.scope === 'global' ? GLOBAL_BUCKET_KEY : clientBucket
    const since = new Date(now.getTime() - rule.windowSeconds * 1000)
    const count = await deps.countAttempts(key, since)
    if (count >= rule.max) return { windowSeconds: rule.windowSeconds }
  }
  return null
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

  let exceeded: { windowSeconds: number } | null
  try {
    exceeded = await firstExceededRule(deps, clientBucket)
  } catch {
    // The throttle could not be evaluated, so the request cannot be accepted
    // within a known bound. Fail closed rather than waving it through.
    return { status: 503, body: { ok: false, error: 'The request form is not available yet.' } }
  }

  if (exceeded) {
    return {
      status: 429,
      body: {
        ok: false,
        error: 'Too many requests from this connection. Please try again later, or contact the DDP team directly.',
        retryAfterSeconds: exceeded.windowSeconds,
      },
    }
  }

  // Duplicate suppression. Reported as SUCCESS, not as an error: telling an
  // anonymous caller "that address already has a request" would turn the endpoint
  // into an oracle for which suppliers have applied. The queue stays clean and
  // the visitor sees the same confirmation either way.
  //
  // Recorded as an attempt first, so repeatedly re-submitting the same address
  // still consumes the caller's allowance.
  try {
    await deps.recordAttempt(clientBucket)
    await deps.recordAttempt(GLOBAL_BUCKET_KEY)
  } catch {
    return { status: 503, body: { ok: false, error: 'The request form is not available yet.' } }
  }

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
