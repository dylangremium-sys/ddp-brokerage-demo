import { describe, expect, it } from 'vitest'

/**
 * Supplier self-registration reachability.
 *
 * This repo's vitest environment is 'node' and the include glob covers only
 * `src/**‍/*.test.ts` — there is no jsdom and .tsx is never rendered under
 * test. Route wiring is therefore asserted against source text via
 * `import.meta.glob(..., '?raw')`, the existing convention here (see
 * operationsDeskRouting.test.ts).
 *
 * The defect this file pins: the landing page's supplier-signup callbacks call
 * `goTo('farmer-register')`, but PUBLIC_PAGES was `['landing', 'login']`, so
 * goTo()'s unauthenticated guard redirected every signup click to 'login'
 * whenever Supabase mode was active. Supplier signup was reachable in demo
 * mode only.
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

const APP_SRC = raw(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

/** Parse a `const NAME: Page[] = [...]` declaration into its page ids. */
function pageList(name: string): string[] {
  const decl = APP_SRC.match(new RegExp(`const ${name}: Page\\[\\] = \\[[\\s\\S]*?\\]`))?.[0] ?? ''
  return Array.from(decl.matchAll(/'([a-z0-9-]+)'/g), m => m[1])
}

/** Every page id an `onSupplierSignup` callback navigates to. */
function supplierSignupTargets(): string[] {
  return Array.from(
    APP_SRC.matchAll(/onSupplierSignup=\{\(\) => goTo\('([a-z0-9-]+)'\)\}/g),
    m => m[1],
  )
}

/**
 * goTo()'s unauthenticated redirect, mirrored from App.tsx:
 *   if (!isDemo && !isSignedIn && !PUBLIC_PAGES.includes(p)) → 'login'
 */
function resolveUnauthenticatedNavigation(target: string, publicPages: string[]): string {
  return publicPages.includes(target) ? target : 'login'
}

describe('supplier signup routing — source fixture is readable', () => {
  it('loads App.tsx', () => {
    expect(APP_SRC.length).toBeGreaterThan(1000)
  })
})

describe('supplier signup routing — the guard mirrored here matches App.tsx', () => {
  it('gates unauthenticated navigation on PUBLIC_PAGES membership', () => {
    expect(APP_SRC).toContain('if (!isDemo && !isSignedIn && !PUBLIC_PAGES.includes(p)) {')
  })
})

describe('supplier signup is reachable outside demo mode', () => {
  it('has at least one supplier-signup entry point', () => {
    expect(supplierSignupTargets().length).toBeGreaterThan(0)
  })

  it('registers farmer-register as a public page', () => {
    expect(pageList('PUBLIC_PAGES')).toContain('farmer-register')
  })

  it.each(supplierSignupTargets())(
    'an unauthenticated visitor clicking supplier signup reaches %s, not login',
    target => {
      expect(resolveUnauthenticatedNavigation(target, pageList('PUBLIC_PAGES'))).toBe(target)
    },
  )

  it('routes supplier signup to the registration page, not straight into the farmer app', () => {
    for (const target of supplierSignupTargets()) {
      expect(target).toBe('farmer-register')
    }
  })
})

describe('widening PUBLIC_PAGES did not open authenticated surfaces', () => {
  const publicPages = pageList('PUBLIC_PAGES')

  it.each([
    'farmer-dashboard',
    'farmer-onboarding',
    'farmer-my-stock',
    'farmer-requests',
    'ddp-overview',
    'ddp-buyer',
    'ddp-risk-register',
  ])('keeps %s behind the auth guard', page => {
    expect(publicPages).not.toContain(page)
  })

  it('exposes exactly the three pre-account routes', () => {
    expect([...publicPages].sort()).toEqual(['farmer-register', 'landing', 'login'])
  })
})
