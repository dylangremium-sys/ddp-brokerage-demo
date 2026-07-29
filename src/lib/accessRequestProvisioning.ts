import type { InviteFarmerResult } from '../services/adminProvisioning'

// ─── What an admin's "Invite" click should do with a provisioning result ─────
//
// WHY THIS IS A PURE MODULE. The Supplier Enquiries page previously offered
// "Invited" as one of four plain status labels. Clicking it wrote
// status = 'invited' and did nothing else: no account was created and no email
// was sent, because `src/services/adminProvisioning.ts` was imported by ZERO
// components. The queue therefore recorded invitations that had never happened,
// and the only way to actually onboard a supplier was to leave the product and
// use the Supabase dashboard.
//
// The rule this module encodes: 'invited' means an account EXISTS. Nothing else
// may set it. Keeping that decision here — rather than inline in the component —
// is what lets it be tested without a browser, a session or a network.

export type ProvisionDecision =
  | { kind: 'invited'; markInvited: true; message: string }
  | { kind: 'already_exists'; markInvited: true; message: string }
  | { kind: 'promotion_required'; markInvited: false; message: string; userId?: string }
  | { kind: 'failed'; markInvited: false; message: string }

/**
 * Map a provisioning result to the queue's next action.
 *
 * `markInvited` is the load-bearing field: it is true ONLY when an account is
 * known to exist afterwards. A failure must never leave the enquiry looking
 * dispositioned — that is precisely the untruthfulness this replaces.
 */
export function resolveProvisionDecision(result: InviteFarmerResult): ProvisionDecision {
  if (result.ok) {
    return {
      kind: 'invited',
      markInvited: true,
      message: 'Account created and an invitation email sent. The supplier sets their own password.',
    }
  }

  switch (result.reason) {
    // The Auth user already exists — often because the supplier was invited by
    // hand before this button existed. The account is real, so recording the
    // enquiry as invited is the truthful outcome, not an error.
    case 'user_already_exists':
      return {
        kind: 'already_exists',
        markInvited: true,
        message: 'An account already exists for this address, so the enquiry is marked as invited. No second invitation was sent.',
      }

    // The Auth user exists but is still 'pending'. The server refuses to promote
    // by email — deliberately, since an email is not a safe identifier for a
    // privilege change — so this needs an explicit approval by user id.
    case 'promotion_required':
      return {
        kind: 'promotion_required',
        markInvited: false,
        message: result.userId
          ? `This address already has a pending account (user ${result.userId}). Approve that user explicitly — it was not promoted, and the enquiry is unchanged.`
          : 'This address already has a pending account. Approve that user explicitly — it was not promoted, and the enquiry is unchanged.',
      }

    default:
      return { kind: 'failed', markInvited: false, message: failureMessage(result) }
  }
}

/**
 * A message an administrator can act on.
 *
 * The server deliberately returns one generic string for every invite failure so
 * that provider errors cannot leak, which means a mistyped or undeliverable
 * address is indistinguishable from an outage. That ambiguity cost real time
 * during the 2026-07-29 launch verification: provisioning to an `@example.com`
 * address returned a bare "invitation could not be sent", which read as a broken
 * endpoint rather than an unroutable domain. So when the failure happened at the
 * invite stage, name deliverability as the first thing to check — without
 * claiming it IS the cause, because the server does not tell us that.
 */
function failureMessage(result: Extract<InviteFarmerResult, { ok: false }>): string {
  const base = result.error || 'Provisioning failed.'
  if (result.stage === 'invite') {
    return `${base} Check the email address is real and can receive mail — an undeliverable domain fails here and reports the same message.`
  }
  return base
}
