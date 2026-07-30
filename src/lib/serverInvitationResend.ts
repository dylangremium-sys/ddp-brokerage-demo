// Pure, dependency-injected core for the DDP admin "resend invitation" endpoint.
//
// Same split as serverFarmerProvisioning.ts: NO Supabase import, NO secrets, NO
// process.env. The api/ adapter injects a service-role-backed implementation, so
// the authorization and sequencing logic stays unit-testable and the
// service-role key stays out of anything the browser bundle can import.
//
// WHY THIS ENDPOINT EXISTS
//   A supplier invited by DDP who does not open the email before it expires is
//   stuck. `resetPasswordForEmail` cannot rescue them: their identity is still
//   unconfirmed, so Supabase sends no recovery mail — the public
//   "forgot password" path silently does nothing for exactly that population.
//   Only an admin-side re-issue can help, which is what this is.
//
//   It is deliberately ADMIN-ONLY. A public re-invite endpoint would be an
//   unthrottled email-sending and address-enumeration vector, and the intake
//   throttle (migration 36) is unapplied on every environment.
//
// Security model enforced here:
//   bearer token → resolve caller → read caller role FROM THE DATABASE →
//   require ddp_admin (fail closed) → validate input → look the account up →
//   REFUSE if it is already confirmed → re-issue.

export interface ResendCaller {
  id: string
}

/**
 * What the account for a given email address turns out to be.
 *
 *   absent      → no account. The admin wants "Invite & create account", not this.
 *   ambiguous   → more than one profile matches. profiles.email is nullable and
 *                 carries no unique constraint, so this is possible; re-issuing
 *                 against a guess could hand one person's invitation to another.
 *                 Fail closed.
 *   confirmed   → the account already has a usable password. Re-inviting is the
 *                 WRONG tool and a real hazard: it mints a fresh credential for a
 *                 live account on the say-so of an email address. Send them
 *                 through "forgot password" instead.
 *   unconfirmed → the case this endpoint is for.
 */
export type AccountLookup =
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { kind: 'confirmed' }
  | { kind: 'unconfirmed'; userId: string }

/**
 * How the re-issued invitation reached (or failed to reach) the supplier.
 *
 *   emailed   → the provider sent it. Nothing further for the admin to do.
 *   link_only → the provider would not send, but a valid one-time link exists.
 *               Handed to the ADMIN to deliver by whatever channel the supplier
 *               actually uses — for Thai growers that is often LINE, not email.
 *   error     → nothing was issued.
 */
export type ReissueResult =
  | { kind: 'emailed' }
  | { kind: 'link_only'; actionLink: string }
  | { kind: 'error'; message: string }

export interface ResendDeps {
  /** Resolve the caller from their bearer token; null if invalid/expired. */
  getCallerFromToken(token: string): Promise<ResendCaller | null>
  /** Read a user's profiles.role via the service role; null if no profile row. */
  getProfileRole(userId: string): Promise<string | null>
  /** Find the account for an email and report whether it is already confirmed. */
  findAccountByEmail(email: string): Promise<AccountLookup>
  /** Re-issue the invitation for an account known to be unconfirmed. */
  reissueInvitation(email: string): Promise<ReissueResult>
}

export interface ResendHttpRequest {
  token: string | null
  body: unknown
}

export interface ResendHttpResponse {
  status: number
  body: Record<string, unknown>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 254
// Fields a caller must never set: they would let the caller aim the re-issue at
// an account other than the one the email identifies.
const FORBIDDEN_BODY_KEYS = ['role', 'id', 'userId', 'user_id', 'profileId', 'profile_id']

export async function handleResendInvitation(
  deps: ResendDeps,
  req: ResendHttpRequest,
): Promise<ResendHttpResponse> {
  // 1. Authentication.
  if (!req.token) return deny(401, 'Authentication required.')
  const caller = await deps.getCallerFromToken(req.token)
  if (!caller) return deny(401, 'Invalid or expired session.')

  // 2. Authorization — role read from the database, never from the body or from
  //    token metadata. Missing or non-admin fails closed.
  const callerRole = await deps.getProfileRole(caller.id)
  if (callerRole !== 'ddp_admin') return deny(403, 'DDP admin privileges are required.')

  // 3. Input validation.
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    return deny(400, 'A JSON object body is required.')
  }
  const body = req.body as Record<string, unknown>
  for (const key of FORBIDDEN_BODY_KEYS) {
    if (key in body) return deny(400, `The '${key}' field is not permitted.`)
  }
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!EMAIL_RE.test(email)) return deny(400, 'A valid email address is required.')
  if (email.length > MAX_EMAIL_LENGTH) return deny(400, 'The email address is too long.')

  // 4. Look the account up BEFORE issuing anything.
  const account = await deps.findAccountByEmail(email)
  if (account.kind === 'absent') {
    return deny(404, 'No account exists for this address. Use "Invite & create account" first.', {
      reason: 'no_such_account',
      recovery: 'invite_and_create_account',
    })
  }
  if (account.kind === 'ambiguous') {
    return deny(409, 'More than one account matches this address. Resolve the duplicate before re-inviting.', {
      reason: 'ambiguous_account',
      recovery: 'resolve_duplicate_profiles',
    })
  }
  if (account.kind === 'confirmed') {
    // The hazard this endpoint must not become: minting a fresh credential for a
    // live account on the strength of an email address alone.
    return deny(409, 'This account already has a password. Ask them to use "Forgot your password?" on the sign-in page.', {
      reason: 'already_active',
      recovery: 'use_password_reset',
    })
  }

  // 5. Re-issue.
  const result = await deps.reissueInvitation(email)
  if (result.kind === 'error') {
    // The raw provider message is NOT returned — it leaks auth-provider wording.
    // It stays server-side for the adapter's logging, matching the discipline in
    // serverFarmerProvisioning.ts and api/compliance/ai-summary.ts.
    return {
      status: 502,
      body: {
        ok: false,
        reason: 'reissue_failed',
        error: 'The invitation could not be re-issued. Please retry, or contact support if it persists.',
      },
    }
  }

  if (result.kind === 'link_only') {
    return {
      status: 200,
      body: {
        ok: true,
        delivered: 'link',
        actionLink: result.actionLink,
        userId: account.userId,
      },
    }
  }

  return { status: 200, body: { ok: true, delivered: 'email', userId: account.userId } }
}

function deny(status: number, error: string, extra: Record<string, unknown> = {}): ResendHttpResponse {
  return { status, body: { ok: false, error, ...extra } }
}
