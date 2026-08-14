import { describe, it, expect } from 'vitest'
import { decideColdLoad } from './deepLinkIntent'
import { getInitialPageFromPath } from './urlRouting'
import { PUBLIC_PAGES } from './navigationGuard'
import type { Page } from '../types'

// Source-reading follows the house convention set by setPasswordWiring.test.ts
// and navigationGuard.test.ts: import.meta.glob with ?raw, resolved by vite at
// build time. NOT node:fs — the suite runs environment: 'node' and a
// readFileSync(process.cwd(), …) silently depends on where vitest was invoked
// from. A wrong glob yields '' rather than throwing, so both sources are
// asserted non-empty below before anything is matched against them.
function source(pattern: Record<string, string>): string {
  return Object.values(pattern)[0] ?? ''
}

const SRC = source(import.meta.glob('./urlRouting.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const APP = source(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('the source this file reasons about actually loaded', () => {
  it('urlRouting.ts and App.tsx are both non-empty', () => {
    // Without this, every regex below would match nothing and pass vacuously.
    expect(SRC.length).toBeGreaterThan(200)
    expect(APP.length).toBeGreaterThan(1000)
  })
})

/**
 * Deep links are the one route into the app that does NOT pass through goTo(),
 * and therefore not through resolveNavigationTarget either. Two entry points
 * bypass it: the useState initialiser on a cold load, and the popstate handler
 * on Back/Forward. Both call setPage directly.
 *
 * That is acceptable only while every mapped path leads to a PUBLIC page — one
 * the guard would admit for any visitor regardless of role or session. The
 * moment a farmer or admin page is added to the map, the bypass becomes a real
 * unguarded route into authenticated surface. These tests are the tripwire.
 */
describe('deep-linkable paths stay inside the public surface', () => {
  // Parse the literal map rather than exporting it: the point is to catch an
  // edit to the source of truth, not to a copy kept in step with it.
  const mapBlock = SRC.match(/const PATH_TO_PAGE: Record<string, Page> = \{([\s\S]*?)\}/)?.[1] ?? ''
  const mappedPaths = [...mapBlock.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map(m => ({
    path: m[1],
    page: m[2] as Page,
  }))

  it('finds at least one mapping (the parser has not silently gone blind)', () => {
    expect(mappedPaths.length).toBeGreaterThan(0)
  })

  /**
   * THE INVARIANT CHANGED SHAPE, not strength.
   *
   * It used to be "every mapped path is PUBLIC", which was a proxy for the
   * thing that actually matters — that a deep link cannot reach authenticated
   * surface without the guard's consent — and it made the console
   * un-addressable as a side effect.
   *
   * The real property is asserted directly now: for every mapped path, a cold
   * load either lands on a page the guard admits for anyone, or HOLDS the intent
   * for replay once identity is known. There is no third outcome, and a path
   * that set authenticated surface directly would fail here.
   *
   * Tested through decideColdLoad itself rather than by reading App.tsx, so it
   * fails on a change to the behaviour rather than to a comment.
   */
  it.each(mappedPaths)('$path cannot reach $page without the guard', ({ path, page }) => {
    const { page: landed, held } = decideColdLoad(path, { isDemo: false })

    if (PUBLIC_PAGES.includes(page)) {
      expect(landed).toBe(page)
      expect(held).toBeNull()
      return
    }

    // Authenticated surface: the visitor must land somewhere public, and the
    // intent must survive for the guard to rule on.
    expect(PUBLIC_PAGES).toContain(landed)
    expect(held).toBe(page)
  })

  /**
   * Demo mode has no identity to wait for and the guard admits everything in
   * it, so a held intent there would strand the visitor on 'landing' forever —
   * nothing would ever resolve to replay it.
   */
  it.each(mappedPaths)('$path is honoured immediately in demo mode', ({ path, page }) => {
    const { page: landed, held } = decideColdLoad(path, { isDemo: true })
    expect(landed).toBe(page)
    expect(held).toBeNull()
  })

  it('holds nothing for a path that is not mapped at all', () => {
    const { page, held } = decideColdLoad('/no/such/path', { isDemo: false })
    expect(page).toBe('landing')
    expect(held).toBeNull()
  })

  it('every mapped page resolves through the real function too', () => {
    for (const { path, page } of mappedPaths) {
      expect(getInitialPageFromPath(path)).toBe(page)
    }
  })

  it('an unmapped path returns null so the caller keeps its own default', () => {
    expect(getInitialPageFromPath('/nope')).toBeNull()
    expect(getInitialPageFromPath('/')).toBeNull()
  })

  /**
   * A trailing slash used to fall through to null, and the landing page loaded
   * instead. That was invisible while every path was served the same empty
   * shell — the visitor saw the landing page either way.
   *
   * The prerender made it visible. `/about/` is served `about/index.html`: real
   * About markup, the About title, the About canonical. The app would then have
   * rendered the landing page over it and rewritten the address bar to "/", so
   * the visitor would watch the correct page turn into the wrong one and a
   * rendering crawler would record the two disagreeing.
   */
  it('accepts a trailing slash, which the prerendered documents make reachable', () => {
    for (const { path, page } of mappedPaths) {
      expect(getInitialPageFromPath(`${path}/`), `${path}/ must resolve like ${path}`).toBe(page)
    }
  })

  it('still returns null for an unmapped path with a trailing slash', () => {
    expect(getInitialPageFromPath('/nope/')).toBeNull()
  })
})

describe('the set-password redirect still outranks any deep link', () => {
  it('getAuthRedirect is checked before the pathname is consulted', () => {
    // An invited user's session is transient. If a deep link could win the race
    // — /farmer beating the invite — the account is left with no password and
    // no route to one. Order is the whole guarantee, so assert on order.
    const init = APP.match(/useState<Page>\(\(\) => \{([\s\S]*?)\n {2}\}\)/)?.[1] ?? ''
    expect(init).not.toBe('')

    const redirectAt = init.indexOf('getAuthRedirect()')
    // The initialiser consults the pathname through decideColdLoad now, which
    // is what routes an authenticated deep link through the guard. The name
    // changed; the ordering guarantee did not, and it is the guarantee that
    // keeps an invited supplier on the set-password screen.
    const pathAt = init.indexOf('decideColdLoad')

    expect(redirectAt).toBeGreaterThanOrEqual(0)
    expect(pathAt, 'the initialiser must consult the pathname via decideColdLoad').toBeGreaterThanOrEqual(0)
    expect(
      redirectAt < pathAt,
      "getAuthRedirect() must be checked BEFORE the pathname in the page initialiser",
    ).toBe(true)
  })
})

describe('the farmer mobile nav never paints on a public page', () => {
  it('its render guard excludes PUBLIC_PAGES', () => {
    // FARMER_PAGES spreads PUBLIC_PAGES, so isFarmerPage alone is true on
    // landing and login. showFarmerNav is true for every signed-in farmer and
    // for all of demo mode. Without the exclusion, tapping the brand logo puts
    // a dark farmer tab bar across the public landing page on a phone.
    expect(APP).toMatch(
      /\{showFarmerNav && isFarmerPage && !PUBLIC_PAGES\.includes\(page\) && \(/,
    )
  })
})
