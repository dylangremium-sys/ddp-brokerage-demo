import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The crawl-policy files have to be STATIC files, and nothing else in the repo
 * would notice if they stopped being that.
 *
 * `vercel.json` rewrites `/((?!api/).*)` to `/index.html`. That rewrite is
 * correct for the application — it is what makes `/farmer` cold-load — but it
 * also swallows every well-known path that has no file behind it. Measured on
 * production before this guard existed:
 *
 *     GET https://ddpbrokerage.com/robots.txt   -> 200 text/html  (the SPA shell)
 *     GET https://ddpbrokerage.com/sitemap.xml  -> 200 text/html  (the SPA shell)
 *
 * A 200 is the trap. A crawler asking for a directive file and receiving an
 * HTML document does not retry and does not warn; the file simply never takes
 * effect, and the failure looks identical to success from the outside. Vercel
 * serves static files ahead of rewrites, so a real file in `public/` is the
 * whole fix — deleting one silently restores the defect, which is why this is
 * asserted rather than trusted.
 *
 * These assertions are deliberately offline. Whether production actually serves
 * these bytes with the right content type is a deployed-behaviour question and
 * belongs in the post-deploy check, not in a unit suite that must pass in CI
 * without network.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const read = (relativePath: string) => readFileSync(join(REPO_ROOT, relativePath), 'utf8')

/**
 * The apex 308-redirects to www, so www is the canonical host. Any published
 * URL on the apex points a crawler at a redirect instead of the page.
 */
const CANONICAL_ORIGIN = 'https://www.ddpbrokerage.com'

/** Lines that are neither blank nor comments, i.e. the directives themselves. */
const directivesOf = (robots: string) =>
  robots
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))

describe('robots.txt', () => {
  const robots = read('public/robots.txt')
  const directives = directivesOf(robots)

  it('exists as a static file with real directives, not just commentary', () => {
    expect(directives.length).toBeGreaterThan(0)
  })

  it('opens with a user-agent group, so the rules below it apply to anyone', () => {
    expect(directives[0]).toMatch(/^User-agent:\s*\*$/i)
  })

  /**
   * /farmer IS DELIBERATELY CRAWLABLE. This assertion is the inverse of the one
   * it replaces, and the reversal is the point.
   *
   * `Disallow: /farmer` looked like containment and was the opposite. Disallow
   * governs CRAWLING; a compliant crawler that obeys it never fetches the page
   * and therefore never reads the `noindex` the page carries. The exclusion sat
   * behind the rule that was supposed to enforce it, unreachable — while an
   * externally linked /farmer could still be indexed as a bare URL, because
   * nothing had ever delivered an exclusion a search engine could act on.
   *
   * Allowing the crawl is what makes the exclusion deliverable. The exclusion
   * itself is asserted below and in publicPageMetadata.test.ts:
   *   - `X-Robots-Tag: noindex, nofollow` on the /farmer path (vercel.json)
   *   - `<meta name="robots" content="noindex,nofollow">` (the register)
   */
  it('does NOT disallow farmer onboarding — the noindex must be fetchable', () => {
    expect(directives).not.toContain('Disallow: /farmer')
    const blocksFarmer = directives.some(
      (line) => /^Disallow:\s*\/farmer/i.test(line),
    )
    expect(
      blocksFarmer,
      'Disallowing /farmer makes its noindex unreachable to every compliant crawler, ' +
        'which is the exact defect this policy was changed to fix.',
    ).toBe(false)
  })

  it('keeps the API surface out of crawling', () => {
    expect(directives).toContain('Disallow: /api/')
  })

  /**
   * The landing page is client-rendered. Disallowing the bundle is the classic
   * self-inflicted wound: the page stays crawlable but renders as an empty
   * document to the crawler that is allowed to read it.
   */
  it('does not block the assets the page needs in order to render', () => {
    const blocksAssets = directives.some(
      (line) => /^Disallow:/i.test(line) && /\/assets|\.js|\.css/i.test(line),
    )
    expect(blocksAssets).toBe(false)
  })

  it('does not disallow the whole site — this file must not become a kill switch', () => {
    expect(directives).not.toContain('Disallow: /')
  })

  it('points at the sitemap on the canonical host', () => {
    expect(directives).toContain(`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`)
  })
})

describe('sitemap.xml', () => {
  const sitemap = read('public/sitemap.xml')
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim())

  it('exists as a static file and declares the sitemap namespace', () => {
    expect(sitemap).toContain('http://www.sitemaps.org/schemas/sitemap/0.9')
  })

  it('lists at least one URL — an empty sitemap is worse than none', () => {
    expect(locations.length).toBeGreaterThan(0)
  })

  it('lists every URL on the canonical host, never the redirecting apex', () => {
    const offenders = locations.filter((location) => !location.startsWith(`${CANONICAL_ORIGIN}/`))
    expect(offenders).toEqual([])
  })

  /**
   * The register of what may be published. Adding a URL here is a policy
   * decision about public search exposure, so it should require editing a test
   * that says so — not just appending a line to an XML file.
   *
   * The list grew from one URL to five when the public corporate pages were
   * added. That was the change the search-exposure programme was waiting on:
   * with a single indexable URL its later phases had no subject matter.
   *
   * This assertion is deliberately a hardcoded list rather than a comparison
   * against the application's own register. publicPageMetadata.test.ts does
   * make that comparison, and it is the more useful check — but if BOTH tests
   * derived their expectation from the same source, a page could be published
   * by editing that one source and nothing would object. One of the two has to
   * be a written-down list that a human decided on.
   */
  it('publishes only URLs approved for public search', () => {
    expect(locations).toEqual([
      `${CANONICAL_ORIGIN}/`,
      `${CANONICAL_ORIGIN}/about`,
      `${CANONICAL_ORIGIN}/contact`,
      `${CANONICAL_ORIGIN}/privacy`,
      `${CANONICAL_ORIGIN}/terms`,
    ])
  })

  it('does not advertise farmer, auth, admin or API paths', () => {
    const leaked = locations.filter((location) =>
      /\/(farmer|admin|api|login|set-password|forgot-password)/i.test(location),
    )
    expect(leaked).toEqual([])
  })
})

describe('the X-Robots-Tag header that actually excludes /farmer', () => {
  /**
   * WHY THIS HEADER IS THE AUTHORITATIVE CONTROL, NOT THE META TAG.
   *
   * An HTTP response header arrives with the response, before a single byte of
   * script is parsed, and it cannot be lost to a crawler that does not run
   * JavaScript, runs it and gives up, or fetches with a budget. That is why the
   * header is the control and the meta tag is defence in depth, rather than the
   * other way around.
   *
   * UPDATED 2026-08-08. This used to be the ONLY control that survived without
   * JavaScript: `vercel.json` rewrote every non-API path to `/index.html`, so
   * /farmer was served the same client-rendered document as everything else and
   * its `<meta name="robots">` was injected by the bundle. That is no longer
   * true — scripts/prerender-public-routes.mjs writes dist/farmer/index.html
   * with the noindex tag in the served bytes, so both controls now arrive
   * before any script runs.
   *
   * The ordering is unchanged and deliberate. A header cannot be stripped by a
   * parser that only reads part of a document, so it stays the control; the
   * meta tag being pre-rendered makes the defence deeper, not primary.
   *
   * These assertions are offline and check CONFIGURATION. Whether production
   * actually emits the header is a deployed-behaviour question for the
   * post-deploy check — it cannot be proven from the repository, and this file
   * deliberately does not pretend otherwise.
   */
  const vercelConfig = JSON.parse(read('vercel.json')) as {
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    rewrites?: Array<{ source: string; destination: string }>
  }

  const farmerRules = (vercelConfig.headers ?? []).filter((rule) => rule.source === '/farmer')

  it('sets X-Robots-Tag for the /farmer path', () => {
    expect(farmerRules.length, 'no header rule targets /farmer in vercel.json').toBe(1)

    const robotsHeader = farmerRules[0].headers.find(
      (header) => header.key.toLowerCase() === 'x-robots-tag',
    )
    expect(robotsHeader, '/farmer has a header rule but no X-Robots-Tag in it').toBeDefined()
    expect(robotsHeader?.value.replace(/\s+/g, '')).toBe('noindex,nofollow')
  })

  /**
   * Scope. A header rule written as `/(.*)` or `/farmer(.*)` would apply
   * noindex far beyond onboarding — in the worst case to the whole site,
   * silently de-indexing the corporate pages this PR exists to publish. The
   * blast radius of getting this wrong is the entire public surface, so the
   * source is pinned to the exact path.
   */
  it('scopes the header to exactly /farmer and nothing else', () => {
    for (const rule of vercelConfig.headers ?? []) {
      const setsRobots = rule.headers.some((header) => header.key.toLowerCase() === 'x-robots-tag')
      if (!setsRobots) continue
      expect(
        rule.source,
        `an X-Robots-Tag rule matches "${rule.source}". Anything broader than the exact ` +
          '/farmer path risks marking the approved public pages noindex.',
      ).toBe('/farmer')
    }
  })

  it('does not put X-Robots-Tag on the site-wide header block', () => {
    const siteWide = (vercelConfig.headers ?? []).find((rule) => rule.source === '/(.*)')
    expect(siteWide).toBeDefined()
    expect(
      siteWide?.headers.map((header) => header.key.toLowerCase()),
    ).not.toContain('x-robots-tag')
  })

  it('leaves the site-wide security headers intact', () => {
    // Adding a rule ahead of the existing block must not displace it.
    const siteWide = (vercelConfig.headers ?? []).find((rule) => rule.source === '/(.*)')
    const keys = siteWide?.headers.map((header) => header.key) ?? []
    expect(keys).toContain('Content-Security-Policy')
    expect(keys).toContain('X-Frame-Options')
    expect(keys).toContain('X-Content-Type-Options')
  })

  it('keeps the SPA rewrite as the fallback for every path without a file', () => {
    // This used to be asserted as the reason /farmer needs the header: the
    // rewrite served it the shared shell, and removing the rewrite would have
    // 404ed it. Since the prerender, /farmer has dist/farmer/index.html and is
    // resolved from the filesystem before this rewrite is consulted at all.
    //
    // The rewrite still matters, for everything else: an unmapped path has no
    // file, and without this it would 404 instead of loading the app and
    // rendering the landing page. Prerendering ADDED documents in front of the
    // rewrite; it did not replace it, and this asserts it was not removed as
    // though it had.
    expect(vercelConfig.rewrites?.at(-1)?.destination).toBe('/index.html')
    expect(vercelConfig.rewrites?.at(-1)?.source).toBe('/((?!api/).*)')
  })
})

describe('index.html document metadata', () => {
  /**
   * Comments are stripped first. The file explains in prose why it carries no
   * canonical link, and a naive scan for `rel="canonical"` matches that
   * explanation — so the guard would fail on the documentation of its own rule.
   * Assertions here are about markup the browser acts on, not about the text
   * around it.
   */
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '')

  it('has a non-empty meta description', () => {
    const description = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]*)"/is)?.[1]
    expect(description?.trim()).toBeTruthy()
  })

  it('keeps the description within the length search results actually show', () => {
    const description = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]*)"/is)?.[1] ?? ''
    expect(description.length).toBeLessThanOrEqual(160)
  })

  it('still has a title', () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/)
  })

  /**
   * The SPA rewrite serves this one document for every path, so a canonical
   * link added here would claim to describe `/farmer` too. If per-page
   * canonical is ever needed it has to be injected per route, and this guard
   * should be revisited deliberately at that point rather than deleted in
   * passing.
   */
  it('carries no static canonical link, which would apply to every path at once', () => {
    expect(html).not.toMatch(/rel="canonical"/i)
  })
})
