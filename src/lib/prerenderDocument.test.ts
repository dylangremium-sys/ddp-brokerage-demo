import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildHeadTags, buildPrerenderedDocument, outputPathForPage } from './prerenderDocument'
import { CANONICAL_ORIGIN, indexablePages, metadataForPage } from './publicPageMetadata'
import type { Page } from '../types'

/**
 * THE DEFECT THESE TESTS PIN
 *
 * Measured on production, 8 August 2026, before this module existed:
 *
 *   /          04215a413c545971cbd045fa2f18c015
 *   /about     04215a413c545971cbd045fa2f18c015
 *   /contact   04215a413c545971cbd045fa2f18c015
 *   /privacy   04215a413c545971cbd045fa2f18c015
 *   /terms     04215a413c545971cbd045fa2f18c015
 *
 * Five URLs, one document, 1,593 bytes, no <h1> in any of them — and the same
 * bytes for a Googlebot user agent as for a browser, so nothing was blocking
 * anything. publicPageMetadata.ts wrote the correct per-page title, description
 * and canonical, but it wrote them from JavaScript, after the crawler that
 * needed them had already been served and left.
 *
 * These assertions are on the pure builder, so they run in the default node
 * environment with no build and no network. Whether the deployed site actually
 * serves these bytes is a post-deploy question — see the header of
 * scripts/prerender-public-routes.mjs for the one check that answers it, and
 * why a green suite here cannot.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A stand-in for the built dist/index.html: the same shape Vite emits, with
 * hashed asset URLs, a comment to be stripped, and the shell's own title and
 * description for the builder to replace rather than duplicate.
 */
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DDP Brokerage — Procurement Intelligence</title>
    <!-- a decision record that mentions <link rel="canonical"> in prose -->
    <meta
      name="description"
      content="DDP turns farm stock, batch records, COAs, and pricing into clear review packs for serious buyers."
    />
    <script type="module" crossorigin src="/assets/index-BGbLJgAg.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-7OWnoBY2.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

const attr = (doc: string, tag: RegExp) => doc.match(tag)?.[1]

const titleOf = (doc: string) => attr(doc, /<title>([\s\S]*?)<\/title>/)
const canonicalOf = (doc: string) => attr(doc, /<link rel="canonical" href="([^"]*)"/)
const robotsOf = (doc: string) => attr(doc, /<meta name="robots" content="([^"]*)"/)
const descriptionOf = (doc: string) => attr(doc, /<meta name="description" content="([^"]*)"/)

describe('every prerendered document carries its own head', () => {
  it.each(indexablePages())('%s gets the register’s title, canonical and robots', (page) => {
    const doc = buildPrerenderedDocument(SHELL, page, '<main>body</main>')
    const meta = metadataForPage(page)

    expect(titleOf(doc)).toBe(meta.title)
    expect(canonicalOf(doc)).toBe(`${CANONICAL_ORIGIN}${meta.canonicalPath}`)
    expect(robotsOf(doc)).toBe('index,follow')
    expect(descriptionOf(doc)).toBe(meta.description)
  })

  /**
   * The heart of it. Distinct titles and canonicals are the whole difference
   * between five pages and five copies of one page.
   */
  it('produces a distinct document for every indexable page', () => {
    const documents = indexablePages().map((page) =>
      buildPrerenderedDocument(SHELL, page, `<main>${page}</main>`),
    )

    expect(new Set(documents).size).toBe(documents.length)
    expect(new Set(documents.map(titleOf)).size).toBe(documents.length)
    expect(new Set(documents.map(canonicalOf)).size).toBe(documents.length)
  })

  it('replaces the shell’s title rather than leaving two in the document', () => {
    const doc = buildPrerenderedDocument(SHELL, 'about', '<main>body</main>')

    expect(doc.match(/<title>/g)).toHaveLength(1)
    expect(doc).not.toContain('DDP Brokerage — Procurement Intelligence')
  })

  it('replaces the shell’s description rather than publishing both', () => {
    const doc = buildPrerenderedDocument(SHELL, 'privacy', '<main>body</main>')

    expect(doc.match(/name="description"/g)).toHaveLength(1)
    expect(descriptionOf(doc)).toBe(metadataForPage('privacy').description)
  })

  it('emits exactly one canonical, and does not match the one named in a comment', () => {
    const doc = buildPrerenderedDocument(SHELL, 'terms', '<main>body</main>')

    expect(doc.match(/rel="canonical"/g)).toHaveLength(1)
    expect(doc).not.toContain('a decision record that mentions')
  })
})

describe('the served document contains the page, not an empty root', () => {
  it('renders the body inside #root instead of leaving it empty', () => {
    const doc = buildPrerenderedDocument(SHELL, 'about', '<main><h1>About DDP Brokerage</h1></main>')

    expect(doc).toContain('<div id="root"><main><h1>About DDP Brokerage</h1></main></div>')
    expect(doc).not.toContain('<div id="root"></div>')
  })

  it('keeps the hashed script and stylesheet the build emitted', () => {
    const doc = buildPrerenderedDocument(SHELL, 'contact', '<main>body</main>')

    expect(doc).toContain('/assets/index-BGbLJgAg.js')
    expect(doc).toContain('/assets/index-7OWnoBY2.css')
  })

  it('refuses a shell that is not the SPA document, rather than writing a broken page', () => {
    expect(() => buildPrerenderedDocument('<html><body></body></html>', 'about', '<p>x</p>')).toThrow(
      /root/,
    )
  })
})

describe('/farmer stays excluded, and the exclusion no longer needs JavaScript', () => {
  it('is written with noindex in the served bytes', () => {
    const doc = buildPrerenderedDocument(SHELL, 'farmer-register', '')

    expect(robotsOf(doc)).toBe('noindex,nofollow')
  })

  /**
   * The register is explicit that onboarding must not be consolidated with the
   * landing page. Without a document of its own, /farmer would be served
   * dist/index.html — landing markup under a canonical of "/" — which is that
   * consolidation by accident.
   */
  it('keeps its own canonical rather than pointing at the landing page', () => {
    const doc = buildPrerenderedDocument(SHELL, 'farmer-register', '')

    expect(canonicalOf(doc)).toBe(`${CANONICAL_ORIGIN}/farmer`)
    expect(canonicalOf(doc)).not.toBe(`${CANONICAL_ORIGIN}/`)
  })

  it('is head-only: the registration flow is not rendered into the page', () => {
    const doc = buildPrerenderedDocument(SHELL, 'farmer-register', '')

    expect(doc).toContain('<div id="root"></div>')
  })
})

describe('a page with no register entry cannot become indexable by being prerendered', () => {
  it('falls closed to noindex, exactly as metadataForPage does', () => {
    const doc = buildPrerenderedDocument(SHELL, 'admin-dashboard' as Page, '<main>secrets</main>')

    expect(robotsOf(doc)).toBe('noindex,nofollow')
    expect(descriptionOf(doc)).toBeUndefined()
  })
})

describe('link previews stop rendering bare', () => {
  it('publishes Open Graph tags for an indexable page', () => {
    const doc = buildPrerenderedDocument(SHELL, 'about', '<main>body</main>')
    const meta = metadataForPage('about')

    expect(doc).toContain(`<meta property="og:title" content="${meta.title}" />`)
    expect(doc).toContain(`<meta property="og:url" content="${CANONICAL_ORIGIN}/about" />`)
    expect(doc).toContain('<meta property="og:type" content="website" />')
    expect(doc).toContain('<meta name="twitter:card" content="summary" />')
  })

  /**
   * A preview may restate the page and may not extend it. og:title and
   * og:description are the register's strings verbatim, so there is no channel
   * through which a preview could assert something the page does not.
   */
  it('says nothing the register does not already say', () => {
    for (const page of indexablePages()) {
      const head = buildHeadTags(page)
      const meta = metadataForPage(page)

      expect(head).toContain(`content="${meta.title}"`)
      expect(head).toContain(`content="${meta.description}"`)
    }
  })

  /**
   * Deliberate omissions, asserted so that adding either is a visible decision
   * rather than a drive-by. An og:image needs an approved asset; JSON-LD
   * `Organization` asserts legal-entity facts, which is a decision for the
   * company's officers and not a side effect of a rendering change.
   */
  it('publishes no og:image and no structured data', () => {
    const doc = buildPrerenderedDocument(SHELL, 'about', '<main>body</main>')

    expect(doc).not.toContain('og:image')
    expect(doc).not.toContain('application/ld+json')
  })
})

describe('output paths follow the canonical the page claims', () => {
  it('writes the landing page to the SPA entry document', () => {
    expect(outputPathForPage('landing')).toBe('index.html')
  })

  it.each(indexablePages().filter((p) => p !== 'landing'))(
    '%s is written where Vercel resolves its canonical path',
    (page) => {
      const { canonicalPath } = metadataForPage(page)
      expect(outputPathForPage(page)).toBe(`${canonicalPath.slice(1)}/index.html`)
    },
  )

  it('gives farmer onboarding a file of its own, off the SPA rewrite', () => {
    expect(outputPathForPage('farmer-register')).toBe('farmer/index.html')
  })
})

describe('the prerender and the crawl-policy files describe the same site', () => {
  const sitemap = readFileSync(join(REPO_ROOT, 'public', 'sitemap.xml'), 'utf8')
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())

  /**
   * A URL in the sitemap with no prerendered file behind it is the failure
   * that looks most like success: the sitemap advertises it, Vercel falls
   * through to the SPA rewrite, and the crawler is handed the landing document
   * under the landing canonical — which is the defect this change removes,
   * reintroduced one page at a time.
   */
  it('prerenders a document for every URL the sitemap publishes', () => {
    const prerenderedUrls = indexablePages().map(
      (page) => `${CANONICAL_ORIGIN}${metadataForPage(page).canonicalPath}`,
    )

    expect(prerenderedUrls.sort()).toEqual(sitemapUrls.sort())
  })
})
