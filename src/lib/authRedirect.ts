// ─── Auth redirect capture (invite / password recovery) ─────────────────────
//
// WHY THIS EXISTS
//   Supabase delivers an invite or password-reset link as a URL *fragment*:
//
//     https://www.ddpbrokerage.com/#access_token=…&refresh_token=…&type=invite
//
//   supabase-js consumes that fragment during its asynchronous initialise
//   (`detectSessionInUrl` defaults to true), establishes the session, and then
//   STRIPS the fragment from window.location. By the time any React effect runs
//   the fragment is already gone — so the app can no longer distinguish an
//   invited supplier, who MUST be sent to a set-password screen, from an
//   ordinary restored session, who must not be interrupted.
//
//   Before this module there was no set-password screen at all: an invited
//   supplier clicked the email link, received one transient session, and had no
//   way to choose a password. When that session expired they could never sign in
//   again, and supplier onboarding could not complete.
//
// WHY IT CAPTURES AT MODULE SCOPE
//   The capture must win the race against detectSessionInUrl. lib/supabase.ts
//   imports this module, and ES module evaluation order guarantees an imported
//   module's body runs to completion before the importing module's body — so
//   this read always happens before createClient() is ever constructed. Do not
//   move the capture into a function that supabase.ts calls lazily, and do not
//   remove the import from supabase.ts: either change reintroduces the race.
//
// The parsing itself is pure and lives in parseAuthRedirect/stripAuthParams so
// it is testable without a DOM (this repo runs vitest with environment: 'node').

/**
 * What an inbound Supabase auth redirect asks the app to do.
 *
 *   invite   → an admin-provisioned account opening its invitation for the
 *              first time. It has no password yet.
 *   recovery → a "forgot password" link. The account has a password; the user
 *              is replacing it.
 *   error    → the link was consumed, expired or tampered with. Supabase puts
 *              the reason in the fragment rather than granting a session.
 *
 * `invite` and `recovery` are handled identically by the UI — both end in
 * `auth.updateUser({ password })` — but they are kept distinct so the screen can
 * word itself correctly ("Choose your password" vs "Set a new password").
 */
export type AuthRedirect =
  | { kind: 'invite' }
  | { kind: 'recovery' }
  | { kind: 'error'; code: string | null; description: string | null }

/** Query/fragment keys that belong to an auth redirect and to nothing else. */
const AUTH_PARAM_KEYS = [
  'access_token',
  'refresh_token',
  'expires_in',
  'expires_at',
  'token_type',
  'provider_token',
  'provider_refresh_token',
  'type',
  'code',
  'token_hash',
  'error',
  'error_code',
  'error_description',
] as const

function params(raw: string): URLSearchParams {
  // Accepts a fragment ('#a=b'), a query ('?a=b') or a bare 'a=b'.
  return new URLSearchParams(raw.replace(/^[#?]/, ''))
}

/**
 * Classify an inbound URL as an auth redirect, or null if it is an ordinary
 * page load.
 *
 * Both the fragment and the query string are inspected. Supabase's default
 * implicit flow uses the fragment, but an error can arrive on either depending
 * on where the failure happened (the `/auth/v1/verify` hop vs the app itself),
 * and some project configurations append `type` to the query.
 *
 * An error anywhere wins: a URL carrying BOTH `error` and `type=recovery` is a
 * failed recovery, and treating it as a live one would show a password form
 * backed by no session.
 *
 * NOTE: a token is deliberately NOT required. A `type=invite` with no usable
 * token still means "this user came from an invite email", and the screen is
 * the right place to say the link is no longer valid and offer a fresh one —
 * far better than silently dropping them on the public landing page.
 */
export function parseAuthRedirect(hash: string, search: string): AuthRedirect | null {
  const fragment = params(hash)
  const query = params(search)
  const get = (key: string) => fragment.get(key) ?? query.get(key)

  const error = get('error') ?? get('error_code')
  if (error) {
    return {
      kind: 'error',
      code: get('error_code') ?? get('error'),
      // Supabase percent-encodes spaces as '+' here; URLSearchParams decodes it.
      description: get('error_description'),
    }
  }

  switch (get('type')) {
    case 'invite':
      return { kind: 'invite' }
    case 'recovery':
      return { kind: 'recovery' }
    default:
      return null
  }
}

/**
 * The same URL with every auth parameter removed, so a reload cannot re-enter
 * the set-password flow with a token that has already been spent.
 *
 * Only the keys in AUTH_PARAM_KEYS are dropped — unrelated query parameters and
 * a non-auth fragment survive untouched, so this can never eat application
 * state that happens to share the URL.
 */
export function stripAuthParams(url: string): string {
  const parsed = new URL(url)

  const query = parsed.searchParams
  for (const key of AUTH_PARAM_KEYS) query.delete(key)
  parsed.search = query.toString()

  if (parsed.hash) {
    const fragment = params(parsed.hash)
    // A fragment that carries no auth key at all is not ours to rewrite (e.g. a
    // plain '#section' anchor), so leave it exactly as found.
    const isAuthFragment = AUTH_PARAM_KEYS.some(key => fragment.has(key))
    if (isAuthFragment) {
      for (const key of AUTH_PARAM_KEYS) fragment.delete(key)
      const rest = fragment.toString()
      parsed.hash = rest ? `#${rest}` : ''
    }
  }

  return parsed.toString()
}

// ── Module-scope capture ────────────────────────────────────────────────────
// Read once, at import time, before supabase-js can strip the fragment.

let captured: AuthRedirect | null =
  typeof window === 'undefined'
    ? null
    : parseAuthRedirect(window.location.hash, window.location.search)

/**
 * The auth redirect this page load arrived with, or null.
 *
 * Stays truthy for the whole session until clearAuthRedirect() is called, so
 * every consumer — the initial page state, the auth subscription's routing
 * suppression, the rendered screen — reads one consistent answer. A getter
 * rather than an exported constant so the cleared state propagates.
 */
export function getAuthRedirect(): AuthRedirect | null {
  return captured
}

/**
 * Ends the set-password flow: forgets the captured redirect and scrubs the
 * auth parameters from the address bar.
 *
 * Called once the password has actually been set. Clearing it earlier would let
 * bootstrap routing fire while the user is still on the screen.
 */
export function clearAuthRedirect(): void {
  captured = null
  if (typeof window === 'undefined' || !window.history?.replaceState) return
  const cleaned = stripAuthParams(window.location.href)
  if (cleaned !== window.location.href) {
    window.history.replaceState(window.history.state, '', cleaned)
  }
}
