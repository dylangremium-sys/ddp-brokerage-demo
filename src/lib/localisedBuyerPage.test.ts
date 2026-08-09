import { describe, expect, it } from 'vitest'

import { renderPublicRoutes } from '../prerender/entry'
import {
  canonicalUrlFor,
  indexablePages,
  isIndexable,
  languageAlternatesFor,
  metadataForPage,
} from './publicPageMetadata'
import { buildPrerenderedDocument, outputPathForPage } from './prerenderDocument'
import { getInitialPageFromPath, pathForPage } from './urlRouting'
import { PUBLIC_PAGES } from './navigationGuard'
import { LOCALISED_BUYER_CONTENT, localisedBuyerContentFor } from '../pages/public/localisedBuyerContent'
import type { Page } from '../types'

/** Every localised buyer page, so a new language inherits all of these tests. */
const LOCALISED: Page[] = LOCALISED_BUYER_CONTENT.map((c) => c.page)

/**
 * Phrases that must survive translation, per language. These are the two legal
 * notices — what DDP does not certify, and who may use the platform — reduced
 * to the words that carry them. A page missing any of these would make a
 * stronger claim in its own language than the company makes in English.
 */
const REQUIRED_PHRASES: Record<string, string[]> = {
  'de-buyer': ['zertifiziert weder', 'Exportfähigkeit', 'pharmazeutische Eignung', 'lizenzierte Cannabis-Unternehmen'],
  'cs-buyer': ['necertifikuje', 'připravenost k exportu', 'farmaceutickou způsobilost', 'licencovaným subjektům'],
}

/**
 * THE PAGE THIS FILE GUARDS, AND THE ONE RULE IT MUST NOT BREAK
 *
 * /de exists because the site published English and Thai — Thai serving the
 * SUPPLY side, Thai farms reached by QR code — while both demand-side markets
 * the company names had no language on the site at all.
 *
 * No wording on this site has been through a compliance review in any of the
 * six jurisdictions the company operates across, and cannabis advertising rules
 * differ sharply between them. So the page is built as a TRANSLATION of copy
 * already published in English, and the two sentences that bound everything
 * else — what DDP does not certify, and who may use the platform — must survive
 * into German. A page that dropped them would be making a stronger claim in
 * German than the company makes in English, which is the specific failure worth
 * a test.
 */

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>DDP Brokerage — Procurement Intelligence</title>
    <script type="module" crossorigin src="/assets/index-BGbLJgAg.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

const routeFor = (page: string) => renderPublicRoutes().find((r) => r.page === page)

/** Source-reading follows the house convention: import.meta.glob with ?raw. */
function source(pattern: Record<string, string>): string {
  return Object.values(pattern)[0] ?? ''
}

describe.each(LOCALISED)('%s carries the limits, not just the pitch', (page) => {
  const body = routeFor(page)!.bodyHtml

  it('is rendered at all', () => {
    expect(body.length).toBeGreaterThan(500)
  })

  /**
   * The two legal notices, translated. A language added without them would be
   * published to the sitemap making claims the English site does not.
   */
  it('carries both legal notices', () => {
    const required = REQUIRED_PHRASES[page]
    expect(required, `no required phrases declared for ${page}`).toBeDefined()
    for (const phrase of required) {
      expect(body, `"${phrase}" missing — a legal notice was dropped or softened`).toContain(phrase)
    }
  })

  it('claims no certification, approval or partnership of its own', () => {
    for (const forbidden of ['zertifiziert durch', 'zugelassen von', 'GMP', 'Partner von', 'garantiert', 'certifikováno', 'schváleno', 'garantujeme']) {
      expect(body, `"${forbidden}" is an unreviewed claim`).not.toContain(forbidden)
    }
  })

  it('has exactly one heading', () => {
    expect(body.match(/<h1[\s>]/g) ?? []).toHaveLength(1)
  })

  it('links back to the English site and to contact with real hrefs', () => {
    expect(body).toContain('<a href="/"')
    expect(body).toContain('<a href="/contact"')
  })

  it('has a content record and a register entry that agree on language', () => {
    expect(localisedBuyerContentFor(page)!.lang).toBe(metadataForPage(page).lang)
  })
})

describe('the localised pages are reachable, indexable and served in their own language', () => {
  it.each(LOCALISED)('%s cold-loads from its own path, trailing slash or not', (page) => {
    const path = metadataForPage(page).canonicalPath
    expect(getInitialPageFromPath(path)).toBe(page)
    expect(getInitialPageFromPath(`${path}/`)).toBe(page)
    expect(pathForPage(page)).toBe(path)
  })

  it.each(LOCALISED)('%s is public, so the guard admits a signed-out visitor', (page) => {
    expect(PUBLIC_PAGES).toContain(page)
  })

  it.each(LOCALISED)('%s is approved for indexing and in the sitemap set', (page) => {
    expect(isIndexable(page)).toBe(true)
    expect(indexablePages()).toContain(page)
  })

  it.each(LOCALISED)('%s gets a document of its own, off the SPA rewrite', (page) => {
    expect(outputPathForPage(page)).toBe(`${metadataForPage(page).canonicalPath.slice(1)}/index.html`)
  })

  /**
   * A German document still claiming lang="en" is what a screen reader uses to
   * pick a voice and what a search engine uses to decide whose results it
   * belongs in.
   */
  it.each(LOCALISED)('%s declares its own lang in the served document', (page) => {
    const lang = metadataForPage(page).lang!
    const doc = buildPrerenderedDocument(SHELL, page, '<main>x</main>')

    expect(doc).toContain(`<html lang="${lang}"`)
    expect(doc).not.toContain('<html lang="en"')
  })

  it('leaves every non-localised page in English', () => {
    for (const page of indexablePages().filter((p) => !LOCALISED.includes(p))) {
      expect(buildPrerenderedDocument(SHELL, page, '<main>x</main>')).toContain('<html lang="en"')
    }
  })

  it.each(LOCALISED)('%s publishes a title and description within snippet length', (page) => {
    const meta = metadataForPage(page)

    expect(meta.title.length).toBeGreaterThan(10)
    expect(meta.description.length).toBeLessThanOrEqual(160)
    expect(meta.description.length).toBeGreaterThan(40)
  })

  it('gives every localised page a distinct title and description', () => {
    const titles = LOCALISED.map((p) => metadataForPage(p).title)
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('hreflang tells search engines these are alternates, not duplicates', () => {
  /**
   * A one-way hreflang is ignored outright — the most common way this is got
   * wrong. Both directions are asserted rather than assumed.
   */
  it('is reciprocal across every language in the group', () => {
    const group: Page[] = ['landing', ...LOCALISED]
    const expected = group.map((p) => metadataForPage(p).lang ?? 'en').sort()

    for (const page of group) {
      const seen = languageAlternatesFor(page)
        .map((a) => a.hreflang)
        .filter((h) => h !== 'x-default')
        .sort()
      expect(seen, `${page} does not point at every alternate`).toEqual(expected)
    }
  })

  it.each(LOCALISED)('%s names an x-default pointing at the English page', (page) => {
    const xDefault = languageAlternatesFor(page).find((a) => a.hreflang === 'x-default')

    expect(xDefault?.href).toBe(canonicalUrlFor('landing'))
  })

  it('writes every alternate into every document in the group', () => {
    for (const page of ['landing', ...LOCALISED] as Page[]) {
      const doc = buildPrerenderedDocument(SHELL, page, '<main>x</main>')

      for (const member of ['landing', ...LOCALISED] as Page[]) {
        const lang = metadataForPage(member).lang ?? 'en'
        expect(doc, `${page} is missing the ${lang} alternate`).toContain(
          `hreflang="${lang}" href="${canonicalUrlFor(member)}"`,
        )
      }
      expect(doc).toContain('hreflang="x-default"')
    }
  })

  /** Each page still canonicalises to ITSELF. hreflang groups; it does not merge. */
  it.each(LOCALISED)('%s canonicalises to itself, not onto the English page', (page) => {
    const doc = buildPrerenderedDocument(SHELL, page, '<main>x</main>')

    expect(doc).toContain(`<link rel="canonical" href="${canonicalUrlFor(page)}" />`)
    expect(doc).not.toContain(`<link rel="canonical" href="${canonicalUrlFor('landing')}" />`)
  })

  it('keeps the page language out of the reach of the EN/TH toggle', () => {
    // The bug this pins, found in a browser rather than a test: the served
    // document arrived correctly as <html lang="de">, and App.tsx's language
    // effect — `document.documentElement.lang = lang`, where lang is the app's
    // EN/TH state — immediately overwrote it with 'en'. The served bytes and
    // the rendered DOM then disagreed, and a rendering crawler resolves that
    // against the DOM. The register, not the toggle, decides.
    const app = source(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

    expect(app).toContain('metadataForPage(page).lang ?? lang')
    expect(app).not.toMatch(/document\.documentElement\.lang = lang\b/)
  })

  it('adds no alternates to a page that has no translation', () => {
    expect(languageAlternatesFor('about')).toEqual([])
    expect(buildPrerenderedDocument(SHELL, 'about', '<main>x</main>')).not.toContain('hreflang')
  })
})
