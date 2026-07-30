// ─── Set-password flow: wiring contract ─────────────────────────────────────
//
// WHY THIS EXISTS
//   The capability existed and was unreachable is this repo's most expensive
//   recurring defect. src/services/adminProvisioning.ts was imported by ZERO
//   components, so the admin "Invited" button wrote a status label and created
//   no account. PUBLIC_PAGES omitted 'farmer-register', so every "Supplier
//   signup" click was a silent no-op. Neither is a type error, neither is a lint
//   error, neither fails a render — and the suite was green through both.
//
//   The set-password screen has exactly the same failure mode, with a worse
//   consequence: if it is built but never rendered, an invited supplier is still
//   locked out forever and every unit test below still passes. So this test
//   asserts the WIRING — what the code connects — by reading the source, the
//   same technique navigationGuard.test.ts and the connector contract test use.
//
//   Vitest runs environment: 'node' here with no jsdom or testing-library, so
//   source text is the only view of a .tsx file available. import.meta.glob with
//   ?raw is vite/client-typed; no node:fs.

import { describe, it, expect } from 'vitest'
import { PUBLIC_PAGES, PUBLIC_AUTH_PAGES } from './navigationGuard'
import { T } from '../translations'

function source(pattern: Record<string, string>): string {
  return Object.values(pattern)[0] ?? ''
}

const APP = source(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const SUPABASE = source(import.meta.glob('./supabase.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const AUTH_SERVICE = source(import.meta.glob('../services/auth.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const LOGIN_PAGE = source(import.meta.glob('../pages/public/LoginPage.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const SET_PASSWORD_PAGE = source(import.meta.glob('../pages/public/SetPasswordPage.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const FORGOT_PAGE = source(import.meta.glob('../pages/public/ForgotPasswordPage.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const PROVISION_ENDPOINT = source(import.meta.glob('../../api/admin/provision-farmer.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

it('reads every source file it asserts on', () => {
  // If a path drifts, every assertion below would pass vacuously against ''.
  for (const [name, text] of Object.entries({
    APP, SUPABASE, AUTH_SERVICE, LOGIN_PAGE, SET_PASSWORD_PAGE, FORGOT_PAGE, PROVISION_ENDPOINT,
  })) {
    expect(text.length, `${name} source is empty — the glob path has drifted`).toBeGreaterThan(200)
  }
})

describe('the capability exists at all', () => {
  it('the auth service calls Supabase’s set-password API', () => {
    // §5 of the 2026-07-29 handover: `auth.updateUser` occurred 0 times across
    // src/, which is precisely why an invited supplier could never sign in twice.
    expect(AUTH_SERVICE).toMatch(/auth\.updateUser\(\s*\{\s*password\s*\}/)
  })

  it('the auth service can send a password-reset email', () => {
    expect(AUTH_SERVICE).toContain('resetPasswordForEmail')
  })
})

describe('the screens are actually rendered', () => {
  // The element name is matched with a trailing boundary. `toContain('<SetPasswordPage')`
  // is NOT sufficient: it also matches '<SetPasswordPageSomethingElse', so a
  // renamed-away component passed the assertion while rendering nothing. Found
  // by falsifying this very test.
  it('App imports and renders SetPasswordPage, guarded by its own page route', () => {
    expect(APP).toMatch(/import SetPasswordPage from '\.\/pages\/public\/SetPasswordPage'/)
    expect(APP).toMatch(/<SetPasswordPage[\s/>]/)
    expect(APP).toMatch(/page === 'set-password'/)
  })

  it('App imports and renders ForgotPasswordPage, guarded by its own page route', () => {
    expect(APP).toMatch(/import ForgotPasswordPage from '\.\/pages\/public\/ForgotPasswordPage'/)
    expect(APP).toMatch(/<ForgotPasswordPage[\s/>]/)
    expect(APP).toMatch(/page === 'forgot-password'/)
  })

  it('SetPasswordPage calls the set-password service', () => {
    expect(SET_PASSWORD_PAGE).toMatch(/import \{[^}]*setPassword[^}]*\} from '\.\.\/\.\.\/services\/auth'/)
    expect(SET_PASSWORD_PAGE).toMatch(/await setPassword\(/)
  })

  it('ForgotPasswordPage calls the reset service', () => {
    expect(FORGOT_PAGE).toMatch(/await requestPasswordReset\(/)
  })
})

describe('the invited user can reach the screen', () => {
  it('the initial page is the set-password screen when a redirect was captured', () => {
    // Landing anywhere else — even briefly — is the defect: the session is
    // transient, and once it lapses the account has no password and no route to
    // one.
    expect(APP).toMatch(/useState<Page>\(\(\)\s*=>\s*\(getAuthRedirect\(\)\s*\?\s*'set-password'/)
  })

  it('the auth subscription passes the pending flag into the routing decision', () => {
    // Without this the resolved role wins and the supplier is sent to their
    // dashboard, past the only screen that can set their password.
    //
    // Read from the module getter, NOT from a captured React value: the
    // subscription is registered once with [] deps, so a closed-over copy would
    // still say "pending" after the flow ended, and a later auth event would be
    // suppressed when it should route.
    expect(APP).toMatch(/passwordSetupPending:\s*getAuthRedirect\(\) !== null/)
  })

  it('both new pages are publicly reachable', () => {
    // 'set-password' does need a session — but the invite link grants it, not a
    // prior login, so the navigation guard must not demand one.
    expect(PUBLIC_PAGES).toContain('set-password')
    expect(PUBLIC_PAGES).toContain('forgot-password')
    expect(PUBLIC_AUTH_PAGES).toContain('set-password')
    expect(PUBLIC_AUTH_PAGES).toContain('forgot-password')
  })
})

describe('the form is bound to the account the LINK names', () => {
  // Raised in review of #91. "A session exists" is not "this is the session the
  // link created". With an admin already signed in on the browser, a spent
  // invite link (#type=invite, no usable token) satisfied a mere existence
  // check — and submitting called updateUser against the ADMIN'S account,
  // changing the wrong password while the invited account stayed unreachable.
  it('compares the session user against the link subject, not just presence', () => {
    expect(SET_PASSWORD_PAGE).toMatch(/getSessionUserId/)
    expect(SET_PASSWORD_PAGE).toMatch(/userId === subject/)
    // The old presence-only helper must be gone, not merely unused.
    expect(SET_PASSWORD_PAGE).not.toMatch(/hasActiveSession/)
    expect(AUTH_SERVICE).not.toMatch(/hasActiveSession/)
  })

  it('treats a link with no subject as dead rather than falling back to storage', () => {
    // Resolved in the INITIAL state, not from inside the effect, so the form is
    // never rendered for an instant and then withdrawn.
    expect(SET_PASSWORD_PAGE).toMatch(
      /useState<Phase>\(linkSubject \? 'checking' : 'unavailable'\)/,
    )
    // And the session probe itself refuses to run without one, so no code path
    // can reach getSessionUserId for a link that names nobody.
    expect(SET_PASSWORD_PAGE).toMatch(/if \(!subject\) return/)
  })

  it('the auth service returns an identity, not a boolean', () => {
    expect(AUTH_SERVICE).toMatch(/export async function getSessionUserId\(\): Promise<string \| null>/)
  })
})

describe('nothing from the URL is rendered on the branded page', () => {
  // Raised in review of #91. Echoing `error_description` let anyone put
  // arbitrary phishing copy on DDP's own origin without holding a token.
  it('the screen never renders a URL-supplied description', () => {
    // Comments are stripped first: the block explaining WHY this is forbidden
    // names `error_description`, and matching that would make the test pass or
    // fail on prose rather than on code.
    const code = SET_PASSWORD_PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/redirect\.description/)
    expect(code).not.toMatch(/error_description/)
  })

  it('the parser does not even carry the description', () => {
    // Defence in depth: a value that is never parsed cannot later be rendered
    // by someone adding a well-meaning "show the reason" line.
    const AUTH_REDIRECT = source(import.meta.glob('./authRedirect.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    expect(AUTH_REDIRECT).not.toMatch(/description:/)
  })

  it('the displayed reason comes from a trusted map keyed by error code', () => {
    expect(SET_PASSWORD_PAGE).toMatch(/TRUSTED_REASON/)
    expect(SET_PASSWORD_PAGE).toMatch(/otp_expired: t\.setPwReasonExpired/)
  })
})

describe('the invitation email points at this app, not at a dashboard setting', () => {
  // Without this the invite link goes wherever the Supabase project's Site URL
  // points — invisible from this repo, unversioned, shared by every auth email.
  // If it is not the app that renders SetPasswordPage, the supplier gets a
  // session on a page that cannot set a password and the account dies with it.
  it('the endpoint resolves a redirect and passes it to inviteUserByEmail', () => {
    expect(PROVISION_ENDPOINT).toMatch(/import \{ resolveInviteRedirectUrl \} from/)
    expect(PROVISION_ENDPOINT).toMatch(/const redirectTo = resolveInviteRedirectUrl\(process\.env\)/)
    // The spread must sit INSIDE the inviteUserByEmail options object — a
    // resolved value assigned and then never passed is the defect this guards.
    const call = PROVISION_ENDPOINT.slice(
      PROVISION_ENDPOINT.indexOf('inviteUserByEmail('),
      PROVISION_ENDPOINT.indexOf('if (error)'),
    )
    expect(call).toMatch(/\.\.\.\(redirectTo \? \{ redirectTo \} : \{\}\)/)
  })

  it('resolves the redirect before the call that uses it', () => {
    const resolved = PROVISION_ENDPOINT.indexOf('const redirectTo =')
    const used = PROVISION_ENDPOINT.indexOf('inviteUserByEmail(')
    expect(resolved).toBeGreaterThan(-1)
    expect(resolved).toBeLessThan(used)
  })
})

describe('the fragment capture cannot lose its race with supabase-js', () => {
  it('lib/supabase.ts imports authRedirect before constructing the client', () => {
    // supabase-js consumes and STRIPS the invite fragment during its async
    // initialise. The capture must already have run. ES module evaluation order
    // guarantees that only while this import is present.
    expect(SUPABASE).toMatch(/import '\.\/authRedirect'/)
    // Match the call site, not the word: `createClient(` also appears in the
    // comment that explains this very rule, and matching that would make the
    // ordering assertion pass no matter where the import actually sits.
    const callSite = SUPABASE.search(/\bcreateClient\(url/)
    expect(callSite, 'createClient(url, …) call site not found in lib/supabase.ts').toBeGreaterThan(-1)
    expect(SUPABASE.indexOf("import './authRedirect'")).toBeLessThan(callSite)
  })
})

describe('a locked-out user has a way back in', () => {
  it('the login page offers a forgot-password affordance', () => {
    expect(LOGIN_PAGE).toContain('onForgotPassword')
    expect(LOGIN_PAGE).toContain('t.loginForgotLink')
    expect(APP).toMatch(/onForgotPassword=\{\(\)\s*=>\s*goTo\('forgot-password'\)\}/)
  })

  it('a dead invite link offers a route onward rather than a dead end', () => {
    expect(SET_PASSWORD_PAGE).toContain('onRequestNewLink')
    expect(APP).toMatch(/onRequestNewLink=\{goToForgotPassword\}/)
  })

  it('neither screen promises an email that cannot be sent', () => {
    // resetPasswordForEmail does NOT reissue an unaccepted invitation — that
    // identity is unconfirmed, so no recovery mail goes out. Both screens must
    // say so, or they send the expired-invite user round a loop that can never
    // complete while telling them help is on the way.
    expect(SET_PASSWORD_PAGE).toContain('t.setPwExpiredInviteHelp')
    expect(FORGOT_PAGE).toContain('t.forgotInviteNote')
    for (const copy of [T.en.setPwExpiredInviteHelp, T.en.forgotInviteNote]) {
      expect(copy).toMatch(/contact DDP Support/i)
    }
    // The old unconditional promise must be gone from the dead-link body.
    expect(T.en.setPwLinkInvalidBody).not.toMatch(/will be emailed to you/i)
  })

  it('the spent token is cleared from the URL once the password is set', () => {
    // Otherwise a reload re-enters the flow holding a token that is already used.
    expect(APP).toMatch(/function handleSetPasswordComplete[\s\S]{0,200}clearAuthRedirect\(\)/)
  })
})

describe('every string the new screens render exists in both languages', () => {
  // PR #90 shipped a page whose text was invisible and 2309 tests stayed green.
  // A missing translation key is the same class of defect: it renders as
  // `undefined` to the user and nothing fails.
  const KEYS = [
    'loginForgotLink',
    'setPwHeadingInvite', 'setPwHeadingRecovery', 'setPwDescInvite', 'setPwDescRecovery',
    'setPwNewLabel', 'setPwConfirmLabel', 'setPwHint', 'setPwShow', 'setPwHide',
    'setPwSubmit', 'setPwSaving', 'setPwChecking',
    'setPwLinkInvalidHeading', 'setPwLinkInvalidBody', 'setPwRequestNew',
    'pwErrEmpty', 'pwErrTooShort', 'pwErrTooLong', 'pwErrNoLetter', 'pwErrNoNumber',
    'pwErrMismatch', 'pwErrSaveFailed',
    'forgotHeading', 'forgotDesc', 'forgotSubmit', 'forgotSending', 'forgotSent',
    'forgotFailed', 'forgotBack',
  ] as const

  // T is typed from T.en, so T.th is NOT checked against it by the compiler —
  // a key present in English and missing in Thai is not a type error.
  const th = T.th as unknown as Record<string, unknown>

  it.each(KEYS)('%s is present and non-empty in en and th', (key) => {
    expect(T.en[key], `T.en.${key}`).toBeTruthy()
    expect(th[key], `T.th.${key}`).toBeTruthy()
  })

  it('every t.<key> the new screens reference is defined', () => {
    // The durable half: reads the keys the components ACTUALLY use, so a new
    // string added later without a translation still fails here.
    const referenced = new Set<string>()
    for (const text of [SET_PASSWORD_PAGE, FORGOT_PAGE]) {
      for (const match of text.matchAll(/\bt\.([A-Za-z0-9_]+)/g)) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThanOrEqual(15)
    for (const key of referenced) {
      expect(T.en, `T.en is missing "${key}", which the set-password screens render`).toHaveProperty(key)
      expect(T.th, `T.th is missing "${key}", which the set-password screens render`).toHaveProperty(key)
    }
  })
})
