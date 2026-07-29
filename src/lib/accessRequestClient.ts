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
// Submission currently inserts into Supabase directly from the browser, under
// migration 34's `farmer_access_requests: public submit` anon policy. That is a
// TEMPORARY INCIDENT REVERT of #85 and it reopens audit finding R5 — see the
// block comment on submitAccessRequest() for why, and for the condition under
// which it must be undone. The intended end state is a POST to our own server
// function, /api/public/access-request, which throttles per client and inserts
// with a server-side credential; that endpoint cannot work until migration 36 is
// applied, because the RPCs it calls do not exist until then.
//
// Either way the row is pinned to status='new' with no reviewer, by the INSERT
// policy's WITH CHECK.
//
// Reads remain admin-only — a submitter cannot read back their own request, or
// anyone else's. The administrator's view of the queue is accessRequestAdmin.ts.

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
 *
 * *** TEMPORARY — INCIDENT REVERT, 2026-07-29. UNDO WHEN THE CONDITION BELOW IS MET. ***
 * ---------------------------------------------------------------------------------
 * This writes browser -> Supabase directly, which is the pre-#85 behaviour and
 * REOPENS AUDIT FINDING R5: the write does not traverse Vercel, so no edge
 * throttle can see it and public intake is unbounded again.
 *
 * WHY IT WAS REVERTED. #85 pointed this client at /api/public/access-request.
 * That endpoint calls two RPCs — public.reserve_public_intake_slot() and
 * public.has_open_access_request() — which exist ONLY in migration 36. Migration
 * 36 is applied NOWHERE (measured against production, read-only, 2026-07-29:
 * both absent from pg_proc, and public.public_intake_attempts absent). The
 * endpoint therefore fails closed with 503 on every real submission, and the
 * public supplier form has been down since the #85 deploy.
 *
 * Note that setting the server-only Supabase key that audit R1 names (the one
 * api/public/access-request.ts reads, spelled out there and in the runbook — it
 * is deliberately not spelled here, because a boundary test forbids that token
 * anywhere in shipped client source) alone does NOT fix it. The handler
 * checks method -> deps -> body -> bucket -> throttle in that order, so the key
 * turns an invalid-body probe from 503 into 400 while every VALID submission
 * still 503s at the missing throttle RPC. The probe reads as "configured" while
 * the form is still broken. Do not accept it as proof.
 *
 * UNDO CONDITION — all three, in this order:
 *   1. The server-only Supabase key (audit R1) is set for Vercel Production.
 *   2. This revert is itself reverted and deployed, so the deployed client posts
 *      to /api/public/access-request again.
 *   3. Migration 36 is applied under authorised break-glass, and a real
 *      submission is confirmed end to end.
 * Step 2 must precede step 3: migration 36 revokes the anon INSERT that THIS
 * code depends on, so applying it while this revert is live takes the form
 * offline again.
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
    // PGRST205 = the table is not in PostgREST's schema cache, i.e. migration 34
    // has not been applied to this environment. Distinguished from a genuine
    // failure so the UI can tell the visitor to reach us another way instead of
    // asking them to retry something that cannot succeed.
    //
    // 42501 = insufficient_privilege, which is what migration 36 produces once it
    // revokes the anon INSERT this path depends on. Mapped to the same honest
    // message so that applying 36 while this revert is still live degrades to
    // "contact us directly" rather than a bare "try again" the visitor cannot
    // ever satisfy.
    const code = (error as { code?: string }).code
    if (code === 'PGRST205' || code === '42501') {
      throw new AccessRequestError(
        'backend_unavailable',
        'The request form is not available yet. Please contact the DDP team directly.',
      )
    }
    // The driver message can name columns and constraints; keep it out of the UI.
    throw new AccessRequestError('submit_failed', 'The request could not be sent. Please try again.')
  }
}
