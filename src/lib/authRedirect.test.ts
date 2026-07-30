// Auth redirect parsing — the gate that decides whether an invited supplier is
// shown the set-password screen at all.
//
// Getting this wrong is not a cosmetic failure. A missed 'invite' drops the user
// on a dashboard with a transient session and no password, and the account
// becomes permanently unreachable when that session expires. A false positive
// interrupts a signed-in operator with a password form they did not ask for.

import { describe, it, expect } from 'vitest'
import { parseAuthRedirect, stripAuthParams, decodeJwtSubject } from './authRedirect'

/** A structurally real JWT carrying `sub`. Never verified — only decoded. */
function jwt(payload: Record<string, unknown>): string {
  // replaceAll with plain strings, and a bracketed '=' class: a regex literal
  // beginning `/=` reads as the division-assignment operator to both humans and
  // scanners.
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replaceAll('+', '-').replaceAll('/', '_').replace(/[=]+$/, '')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.c2ln`
}

const TOKEN = jwt({ sub: 'a1b2c3d4-0000-4000-8000-000000000001', role: 'authenticated' })
const SUBJECT = 'a1b2c3d4-0000-4000-8000-000000000001'

describe('parseAuthRedirect', () => {
  it('recognises the invite fragment Supabase actually sends, and binds its subject', () => {
    // Shape taken from a real GoTrue implicit-flow redirect.
    const hash =
      `#access_token=${TOKEN}&expires_at=1785000000&expires_in=3600` +
      '&refresh_token=x7Kq2p&token_type=bearer&type=invite'
    expect(parseAuthRedirect(hash, '')).toEqual({ kind: 'invite', subject: SUBJECT })
  })

  it('recognises the recovery fragment', () => {
    const hash = `#access_token=${TOKEN}&refresh_token=x7Kq2p&type=recovery`
    expect(parseAuthRedirect(hash, '')).toEqual({ kind: 'recovery', subject: SUBJECT })
  })

  it('reads type from the query string too', () => {
    // Some project configurations put it there instead of in the fragment.
    expect(parseAuthRedirect('', '?type=recovery')).toEqual({ kind: 'recovery', subject: null })
  })

  it('classifies an expired link as an error, keeping ONLY the code', () => {
    const hash =
      '#error=access_denied&error_code=otp_expired' +
      '&error_description=Email+link+is+invalid+or+has+expired'
    expect(parseAuthRedirect(hash, '')).toEqual({ kind: 'error', code: 'otp_expired' })
  })

  it('NEVER carries the URL-supplied error description', () => {
    // Echoing it onto the branded page would let anyone put arbitrary phishing
    // instructions on DDP's own origin without holding a token. The value must
    // not survive parsing at all — it cannot be rendered if it is never carried.
    const hash =
      '#error=access_denied&error_code=otp_expired' +
      '&error_description=Call+0800-SCAM+to+reactivate+your+DDP+account'
    const result = parseAuthRedirect(hash, '')
    expect(JSON.stringify(result)).not.toMatch(/SCAM/i)
    expect(result).not.toHaveProperty('description')
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
    //
    // But the subject is null, and the screen MUST treat that as a dead link
    // rather than falling back to whatever session is in storage — otherwise an
    // admin signed in on this browser would have their own password changed.
    expect(parseAuthRedirect('#type=invite', '')).toEqual({ kind: 'invite', subject: null })
  })

  it('yields a null subject for a token it cannot read', () => {
    for (const token of ['garbage', 'a.b', 'a.b.c.d', 'a.!!!.c', `a.${btoa('[]')}.c`]) {
      const result = parseAuthRedirect(`#access_token=${token}&type=invite`, '')
      expect(result, token).toEqual({ kind: 'invite', subject: null })
    }
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

describe('decodeJwtSubject — fails closed', () => {
  it('reads the sub claim of a well-formed token', () => {
    expect(decodeJwtSubject(TOKEN)).toBe(SUBJECT)
  })

  it('handles base64url padding and the -/_ alphabet', () => {
    // A real Supabase `sub` is a UUID, and the payload length routinely lands on
    // a boundary that needs padding atob would otherwise reject.
    for (const sub of ['a', 'ab', 'abc', 'abcd', '11111111-2222-4333-8444-555555555555']) {
      expect(decodeJwtSubject(jwt({ sub, extra: '?~>' }))).toBe(sub)
    }
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['not a JWT', 'garbage'],
    ['too few segments', 'a.b'],
    ['too many segments', 'a.b.c.d'],
  ])('returns null when the token is %s', (_label, token) => {
    expect(decodeJwtSubject(token as string | null | undefined)).toBeNull()
  })

  it('returns null when the payload has no usable sub', () => {
    expect(decodeJwtSubject(jwt({ role: 'authenticated' }))).toBeNull()
    expect(decodeJwtSubject(jwt({ sub: '' }))).toBeNull()
    expect(decodeJwtSubject(jwt({ sub: 12345 }))).toBeNull()
    expect(decodeJwtSubject(jwt({ sub: { id: 'x' } }))).toBeNull()
  })

  it('never throws, whatever it is handed', () => {
    // Every failure must become null. A throw here would blank the screen
    // instead of showing the dead-link state.
    for (const token of ['', '.', '..', 'a.b.c', ' . . ']) {
      expect(() => decodeJwtSubject(token)).not.toThrow()
    }
  })
})
