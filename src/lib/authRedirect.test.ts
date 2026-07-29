// Auth redirect parsing — the gate that decides whether an invited supplier is
// shown the set-password screen at all.
//
// Getting this wrong is not a cosmetic failure. A missed 'invite' drops the user
// on a dashboard with a transient session and no password, and the account
// becomes permanently unreachable when that session expires. A false positive
// interrupts a signed-in operator with a password form they did not ask for.

import { describe, it, expect } from 'vitest'
import { parseAuthRedirect, stripAuthParams } from './authRedirect'

describe('parseAuthRedirect', () => {
  it('recognises the invite fragment Supabase actually sends', () => {
    // Shape taken from a real GoTrue implicit-flow redirect.
    const hash =
      '#access_token=eyJhbGciOi.abc.def&expires_at=1785000000&expires_in=3600' +
      '&refresh_token=x7Kq2p&token_type=bearer&type=invite'
    expect(parseAuthRedirect(hash, '')).toEqual({ kind: 'invite' })
  })

  it('recognises the recovery fragment', () => {
    const hash = '#access_token=eyJhbGciOi.abc.def&refresh_token=x7Kq2p&type=recovery'
    expect(parseAuthRedirect(hash, '')).toEqual({ kind: 'recovery' })
  })

  it('reads type from the query string too', () => {
    // Some project configurations put it there instead of in the fragment.
    expect(parseAuthRedirect('', '?type=recovery')).toEqual({ kind: 'recovery' })
  })

  it('classifies an expired link as an error, with the reason preserved', () => {
    const hash =
      '#error=access_denied&error_code=otp_expired' +
      '&error_description=Email+link+is+invalid+or+has+expired'
    expect(parseAuthRedirect(hash, '')).toEqual({
      kind: 'error',
      code: 'otp_expired',
      // '+' is the encoding for a space here; the user must read a sentence.
      description: 'Email link is invalid or has expired',
    })
  })

  it('treats an error as an error even when a type is also present', () => {
    // A failed recovery still carries type=recovery. Reading the type first
    // would render a password form backed by no session — a form that cannot
    // succeed and never says why.
    const result = parseAuthRedirect('#error=access_denied&type=recovery', '')
    expect(result?.kind).toBe('error')
  })

  it('detects an error carried only as error_code', () => {
    expect(parseAuthRedirect('#error_code=otp_expired', '')?.kind).toBe('error')
  })

  it('does not require a token — an invite with a spent token is still an invite', () => {
    // The screen is the right place to say "this link is no longer valid and
    // here is a new one". Returning null instead would silently dump the user on
    // the public landing page with no explanation and no way forward.
    expect(parseAuthRedirect('#type=invite', '')).toEqual({ kind: 'invite' })
  })

  it('ignores an ordinary page load', () => {
    expect(parseAuthRedirect('', '')).toBeNull()
    expect(parseAuthRedirect('#', '?')).toBeNull()
  })

  it('ignores a plain anchor fragment', () => {
    expect(parseAuthRedirect('#capabilities', '')).toBeNull()
  })

  it('ignores auth types this flow does not handle', () => {
    // email_change and magiclink do not end in a password being set.
    expect(parseAuthRedirect('#type=email_change', '')).toBeNull()
    expect(parseAuthRedirect('#type=magiclink', '')).toBeNull()
  })
})

describe('stripAuthParams', () => {
  const ORIGIN = 'https://www.ddpbrokerage.com/'

  it('removes the whole auth fragment', () => {
    const url = `${ORIGIN}#access_token=abc&refresh_token=def&expires_in=3600&type=invite`
    expect(stripAuthParams(url)).toBe(ORIGIN)
  })

  it('removes auth error parameters', () => {
    const url = `${ORIGIN}#error=access_denied&error_code=otp_expired&error_description=gone`
    expect(stripAuthParams(url)).toBe(ORIGIN)
  })

  it('removes auth parameters from the query string', () => {
    expect(stripAuthParams(`${ORIGIN}?code=pkce-code&type=recovery`)).toBe(ORIGIN)
  })

  it('leaves unrelated query parameters alone', () => {
    // A blanket "reset the URL to its pathname" would eat application state
    // that happens to share the address bar.
    expect(stripAuthParams(`${ORIGIN}?lang=th&type=invite`)).toBe(`${ORIGIN}?lang=th`)
  })

  it('leaves a plain anchor fragment alone', () => {
    expect(stripAuthParams(`${ORIGIN}#capabilities`)).toBe(`${ORIGIN}#capabilities`)
  })

  it('is a no-op on a URL that carries no auth parameters', () => {
    expect(stripAuthParams(ORIGIN)).toBe(ORIGIN)
  })

  it('produces a URL that no longer parses as an auth redirect', () => {
    // The property that actually matters: after clearing, a reload must not
    // re-enter the set-password screen holding a token that is already spent.
    const cleaned = new URL(
      stripAuthParams(`${ORIGIN}#access_token=abc&type=invite`),
    )
    expect(parseAuthRedirect(cleaned.hash, cleaned.search)).toBeNull()
  })
})
