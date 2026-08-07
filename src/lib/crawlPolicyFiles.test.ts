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

  it('keeps farmer onboarding out of the index', () => {
    expect(directives).toContain('Disallow: /farmer')
  })

  it('keeps the API surface out of the index', () => {
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
   */
  it('publishes only URLs approved for public search', () => {
    expect(locations).toEqual([`${CANONICAL_ORIGIN}/`])
  })

  it('does not advertise farmer, auth, admin or API paths', () => {
    const leaked = locations.filter((location) =>
      /\/(farmer|admin|api|login|set-password|forgot-password)/i.test(location),
    )
    expect(leaked).toEqual([])
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
