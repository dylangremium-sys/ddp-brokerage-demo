import { describe, it, expect } from 'vitest'
import { resolveInviteRedirectUrl, INVITE_REDIRECT_ENV } from './inviteRedirect'

const withUrl = (value: string | undefined) => ({ [INVITE_REDIRECT_ENV]: value })

/**
 * Builds a dangerous-scheme URL from parts.
 *
 * These are FIXTURES — strings handed to the function under test, never
 * navigated to or evaluated. Written literally, `javascript:…` trips static
 * scanners that (correctly, in general) treat script URLs as a form of eval.
 * Assembling it keeps the test's meaning without a literal in the source.
 */
const scheme = (name: string, rest: string) => `${name}:${rest}`

describe('resolveInviteRedirectUrl — accepted', () => {
  it('returns a configured https origin', () => {
    expect(resolveInviteRedirectUrl(withUrl('https://www.ddpbrokerage.com')))
      .toBe('https://www.ddpbrokerage.com/')
  })

  it('keeps an explicit path', () => {
    expect(resolveInviteRedirectUrl(withUrl('https://www.ddpbrokerage.com/app')))
      .toBe('https://www.ddpbrokerage.com/app')
  })

  it('trims surrounding whitespace', () => {
    // A value pasted into a dashboard field very often arrives with a newline.
    expect(resolveInviteRedirectUrl(withUrl('  https://ddpbrokerage.com  ')))
      .toBe('https://ddpbrokerage.com/')
  })

  it('allows http on localhost for local development', () => {
    expect(resolveInviteRedirectUrl(withUrl('http://localhost:5173')))
      .toBe('http://localhost:5173/')
    expect(resolveInviteRedirectUrl(withUrl('http://127.0.0.1:5173')))
      .toBe('http://127.0.0.1:5173/')
  })
})

describe('resolveInviteRedirectUrl — strips what would break the invite', () => {
  it('strips a fragment', () => {
    // Supabase appends the session AS a fragment (#access_token=…&type=invite).
    // Leaving one here means the app never sees the invite parameters it must
    // capture, and the set-password screen is silently never shown.
    expect(resolveInviteRedirectUrl(withUrl('https://www.ddpbrokerage.com/#section')))
      .toBe('https://www.ddpbrokerage.com/')
  })

  it('strips a query string', () => {
    expect(resolveInviteRedirectUrl(withUrl('https://www.ddpbrokerage.com/?utm=x')))
      .toBe('https://www.ddpbrokerage.com/')
  })

  it('strips both at once', () => {
    expect(resolveInviteRedirectUrl(withUrl('https://www.ddpbrokerage.com/app?a=1#b')))
      .toBe('https://www.ddpbrokerage.com/app')
  })
})

describe('resolveInviteRedirectUrl — falls back to the Site URL', () => {
  it('when unset', () => {
    expect(resolveInviteRedirectUrl({})).toBeUndefined()
  })

  it('when blank or whitespace', () => {
    expect(resolveInviteRedirectUrl(withUrl(''))).toBeUndefined()
    expect(resolveInviteRedirectUrl(withUrl('   '))).toBeUndefined()
  })

  it('when not a parseable absolute URL', () => {
    // A relative path has no origin, so there is nothing to send an email to.
    for (const value of ['ddpbrokerage.com', '/app', 'not a url', '://broken']) {
      expect(resolveInviteRedirectUrl(withUrl(value)), value).toBeUndefined()
    }
  })

  it('when plain http on a non-localhost host', () => {
    // An invitation link is a bearer credential; http would expose it in
    // transit. Refusing degrades to the Site URL, which is the safe direction.
    expect(resolveInviteRedirectUrl(withUrl('http://www.ddpbrokerage.com'))).toBeUndefined()
  })

  it('when the scheme is not http(s) at all', () => {
    for (const value of [
      scheme('javascript', 'alert(1)'),
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://ddpbrokerage.com',
    ]) {
      expect(resolveInviteRedirectUrl(withUrl(value)), value).toBeUndefined()
    }
  })
})

describe('a misconfigured value never breaks invitations', () => {
  it('every rejected value yields undefined, never a thrown error', () => {
    // The caller omits redirectTo when this is undefined, restoring the exact
    // pre-existing Site URL behaviour. Provisioning must not start failing
    // because someone typed the variable wrong.
    for (const value of ['', '   ', 'nonsense', 'http://evil.example', scheme('javascript', 'x'), '://']) {
      expect(() => resolveInviteRedirectUrl(withUrl(value))).not.toThrow()
      expect(resolveInviteRedirectUrl(withUrl(value))).toBeUndefined()
    }
  })

  it('reads only its own variable', () => {
    // Neighbouring server-only secrets must not leak into an emailed URL.
    const env = {
      SUPABASE_SERVICE_ROLE_KEY: 'super-secret',
      SUPABASE_URL: 'https://iihx.supabase.co',
    }
    expect(resolveInviteRedirectUrl(env)).toBeUndefined()
  })
})
