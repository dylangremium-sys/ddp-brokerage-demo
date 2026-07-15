import { describe, expect, it } from 'vitest'

// Source-guard tests. The project's test harness runs in a `node` environment
// with no DOM/testing-library, so we assert against the raw source of the auth
// flow — imported via Vite's `?raw` query, which is typed by vite/client and
// avoids node:fs (not typed by the app tsconfig). This follows the existing
// convention in src/lib/complianceSourceConnectors.test.ts.
//
// The property these tests lock in: there is NO public farmer self-registration
// entry point, while login and role routing remain intact. Farmers are
// provisioned by DDP only.

function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const LOGIN_SOURCE = raw(
  import.meta.glob('./LoginPage.tsx', { query: '?raw', import: 'default', eager: true }),
)
const APP_SOURCE = raw(
  import.meta.glob('../../App.tsx', { query: '?raw', import: 'default', eager: true }),
)
const TYPES_SOURCE = raw(
  import.meta.glob('../../types.ts', { query: '?raw', import: 'default', eager: true }),
)

describe('LoginPage — no public signup entry', () => {
  it('loads the login source', () => {
    expect(LOGIN_SOURCE.length).toBeGreaterThan(0)
  })

  it('contains no public signup link or callback', () => {
    expect(LOGIN_SOURCE).not.toMatch(/signup/i)
    expect(LOGIN_SOURCE).not.toContain('onGoSignup')
    expect(LOGIN_SOURCE).not.toContain('auth-switch-text')
    expect(LOGIN_SOURCE).not.toContain('loginSwitchLink')
    expect(LOGIN_SOURCE).not.toContain('loginSwitchPrompt')
    expect(LOGIN_SOURCE).not.toContain('Create a farmer account')
  })

  it('still renders the sign-in form (credentials + submit → authenticate)', () => {
    expect(LOGIN_SOURCE).toContain('import { signIn }')
    expect(LOGIN_SOURCE).toContain('await signIn(email, password)')
    expect(LOGIN_SOURCE).toContain('handleSubmit')
    expect(LOGIN_SOURCE).toContain('type="email"')
    expect(LOGIN_SOURCE).toContain('type="password"')
    expect(LOGIN_SOURCE).toContain('type="submit"')
    expect(LOGIN_SOURCE).toContain('onSuccess()')
  })
})

describe('App routing — public signup route fully removed', () => {
  it('has no signup page, route, import or navigation', () => {
    expect(APP_SOURCE).not.toContain('SignupPage')
    expect(APP_SOURCE).not.toContain("page === 'signup'")
    expect(APP_SOURCE).not.toContain("goTo('signup')")
    expect(APP_SOURCE).not.toContain('onGoSignup')
    // PUBLIC_PAGES must not re-expose signup as a public route.
    const publicPages = APP_SOURCE.match(/const PUBLIC_PAGES:[^\n]*\n/)?.[0] ?? ''
    expect(publicPages.length).toBeGreaterThan(0)
    expect(publicPages).not.toContain('signup')
  })

  it("removes 'signup' from the Page type union", () => {
    expect(TYPES_SOURCE).not.toContain("'signup'")
  })

  it('deletes the orphaned public SignupPage component', () => {
    const modules = import.meta.glob('./SignupPage.tsx')
    expect(Object.keys(modules)).toHaveLength(0)
  })
})

describe('Role routing preserved (unchanged by this change)', () => {
  it('ddp_admin routing target and guard remain', () => {
    expect(APP_SOURCE).toContain("role === 'ddp_admin'")
    expect(APP_SOURCE).toContain("setPage('ddp-overview')")
  })

  it('farmer routing target and role check remain', () => {
    expect(APP_SOURCE).toContain("role === 'farmer'")
    expect(APP_SOURCE).toContain("page === 'farmer-dashboard'")
  })

  it('login still mounts and authenticates', () => {
    expect(APP_SOURCE).toContain('<LoginPage')
    expect(APP_SOURCE).toContain("page === 'login'")
  })
})
