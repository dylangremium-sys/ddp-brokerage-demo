// ─── Subscription consent: the decisions, separated from the plumbing ───────
//
// WHY THIS IS A PURE MODULE
//   Everything here decides something — whether an address is acceptable, what
//   two spellings of one mailbox share, what a token looks like, what state a
//   click may move a subscription to. None of it needs a database, a mail
//   server or a credential, so all of it can be tested without one, and the
//   serverless endpoint is left holding only I/O.
//
// THE CONSENT MODEL, AND WHY IT IS THE STRICT ONE
//   Double opt-in. An address is stored `pending` and receives exactly one
//   message: a confirmation. Only a click moves it to `confirmed`. Nothing else
//   is ever sent to an unconfirmed address, and an address that is never
//   confirmed is never written to again.
//
//   Germany is the largest target market and applies the strictest reading of
//   consent for commercial email in the EU. Single opt-in — capture and start
//   sending — is what generates complaints there. An unconfirmed address is a
//   liability, not an asset: it cannot be evidenced, and sending to it is the
//   thing that gets a sending domain blocked.
//
// WHAT IS DELIBERATELY NOT COLLECTED
//   No name, company, role or country. A subscription needs an address and
//   evidence of consent. Everything else is data that must be justified,
//   protected, disclosed on request and deleted on request — and the cheapest
//   way to hold personal data safely is to hold less of it.

/**
 * The exact wording a subscriber agrees to.
 *
 * Stored against every subscription, so that changing the sign-up copy later
 * cannot retroactively alter what somebody already consented to. It says what
 * arrives, how often, and how to stop — the three things a consent statement
 * has to answer to be worth anything.
 */
export const CONSENT_TEXT =
  'I agree to receive DDP Brokerage regulatory updates by email, usually once or twice a week. I can unsubscribe from any message.'

export type SubscriptionStatus = 'pending' | 'confirmed' | 'unsubscribed'

export class SubscriptionError extends Error {}

/**
 * Whether an address is worth attempting delivery to.
 *
 * Shape only, deliberately. The real validation is the confirmation arriving —
 * an address that passes every syntactic check and does not exist is caught by
 * the same mechanism as one that does exist and whose owner ignores it, which
 * is the point of double opt-in.
 */
export function isPlausibleAddress(address: string): boolean {
  const trimmed = address.trim()
  if (trimmed.length < 5 || trimmed.length > 254) return false
  if (/\s/.test(trimmed)) return false

  const parts = trimmed.split('@')
  if (parts.length !== 2) return false

  const [local, domain] = parts
  if (local.length === 0 || local.length > 64) return false
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false
  if (domain.includes('..')) return false

  return true
}

/**
 * The form two spellings of one mailbox share.
 *
 * Lower-cased always. For providers that are documented to ignore them, dots in
 * the local part and everything after a `+` are removed as well — so
 * `A.Person+updates@gmail.com` and `aperson@gmail.com` cannot become two
 * subscriptions, two confirmation emails and two entries in an unsubscribe list
 * that only removes one of them.
 *
 * This is used ONLY for deduplication. Mail is always addressed to what the
 * person typed, because the canonical form is not guaranteed to be deliverable
 * and because receiving mail addressed to an address you did not give is
 * unsettling.
 */
const DOT_AND_PLUS_INSENSITIVE = new Set([
  'gmail.com',
  'googlemail.com',
])

export function canonicaliseAddress(address: string): string | null {
  if (!isPlausibleAddress(address)) return null

  const trimmed = address.trim().toLowerCase()
  const [local, domain] = trimmed.split('@')

  if (!DOT_AND_PLUS_INSENSITIVE.has(domain)) return `${local}@${domain}`

  const withoutTag = local.split('+')[0]
  const withoutDots = withoutTag.replace(/\./g, '')
  // A local part that was nothing but dots and a tag is not an address.
  return withoutDots.length === 0 ? null : `${withoutDots}@${domain}`
}

/**
 * Whether a token is the right shape to be one of ours.
 *
 * Length and alphabet only — the actual check is that it matches a row. This
 * exists so a malformed token is rejected before it becomes a database query,
 * which keeps an obvious probe from costing a round trip.
 */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(token)
}

export interface SubscriptionState {
  status: SubscriptionStatus
}

/**
 * What a confirmation click may do.
 *
 * Confirming twice is not an error the visitor should see — a forwarded link,
 * a mail client prefetching, a second click on a slow connection all produce
 * it, and showing a failure would tell somebody their subscription is broken
 * when it is working. It is idempotent, and the caller is told nothing changed
 * so it does not rewrite a confirmation timestamp that is already evidence.
 *
 * Confirming an unsubscribed address is refused. Re-subscribing has to start
 * from the form, because the consent that was withdrawn cannot be restored by
 * clicking a link that was issued before it was withdrawn.
 */
export function resolveConfirmation(
  state: SubscriptionState,
): { outcome: 'confirmed'; changed: boolean } {
  switch (state.status) {
    case 'pending':
      return { outcome: 'confirmed', changed: true }
    case 'confirmed':
      return { outcome: 'confirmed', changed: false }
    case 'unsubscribed':
      throw new SubscriptionError(
        'this address unsubscribed; confirming an old link cannot restore consent that was withdrawn',
      )
  }
}

/**
 * What an unsubscribe click may do.
 *
 * Always succeeds from the visitor's point of view, including for an address
 * that was never confirmed or has already unsubscribed. Unsubscribing must
 * never fail: a person trying to stop mail and being shown an error is the
 * worst outcome available, and it is the one that turns into a complaint.
 */
export function resolveUnsubscribe(
  state: SubscriptionState,
): { outcome: 'unsubscribed'; changed: boolean } {
  return { outcome: 'unsubscribed', changed: state.status !== 'unsubscribed' }
}

/**
 * What the endpoint tells a caller after a sign-up attempt.
 *
 * ALWAYS THE SAME, whether the address was new, already pending, already
 * confirmed, or malformed in a way that got past the form. Distinguishing them
 * would turn the endpoint into a way to ask "is this address subscribed?",
 * which is a disclosure about a third party to anyone who can type an address.
 *
 * The honest phrasing is therefore about what was done, not about what was
 * found: a confirmation has been sent IF the address can receive one.
 */
export const SIGNUP_RESPONSE =
  'If that address can receive mail, a confirmation has been sent to it. The subscription starts when you click the link.'
