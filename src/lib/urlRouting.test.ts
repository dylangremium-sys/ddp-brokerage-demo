import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getInitialPageFromPath } from './urlRouting'
import { PUBLIC_PAGES } from './navigationGuard'
import type { Page } from '../types'

const SRC = readFileSync(join(process.cwd(), 'src/lib/urlRouting.ts'), 'utf8')
const APP = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')

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

  it.each(mappedPaths)('$path maps to $page, which is a PUBLIC page', ({ page }) => {
    expect(PUBLIC_PAGES).toContain(page)
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
})

describe('the set-password redirect still outranks any deep link', () => {
  it('getAuthRedirect is checked before the pathname is consulted', () => {
    // An invited user's session is transient. If a deep link could win the race
    // — /farmer beating the invite — the account is left with no password and
    // no route to one. Order is the whole guarantee, so assert on order.
    const init = APP.match(/useState<Page>\(\(\) => \{([\s\S]*?)\n {2}\}\)/)?.[1] ?? ''
    expect(init).not.toBe('')

    const redirectAt = init.indexOf('getAuthRedirect()')
    const pathAt = init.indexOf('getInitialPageFromPath')

    expect(redirectAt).toBeGreaterThanOrEqual(0)
    expect(pathAt).toBeGreaterThanOrEqual(0)
    expect(
      redirectAt < pathAt,
      "getAuthRedirect() must be checked BEFORE getInitialPageFromPath() in the page initialiser",
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
