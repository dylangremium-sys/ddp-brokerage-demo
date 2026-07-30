import { supabase } from '../lib/supabase'

// Narrowly scoped client wrapper for the DDP admin farmer-invitation endpoint.
// It calls the server-side /api/admin/provision-farmer function with the
// caller's own authenticated access token. It never handles a service-role key
// — all privileged work happens server-side behind the token check.

export interface InviteFarmerInput {
  email: string
  displayName?: string
  province?: string
  phoneNumber?: string
  lineId?: string
}

// Stable machine-readable reasons the server returns so callers can branch
// without parsing the human message. 'promotion_required' means the Auth user
// exists but is still pending — the admin must approve it explicitly BY USER ID
// (recovery 'approve_pending_user_by_id'); it is NOT retryable by email here.
export type InviteFarmerReason =
  | 'user_already_exists'
  | 'invite_failed'
  | 'promotion_required'
export type InviteFarmerRecovery =
  | 'review_pending_users'
  | 'approve_pending_user_by_id'

export type InviteFarmerResult =
  | { ok: true; userId: string }
  | {
      ok: false
      error: string
      stage?: string
      reason?: InviteFarmerReason
      recovery?: InviteFarmerRecovery
      userId?: string
    }

// ── Resend invitation ───────────────────────────────────────────────────────
// For a supplier whose invitation expired before they opened it. The public
// "forgot password" path cannot help them: their identity is still unconfirmed,
// so Supabase sends no recovery mail at all. Only an admin re-issue works.

export type ResendReason =
  | 'no_such_account'
  | 'ambiguous_account'
  | 'already_active'
  | 'reissue_failed'
export type ResendRecovery =
  | 'invite_and_create_account'
  | 'resolve_duplicate_profiles'
  | 'use_password_reset'

export type ResendResult =
  /** The provider sent the email; nothing further for the admin to do. */
  | { ok: true; delivered: 'email' }
  /**
   * The provider would not send, but a valid one-time link exists. The ADMIN
   * delivers it. Treat it as a credential — anyone holding it can set the
   * supplier's password.
   */
  | { ok: true; delivered: 'link'; actionLink: string }
  | { ok: false; error: string; reason?: ResendReason; recovery?: ResendRecovery }

const RESEND_ENDPOINT = '/api/admin/resend-invitation'

export async function resendInvitation(email: string): Promise<ResendResult> {
  if (!supabase) return { ok: false, error: 'Supabase not configured.' }

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return { ok: false, error: 'You must be signed in as a DDP admin.' }

  let res: Response
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email }),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error.' }
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && body.ok === true) {
    return body.delivered === 'link' && typeof body.actionLink === 'string'
      ? { ok: true, delivered: 'link', actionLink: body.actionLink }
      : { ok: true, delivered: 'email' }
  }
  return {
    ok: false,
    error: typeof body.error === 'string' ? body.error : 'The invitation could not be re-issued.',
    reason: typeof body.reason === 'string' ? (body.reason as ResendReason) : undefined,
    recovery: typeof body.recovery === 'string' ? (body.recovery as ResendRecovery) : undefined,
  }
}

const ENDPOINT = '/api/admin/provision-farmer'

export async function inviteFarmer(input: InviteFarmerInput): Promise<InviteFarmerResult> {
  if (!supabase) return { ok: false, error: 'Supabase not configured.' }

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return { ok: false, error: 'You must be signed in as a DDP admin.' }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: input.email,
        display_name: input.displayName,
        province: input.province,
        phone_number: input.phoneNumber,
        line_id: input.lineId,
      }),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error.' }
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && body.ok === true) {
    return { ok: true, userId: String(body.userId ?? '') }
  }
  return {
    ok: false,
    error: typeof body.error === 'string' ? body.error : 'Provisioning failed.',
    stage: typeof body.stage === 'string' ? body.stage : undefined,
    reason: typeof body.reason === 'string' ? (body.reason as InviteFarmerReason) : undefined,
    recovery: typeof body.recovery === 'string' ? (body.recovery as InviteFarmerRecovery) : undefined,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
  }
}
