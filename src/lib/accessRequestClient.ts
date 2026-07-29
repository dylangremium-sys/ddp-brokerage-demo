// ─── Farmer access requests — client ────────────────────────────────────────
//
// Replaces the previous "signup" behaviour, which wrote the visitor's details to
// their own localStorage and routed them to a dashboard requiring a session that
// was never created (src/data.ts saveFarmDraft; src/App.tsx goTo('farmer-dashboard')).
//
// DDP provisioning is deliberately admin-only (migration 21): a farmer account
// is created by an administrator inviting them by email. So this submits an
// ENQUIRY to a real, server-side queue and tells the visitor the truth about
// what happens next. It never creates an account and never grants a role.
//
// Submission POSTs to our own server function, /api/public/access-request, which
// rate-limits per client and inserts using its own server-side credential (audit
// fix R5). It does NOT insert into Supabase from the browser: that path never
// traversed Vercel, so no edge rate limit could see it, and migration 36 revokes
// the anon INSERT that made it possible. The row is still pinned to status='new'
// with no reviewer, by the server-only INSERT policy migration 36 substitutes.
//
// Reads remain admin-only — a submitter cannot read back their own request, or
// anyone else's. The administrator's view of the queue is accessRequestAdmin.ts.

import { isSupabaseConfigured } from './supabase'

export interface AccessRequestInput {
  fullName: string
  email: string
  phone: string
  province: string
  position: string
  preferredLanguage: 'en' | 'th'
  note?: string
}

export type AccessRequestErrorCode =
  | 'not_configured'
  | 'invalid_input'
  | 'submit_failed'
  /**
   * The intake endpoint is not configured, or its throttle could not be
   * evaluated. Either way the request cannot succeed by retrying.
   */
  | 'backend_unavailable'
  /** The caller has exceeded the public-intake throttle (migration 36). */
  | 'rate_limited'

export class AccessRequestError extends Error {
  readonly code: AccessRequestErrorCode
  constructor(code: AccessRequestErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'AccessRequestError'
  }
}

/** Mirrors the migration-34 column CHECKs so the user sees the problem before a round trip. */
export function validateAccessRequest(input: AccessRequestInput): string | null {
  const name = input.fullName.trim()
  const email = input.email.trim()
  const phone = input.phone.trim()

  if (name.length < 1 || name.length > 120) return 'name'
  if (email.length < 5 || email.length > 254) return 'email'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'email'
  if (phone.length < 5 || phone.length > 40) return 'phone'
  if ((input.note ?? '').length > 2000) return 'note'
  return null
}

/**
 * Submit an access request.
 *
 * Returns nothing on success: there is deliberately no row to read back, because
 * the queue is admin-only. The caller shows a confirmation from the fact that no
 * error was thrown.
 */
export async function submitAccessRequest(input: AccessRequestInput): Promise<void> {
  if (!isSupabaseConfigured) {
    throw new AccessRequestError(
      'not_configured',
      'The request could not be sent because the backend is not configured.',
    )
  }

  const invalid = validateAccessRequest(input)
  if (invalid) {
    throw new AccessRequestError('invalid_input', `The ${invalid} field is not valid.`)
  }

  // Submission goes through our own server function, NOT browser -> Supabase.
  // That is the entire point of audit fix R5: a direct Supabase insert never
  // traverses Vercel, so no edge rate limit can see it. Migration 36 revokes the
  // anon INSERT so this is the only remaining path.
  let response: Response
  try {
    response = await fetch('/api/public/access-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: input.fullName.trim(),
        email: input.email.trim(),
        phone: input.phone.trim(),
        province: input.province,
        position: input.position,
        preferredLanguage: input.preferredLanguage,
        note: (input.note ?? '').trim(),
      }),
    })
  } catch {
    throw new AccessRequestError('submit_failed', 'The request could not be sent. Please try again.')
  }

  if (response.ok) return

  // 503 = the endpoint is deployed but not configured, or the throttle could not
  // be evaluated. Distinguished from a genuine failure so the UI tells the
  // visitor to reach us another way rather than asking them to retry something
  // that cannot succeed — the same honest path the direct-insert version used
  // for PGRST205, and what makes the app safe to deploy before migration 36.
  if (response.status === 503) {
    throw new AccessRequestError(
      'backend_unavailable',
      'The request form is not available yet. Please contact the DDP team directly.',
    )
  }

  if (response.status === 429) {
    throw new AccessRequestError(
      'rate_limited',
      'Too many requests have been sent from this connection. Please try again later, or contact the DDP team directly.',
    )
  }

  if (response.status === 400) {
    throw new AccessRequestError('invalid_input', 'One of the fields is not valid.')
  }

  throw new AccessRequestError('submit_failed', 'The request could not be sent. Please try again.')
}
