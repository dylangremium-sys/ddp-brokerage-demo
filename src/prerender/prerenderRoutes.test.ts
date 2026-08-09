import { describe, expect, it } from 'vitest'

import { renderPublicRoutes } from './entry'
import { indexablePages, metadataForPage } from '../lib/publicPageMetadata'

/**
 * This file renders the real page components with no browser present.
 *
 * That is the point of it. The prerender rests on a claim about this
 * application — that the five public pages are pure presentation and can be
 * rendered outside a DOM — and a claim of that kind is worth executing rather
 * than believing. If someone later adds a `useEffect`, a Supabase call or a
 * module-scope `window` reference to one of these pages, the build would start
 * failing at `vite build --ssr` with a stack trace pointing at the bundler;
 * here it fails with a test name that says what actually broke.
 */
describe('the public pages render without a browser', () => {
  const routes = renderPublicRoutes()

  /**
   * Every indexable page, plus the two that are prerendered without being
   * indexed: /farmer (head-only, a form with nothing to rank) and
   * /th/suppliers (public and linkable, but its drafted Thai has not been
   * reviewed yet). Both are shared directly with people, so both need served
   * bytes for link previews.
   */
  it('renders every route the build will write a file for', () => {
    expect(routes.length).toBe(indexablePages().length + 2)
  })

  it.each(indexablePages())('%s produces real markup with a single heading', (page) => {
    const route = routes.find((r) => r.page === page)

    expect(route, `no prerender route for ${page}`).toBeDefined()
    expect(route!.bodyHtml.length).toBeGreaterThan(500)
    expect(route!.bodyHtml.match(/<h1[\s>]/g) ?? []).toHaveLength(1)
  })

  /**
   * The measured defect was five URLs serving one document. Distinct markup is
   * the half of the fix that this file can prove; distinct heads are asserted
   * in lib/prerenderDocument.test.ts.
   */
  it('renders a different page for each route', () => {
    const bodies = indexablePages().map((page) => routes.find((r) => r.page === page)!.bodyHtml)

    expect(new Set(bodies).size).toBe(bodies.length)
  })

  it('renders the corporate pages as documents a crawler can read as prose', () => {
    const about = routes.find((r) => r.page === 'about')!.bodyHtml

    expect(about).toContain('<h1')
    expect(about).toContain('<a href="/contact"')
    expect(about).toContain('<a href="/privacy"')
  })

  /**
   * Internal links are how a crawler discovers the corporate pages at all — a
   * sitemap is a hint, a followed href is the real discovery path. CorporatePageShell
   * renders genuine anchors for exactly this reason, and static markup is where
   * that becomes checkable: a `<button>` would leave no href behind.
   */
  it.each(indexablePages().filter((p) => p !== 'landing'))(
    '%s links back to the rest of the site with real hrefs',
    (page) => {
      const body = routes.find((r) => r.page === page)!.bodyHtml
      const hrefs = [...body.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1])

      expect(hrefs).toContain('/')
      expect(hrefs.filter((h) => h.startsWith('/')).length).toBeGreaterThanOrEqual(4)
    },
  )

  it('leaves farmer onboarding unrendered, as a head-only document', () => {
    const farmer = routes.find((r) => r.page === 'farmer-register')

    expect(farmer).toBeDefined()
    expect(farmer!.bodyHtml).toBe('')
    expect(metadataForPage('farmer-register').robots).toBe('noindex,nofollow')
  })

  /**
   * Fail-closed in the direction that matters: the prerender can never write a
   * file for a surface nobody approved.
   *
   * The two exceptions are named rather than inferred. /farmer is head-only and
   * excluded from search on purpose. /th/suppliers is public and prerendered
   * but not yet indexed — writing its file is what makes a shared link preview
   * correctly, and the register still keeps it out of the sitemap.
   */
  it('renders no page that is neither approved nor a named exception', () => {
    const approved = new Set<string>([...indexablePages(), 'farmer-register', 'th-supplier'])

    for (const route of routes) {
      expect(approved.has(route.page), `${route.page} is prerendered but not in the register`).toBe(
        true,
      )
    }
  })
})
