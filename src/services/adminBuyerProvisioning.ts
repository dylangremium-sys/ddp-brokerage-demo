import { supabase } from '../lib/supabase'

// Narrowly scoped client wrapper for the DDP admin buyer-invitation endpoint.
// Same shape and same discipline as adminProvisioning.ts: it calls the
// server-side /api/admin/provision-buyer function with the caller's own
// authenticated access token, and never handles a service-role key.

export interface InviteBuyerInput {
  email: string
  displayName?: string
  phoneNumber?: string
  /** Attach to an existing buyer organisation… */
  organisationId?: string
  /** …or create one. Provide exactly one of these two. */
  legalName?: string
  organisationDisplayName?: string
  countryCode?: string
  /** Membership role within the organisation. Defaults server-side to 'owner'. */
  orgRole?: 'owner' | 'admin' | 'operator' | 'viewer'
}

// Stable machine-readable reasons so callers can branch without parsing prose.
// The three failure stages after the organisation exists each leave a DIFFERENT
// amount of work done, and the recovery differs accordingly — see the ordering
// note in src/lib/serverBuyerProvisioning.ts.
export type InviteBuyerReason =
  | 'organisation_not_found'
  | 'organisation_failed'
  | 'user_already_exists'
  | 'invite_failed'
  | 'promotion_required'
  | 'membership_required'
export type InviteBuyerRecovery =
  | 'create_organisation'
  | 'review_pending_users'
  | 'approve_pending_user_by_id'
  | 'record_membership_by_id'

export type InviteBuyerResult =
  | {
      ok: true
      userId: string
      organisationId: string
      organisationCreated: boolean
      orgRole: string
    }
  | {
      ok: false
      error: string
      stage?: string
      reason?: InviteBuyerReason
      recovery?: InviteBuyerRecovery
      /** Present from the invite stage onward — the ids already created. */
      userId?: string
      organisationId?: string
      organisationCreated?: boolean
    }

const ENDPOINT = '/api/admin/provision-buyer'

export async function inviteBuyer(input: InviteBuyerInput): Promise<InviteBuyerResult> {
  if (!supabase) return { ok: false, error: 'Supabase not configured.' }

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return { ok: false, error: 'You must be signed in as a DDP admin.' }

  // Only the keys the admin actually supplied are sent. Sending
  // `organisation_id: undefined` would serialise away, but sending an empty
  // string would read as "both an id and new details", which the server
  // rejects — so empty values are dropped here rather than passed through.
  const body: Record<string, unknown> = { email: input.email }
  if (input.displayName) body.display_name = input.displayName
  if (input.phoneNumber) body.phone_number = input.phoneNumber
  if (input.orgRole) body.org_role = input.orgRole
  if (input.organisationId) {
    body.organisation_id = input.organisationId
  } else {
    if (input.legalName) body.legal_name = input.legalName
    if (input.organisationDisplayName) body.organisation_display_name = input.organisationDisplayName
    if (input.countryCode) body.country_code = input.countryCode
  }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error.' }
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && payload.ok === true) {
    return {
      ok: true,
      userId: String(payload.userId ?? ''),
      organisationId: String(payload.organisationId ?? ''),
      organisationCreated: payload.organisationCreated === true,
      orgRole: String(payload.orgRole ?? 'owner'),
    }
  }
  return {
    ok: false,
    error: typeof payload.error === 'string' ? payload.error : 'Buyer provisioning failed.',
    stage: typeof payload.stage === 'string' ? payload.stage : undefined,
    reason: typeof payload.reason === 'string' ? (payload.reason as InviteBuyerReason) : undefined,
    recovery: typeof payload.recovery === 'string' ? (payload.recovery as InviteBuyerRecovery) : undefined,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    organisationId: typeof payload.organisationId === 'string' ? payload.organisationId : undefined,
    organisationCreated: payload.organisationCreated === true,
  }
}
