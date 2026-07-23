// Pure, dependency-injected core for the DDP admin farmer-invitation endpoint.
//
// It contains NO Supabase import, NO secrets and NO process.env access: the
// api/ adapter injects a service-role-backed implementation of ProvisioningDeps.
// This keeps the authorization/sequencing logic unit-testable and keeps the
// service-role key out of anything importable by the browser bundle (same
// split as serverAiSummary.ts / api/compliance/ai-summary.ts).
//
// Security model enforced here:
//   caller bearer token → resolve caller → read caller role FROM THE DATABASE
//   → require ddp_admin (fail closed) → validate input (no caller-supplied role
//   or id) → Admin-Auth invite → promote the resulting *pending* profile to
//   farmer. A partial success (invited but not promoted) is reported as such.

export interface ProvisionCaller {
  id: string
}

export interface FarmerInviteInput {
  email: string
  displayName?: string
  province?: string
  phoneNumber?: string
  lineId?: string
}

export type InviteResult =
  | { kind: 'invited'; userId: string }
  | { kind: 'already_exists' }
  | { kind: 'error'; message: string }

export interface ProvisioningDeps {
  /** Resolve the caller from their bearer token; null if invalid/expired. */
  getCallerFromToken(token: string): Promise<ProvisionCaller | null>
  /** Read a user's profiles.role via the service role; null if no profile row. */
  getProfileRole(userId: string): Promise<string | null>
  /** Invite a new farmer by email via Supabase Admin Auth. */
  inviteFarmer(input: FarmerInviteInput): Promise<InviteResult>
  /**
   * Promote a *pending* profile to 'farmer'. Must only affect a row whose
   * current role is 'pending'; returns whether exactly such a row changed.
   */
  promotePendingToFarmer(userId: string): Promise<boolean>
}

export interface ProvisionHttpRequest {
  token: string | null
  body: unknown
}

export interface ProvisionHttpResponse {
  status: number
  body: Record<string, unknown>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Fields a caller must never be able to set — they would let the caller choose
// the resulting role or target an arbitrary profile row.
const FORBIDDEN_BODY_KEYS = ['role', 'id', 'userId', 'user_id', 'profileId', 'profile_id']
// Upper bounds on invited-user metadata. An over-length field is REJECTED (fail
// closed), never silently truncated — oversized values must not be written to the
// auth user record (DDP audit: no length bounds on farmer-invite metadata).
const MAX_LENGTHS = { email: 254, displayName: 120, province: 85, phoneNumber: 32, lineId: 64 }

export async function handleProvisionFarmer(
  deps: ProvisioningDeps,
  req: ProvisionHttpRequest,
): Promise<ProvisionHttpResponse> {
  // 1. Authentication — a valid bearer token is mandatory.
  if (!req.token) return deny(401, 'Authentication required.')
  const caller = await deps.getCallerFromToken(req.token)
  if (!caller) return deny(401, 'Invalid or expired session.')

  // 2. Authorization — the caller's role is read from the database, never from
  //    the request body or token metadata. Missing/non-admin → fail closed.
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
  if (email.length > MAX_LENGTHS.email) return deny(400, 'The email address is too long.')

  const displayName = optionalStr(body.display_name ?? body.displayName)
  const province = optionalStr(body.province)
  const phoneNumber = optionalStr(body.phone_number ?? body.phoneNumber)
  const lineId = optionalStr(body.line_id ?? body.lineId)
  const boundedFields: Array<[string, string | undefined, number]> = [
    ['display name', displayName, MAX_LENGTHS.displayName],
    ['province', province, MAX_LENGTHS.province],
    ['phone number', phoneNumber, MAX_LENGTHS.phoneNumber],
    ['LINE id', lineId, MAX_LENGTHS.lineId],
  ]
  const overLength = boundedFields.find(([, value, max]) => typeof value === 'string' && value.length > max)
  if (overLength) return deny(400, `The ${overLength[0]} exceeds the ${overLength[2]}-character maximum.`)

  const input: FarmerInviteInput = { email, displayName, province, phoneNumber, lineId }

  // 4. Invite the user via Admin Auth.
  const invite = await deps.inviteFarmer(input)
  if (invite.kind === 'already_exists') {
    // Deliberately NOT auto-promoted by email: an email match does not prove
    // account ownership (pre-registration / typo risk). The admin resolves an
    // existing account explicitly by user id via the pending-approval path.
    return deny(409, 'A user with this email already exists. Review pending users and approve by user id if appropriate.', {
      reason: 'user_already_exists',
      recovery: 'review_pending_users',
    })
  }
  if (invite.kind === 'error') {
    // Do NOT return the raw Supabase Admin-Auth error to the client — it can leak
    // internal auth-provider wording. Surface a coded, generic message; the raw
    // `invite.message` stays server-side for the adapter's observability layer to
    // log, consistent with the ai-summary route's generic-error discipline.
    return {
      status: 502,
      body: { ok: false, stage: 'invite', reason: 'invite_failed', error: 'The invitation could not be sent. Please retry, or contact support if it persists.' },
    }
  }

  // 5. Promote the resulting pending profile to farmer. This both confirms the
  //    pending profile exists and elevates it in one authorized DB operation.
  const promoted = await deps.promotePendingToFarmer(invite.userId)
  if (!promoted) {
    // Partial outcome: the Auth user now exists but is NOT an operational farmer.
    // This is NOT retryable via the same email through this endpoint — a repeat
    // POST would hit the existing-user 409 above. The account must be approved
    // explicitly by user id via the pending-approval path.
    return {
      status: 502,
      body: {
        ok: false,
        stage: 'promotion',
        reason: 'promotion_required',
        userId: invite.userId,
        recovery: 'approve_pending_user_by_id',
        error:
          'The Auth user was invited but its profile remains pending; it was not promoted to farmer. '
          + 'Do NOT retry this email (a repeat invite returns a 409 existing-user conflict). '
          + 'Approve the pending account explicitly by userId via the pending-user approval path.',
      },
    }
  }

  return {
    status: 200,
    body: { ok: true, userId: invite.userId, promoted: true, alreadyExisted: false },
  }
}

function deny(status: number, error: string, extra: Record<string, unknown> = {}): ProvisionHttpResponse {
  return { status, body: { ok: false, error, ...extra } }
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
