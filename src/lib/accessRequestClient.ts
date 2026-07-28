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
// Submission is an anon INSERT under the migration-34 RLS policy, which pins the
// row to status='new' with no reviewer. Reads are admin-only — a submitter
// cannot read back their own request, or anyone else's.

import { supabase, isSupabaseConfigured } from './supabase'

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
  if (!supabase || !isSupabaseConfigured) {
    throw new AccessRequestError(
      'not_configured',
      'The request could not be sent because the backend is not configured.',
    )
  }

  const invalid = validateAccessRequest(input)
  if (invalid) {
    throw new AccessRequestError('invalid_input', `The ${invalid} field is not valid.`)
  }

  const { error } = await supabase.from('farmer_access_requests').insert({
    full_name: input.fullName.trim(),
    email: input.email.trim(),
    phone: input.phone.trim(),
    province: input.province,
    position: input.position,
    preferred_language: input.preferredLanguage,
    note: (input.note ?? '').trim(),
    status: 'new',
  })

  if (error) {
    // The driver message can name columns and constraints; keep it out of the UI.
    throw new AccessRequestError('submit_failed', 'The request could not be sent. Please try again.')
  }
}
