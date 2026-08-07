// Pure, dependency-injected core for the DDP admin buyer-invitation endpoint.
//
// Same split as serverFarmerProvisioning.ts: NO Supabase import, NO secrets and
// NO process.env access. The api/ adapter injects a service-role-backed
// implementation of BuyerProvisioningDeps, which keeps the service-role key out
// of anything importable by the browser bundle.
//
// WHY THIS EXISTS
// `profiles.role` has admitted 'buyer' since migration 39 and the organisation
// substrate (organisations, organisation_memberships, migration 46's
// verified-buyer read predicate) has been live with 0 rows and 0 code
// references. #174 taught the router what to do with a buyer. Nothing could
// create one. This is the missing step: a DDP admin onboards a buyer through
// the product rather than through SQL.
//
// Buyers are DDP-PROVISIONED ONLY. There is no self-registration path to this
// role and this endpoint is the only way to reach it — which is why the caller
// may never supply `role`, `org_type` or any verification field (see
// FORBIDDEN_BODY_KEYS).
//
// Security model enforced here, identical in shape to the farmer flow:
//   caller bearer token → resolve caller → read caller role FROM THE DATABASE
//   → require ddp_admin (fail closed) → validate input → resolve/create the
//   buyer organisation → Admin-Auth invite → promote the resulting *pending*
//   profile to buyer → record organisation membership.
//
// WHY THE STEPS ARE ORDERED THIS WAY
// Admin-Auth and PostgREST cannot share a transaction, so partial failure is a
// certainty to be designed for, not an edge case. The order is chosen so that
// every partial state is RECOVERABLE and the recovery is stated in the
// response:
//
//   organisation first — an organisation with no members is inert. It grants
//     nothing to nobody (organisations_select requires membership or admin), so
//     an orphan is harmless, and the admin retries by passing its
//     organisation_id back in. Inviting first would instead strand a real Auth
//     user with no organisation, and a repeat invite returns 409.
//   invite second, promote third — a profile left at 'pending' is a
//     NON-operational role; resolvePostLoginDecision denies it. The failure
//     mode is a locked-out account, never an under-privileged one that can
//     still see data.
//   membership last — because it is the step that actually grants sight of
//     anything. Until it lands, the buyer can sign in and see nothing, which is
//     the correct way round for a step that can fail.
//
// Every partial outcome below reports `stage`, `reason`, `recovery` and the ids
// created so far, so an admin can finish the job rather than guess at it.

export interface BuyerProvisionCaller {
  id: string
}

/** The organisation the buyer will belong to: an existing one, or one to create. */
export type BuyerOrganisationInput =
  | { kind: 'existing'; organisationId: string }
  | { kind: 'new'; legalName: string; displayName?: string; countryCode: string }

export interface BuyerInviteInput {
  email: string
  displayName?: string
  phoneNumber?: string
}

export type BuyerInviteResult =
  | { kind: 'invited'; userId: string }
  | { kind: 'already_exists' }
  | { kind: 'error'; message: string }

export type OrganisationResult =
  | { kind: 'resolved'; organisationId: string; created: boolean }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }

export interface BuyerProvisioningDeps {
  /** Resolve the caller from their bearer token; null if invalid/expired. */
  getCallerFromToken(token: string): Promise<BuyerProvisionCaller | null>
  /** Read a user's profiles.role via the service role; null if no profile row. */
  getProfileRole(userId: string): Promise<string | null>
  /**
   * Resolve an existing buyer organisation by id, or create a new one.
   *
   * MUST create with org_type 'buyer' and leave verification_state at its
   * 'unverified' default — this endpoint never verifies an organisation.
   * MUST NOT return an organisation whose org_type is not 'buyer': a farm or
   * laboratory organisation is not a thing a buyer may be attached to here.
   */
  resolveOrCreateOrganisation(input: BuyerOrganisationInput): Promise<OrganisationResult>
  /** Invite a new buyer by email via Supabase Admin Auth. */
  inviteBuyer(input: BuyerInviteInput): Promise<BuyerInviteResult>
  /**
   * Promote a *pending* profile to 'buyer'. Must only affect a row whose
   * current role is 'pending' (handle_new_user() pre-creates profiles at
   * 'pending'); returns whether exactly such a row changed.
   */
  promotePendingToBuyer(userId: string): Promise<boolean>
  /** Record the buyer's membership of the organisation. Idempotent on (org, user). */
  recordMembership(organisationId: string, userId: string, orgRole: string): Promise<boolean>
}

export interface BuyerProvisionHttpRequest {
  token: string | null
  body: unknown
}

export interface BuyerProvisionHttpResponse {
  status: number
  body: Record<string, unknown>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// `organisations_country_code_check` is CHECK (country_code ~ '^[A-Z]{2}$').
// Validated here so a bad value fails with a readable message instead of a
// constraint violation surfacing as a 502.
const COUNTRY_CODE_RE = /^[A-Z]{2}$/
// `organisation_memberships_org_role_check`.
const ORG_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const

// Fields a caller must never set. The first four are the farmer flow's: they
// would let a caller choose the resulting role or target an arbitrary profile.
// The rest are specific to organisations — `org_type` would let a caller attach
// a buyer to a farm or laboratory organisation, and the verification fields
// would let a caller mark their own organisation VERIFIED, which is a human
// decision recorded against a named admin, not a request parameter.
const FORBIDDEN_BODY_KEYS = [
  'role', 'id', 'userId', 'user_id', 'profileId', 'profile_id',
  'org_type', 'orgType',
  'verification_state', 'verificationState',
  'verified_by', 'verifiedBy', 'verified_at', 'verifiedAt',
  'verification_basis', 'verificationBasis',
  'farm_id', 'farmId',
]

const MAX_LENGTHS = { email: 254, displayName: 120, phoneNumber: 32, legalName: 200, orgDisplayName: 120 }

export async function handleProvisionBuyer(
  deps: BuyerProvisioningDeps,
  req: BuyerProvisionHttpRequest,
): Promise<BuyerProvisionHttpResponse> {
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
  const phoneNumber = optionalStr(body.phone_number ?? body.phoneNumber)
  const boundedFields: Array<[string, string | undefined, number]> = [
    ['display name', displayName, MAX_LENGTHS.displayName],
    ['phone number', phoneNumber, MAX_LENGTHS.phoneNumber],
  ]
  const overLength = boundedFields.find(([, value, max]) => typeof value === 'string' && value.length > max)
  if (overLength) return deny(400, `The ${overLength[0]} exceeds the ${overLength[2]}-character maximum.`)

  const orgRole = optionalStr(body.org_role ?? body.orgRole) ?? 'owner'
  if (!(ORG_ROLES as readonly string[]).includes(orgRole)) {
    return deny(400, `The organisation role must be one of: ${ORG_ROLES.join(', ')}.`)
  }

  const organisation = parseOrganisation(body)
  if ('error' in organisation) return deny(400, organisation.error)

  // 4. Resolve or create the organisation FIRST — see the ordering note above.
  const org = await deps.resolveOrCreateOrganisation(organisation.value)
  if (org.kind === 'not_found') {
    return deny(404, 'No buyer organisation with that id exists.', {
      stage: 'organisation',
      reason: 'organisation_not_found',
      recovery: 'create_organisation',
    })
  }
  if (org.kind === 'error') {
    return {
      status: 502,
      body: {
        ok: false, stage: 'organisation', reason: 'organisation_failed',
        error: 'The buyer organisation could not be created. Nothing else was changed; retry is safe.',
      },
    }
  }

  // 5. Invite the user via Admin Auth.
  const invite = await deps.inviteBuyer({ email, displayName, phoneNumber })
  if (invite.kind === 'already_exists') {
    // Same reasoning as the farmer flow: an email match does not prove account
    // ownership, so this never auto-promotes an existing account. The
    // organisation created in step 4 is retained and named, so the admin can
    // retry against it rather than creating a duplicate.
    return deny(409, 'A user with this email already exists. Review pending users and approve by user id if appropriate.', {
      stage: 'invite',
      reason: 'user_already_exists',
      recovery: 'review_pending_users',
      organisationId: org.organisationId,
      organisationCreated: org.created,
    })
  }
  if (invite.kind === 'error') {
    // The raw Admin-Auth message stays server-side; it can leak auth-provider
    // internals. Same discipline as the farmer route.
    return {
      status: 502,
      body: {
        ok: false, stage: 'invite', reason: 'invite_failed',
        organisationId: org.organisationId,
        organisationCreated: org.created,
        error: 'The invitation could not be sent. The organisation was created; retry with its organisationId.',
      },
    }
  }

  // 6. Promote the pending profile to buyer.
  const promoted = await deps.promotePendingToBuyer(invite.userId)
  if (!promoted) {
    // Partial: the Auth user exists but its profile is still 'pending', which
    // is non-operational — the account is locked out, not under-privileged.
    // NOT retryable by email (a repeat invite returns the 409 above).
    return {
      status: 502,
      body: {
        ok: false, stage: 'promotion', reason: 'promotion_required',
        userId: invite.userId,
        organisationId: org.organisationId,
        organisationCreated: org.created,
        recovery: 'approve_pending_user_by_id',
        error:
          'The Auth user was invited but its profile remains pending; it was not promoted to buyer. '
          + 'Do NOT retry this email (a repeat invite returns a 409 existing-user conflict). '
          + 'Approve the pending account explicitly by userId.',
      },
    }
  }

  // 7. Record membership — the step that actually grants sight of anything.
  const member = await deps.recordMembership(org.organisationId, invite.userId, orgRole)
  if (!member) {
    // Partial: a real buyer who can sign in and see nothing. Safe, and the
    // recovery is a single membership insert against ids we return here.
    return {
      status: 502,
      body: {
        ok: false, stage: 'membership', reason: 'membership_required',
        userId: invite.userId,
        organisationId: org.organisationId,
        organisationCreated: org.created,
        orgRole,
        recovery: 'record_membership_by_id',
        error:
          'The buyer account was created but its organisation membership was not recorded, so it can '
          + 'sign in and see nothing. Add the membership using the userId and organisationId returned here.',
      },
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      userId: invite.userId,
      organisationId: org.organisationId,
      organisationCreated: org.created,
      orgRole,
      promoted: true,
      alreadyExisted: false,
    },
  }
}

function parseOrganisation(
  body: Record<string, unknown>,
): { value: BuyerOrganisationInput } | { error: string } {
  const existingId = optionalStr(body.organisation_id ?? body.organisationId)
  const legalName = optionalStr(body.legal_name ?? body.legalName)

  if (existingId && legalName) {
    return { error: 'Provide either an existing organisationId or new organisation details, not both.' }
  }

  if (existingId) {
    if (!UUID_RE.test(existingId)) return { error: 'The organisationId must be a UUID.' }
    return { value: { kind: 'existing', organisationId: existingId } }
  }

  if (!legalName) {
    return { error: 'An organisationId, or a legalName and countryCode for a new organisation, is required.' }
  }
  if (legalName.length > MAX_LENGTHS.legalName) {
    return { error: `The legal name exceeds the ${MAX_LENGTHS.legalName}-character maximum.` }
  }

  // Uppercased before validation so 'th' is accepted and stored as 'TH'. The
  // CHECK is case-sensitive; rejecting a lowercase code would be a rule the
  // form never states.
  const rawCountry = optionalStr(body.country_code ?? body.countryCode) ?? ''
  const countryCode = rawCountry.toUpperCase()
  if (!COUNTRY_CODE_RE.test(countryCode)) {
    return { error: 'A two-letter ISO country code is required for a new organisation.' }
  }

  const orgDisplayName = optionalStr(body.organisation_display_name ?? body.organisationDisplayName)
  if (orgDisplayName && orgDisplayName.length > MAX_LENGTHS.orgDisplayName) {
    return { error: `The organisation display name exceeds the ${MAX_LENGTHS.orgDisplayName}-character maximum.` }
  }

  return { value: { kind: 'new', legalName, displayName: orgDisplayName, countryCode } }
}

function deny(status: number, error: string, extra: Record<string, unknown> = {}): BuyerProvisionHttpResponse {
  return { status, body: { ok: false, error, ...extra } }
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
