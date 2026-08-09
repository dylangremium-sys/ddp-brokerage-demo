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

describe('the German page carries the limits, not just the pitch', () => {
  const body = routeFor('de-buyer')!.bodyHtml

  it('is rendered at all', () => {
    expect(body.length).toBeGreaterThan(500)
  })

  /**
   * landingAuthorityNote, translated. The English says DDP "does not certify
   * export readiness, pharmaceutical readiness, or legal compliance in any
   * jurisdiction". All three must survive.
   */
  it('states what DDP does NOT certify', () => {
    expect(body).toContain('zertifiziert weder')
    expect(body).toContain('Exportfähigkeit')
    expect(body).toContain('pharmazeutische Eignung')
    expect(body).toContain('Einhaltung gesetzlicher')
  })

  /** landingDisclaimer, translated: licensed operators, lawful jurisdictions. */
  it('states who may use the platform', () => {
    expect(body).toContain('lizenzierte Cannabis-Unternehmen')
    expect(body).toContain('rechtlich')
    expect(body).toContain('zulässig')
  })

  /**
   * The page must not quietly become a claims surface. Anything asserting an
   * approval, certification or partnership belongs in a reviewed change, not
   * in a translation.
   */
  it('claims no certification, approval or partnership of its own', () => {
    for (const forbidden of ['zertifiziert durch', 'zugelassen von', 'GMP-zertifiziert', 'Partner von', 'garantiert']) {
      expect(body, `"${forbidden}" is an unreviewed claim`).not.toContain(forbidden)
    }
  })

  it('has exactly one heading', () => {
    expect(body.match(/<h1[\s>]/g) ?? []).toHaveLength(1)
  })

  it('links back to the English site with a real href a crawler can follow', () => {
    expect(body).toContain('<a href="/"')
    expect(body).toContain('<a href="/contact"')
  })
})

describe('/de is reachable, indexable and served in German', () => {
  it('cold-loads from its own path, with or without a trailing slash', () => {
    expect(getInitialPageFromPath('/de')).toBe('de-buyer')
    expect(getInitialPageFromPath('/de/')).toBe('de-buyer')
    expect(pathForPage('de-buyer')).toBe('/de')
  })

  it('is a public page, so the navigation guard admits a signed-out visitor', () => {
    expect(PUBLIC_PAGES).toContain('de-buyer')
  })

  it('is approved for indexing and appears in the sitemap set', () => {
    expect(isIndexable('de-buyer')).toBe(true)
    expect(indexablePages()).toContain('de-buyer')
  })

  it('gets a prerendered document of its own, off the SPA rewrite', () => {
    expect(outputPathForPage('de-buyer')).toBe('de/index.html')
  })

  /**
   * A German document still claiming lang="en" is what a screen reader uses to
   * pick a voice and what a search engine uses to decide whose results it
   * belongs in.
   */
  it('declares lang="de" in the served document', () => {
    const doc = buildPrerenderedDocument(SHELL, 'de-buyer', '<main>x</main>')

    expect(doc).toContain('<html lang="de"')
    expect(doc).not.toContain('<html lang="en"')
  })

  it('leaves every other page in English', () => {
    for (const page of indexablePages().filter((p) => p !== 'de-buyer')) {
      expect(buildPrerenderedDocument(SHELL, page, '<main>x</main>')).toContain('<html lang="en"')
    }
  })

  it('publishes a German title and description, not English ones', () => {
    const meta = metadataForPage('de-buyer')

    expect(meta.title).toContain('Einkäufer')
    expect(meta.description).toContain('Prüfpakete')
    expect(meta.description.length).toBeLessThanOrEqual(160)
  })
})

describe('hreflang tells search engines these are alternates, not duplicates', () => {
  /**
   * A one-way hreflang is ignored outright — the most common way this is got
   * wrong. Both directions are asserted rather than assumed.
   */
  it('is reciprocal between the landing page and /de', () => {
    const fromEnglish = languageAlternatesFor('landing').map((a) => a.hreflang)
    const fromGerman = languageAlternatesFor('de-buyer').map((a) => a.hreflang)

    expect(fromEnglish).toContain('de')
    expect(fromEnglish).toContain('en')
    expect(fromGerman).toContain('en')
    expect(fromGerman).toContain('de')
  })

  it('names an x-default, and points it at the English page', () => {
    const xDefault = languageAlternatesFor('de-buyer').find((a) => a.hreflang === 'x-default')

    expect(xDefault?.href).toBe(canonicalUrlFor('landing'))
  })

  it('writes the alternates into both served documents', () => {
    for (const page of ['landing', 'de-buyer'] as const) {
      const doc = buildPrerenderedDocument(SHELL, page, '<main>x</main>')

      expect(doc).toContain(`hreflang="de" href="${canonicalUrlFor('de-buyer')}"`)
      expect(doc).toContain(`hreflang="en" href="${canonicalUrlFor('landing')}"`)
      expect(doc).toContain('hreflang="x-default"')
    }
  })

  /** Each page still canonicalises to ITSELF. hreflang groups; it does not merge. */
  it('does not canonicalise the German page onto the English one', () => {
    const doc = buildPrerenderedDocument(SHELL, 'de-buyer', '<main>x</main>')

    expect(doc).toContain(`<link rel="canonical" href="${canonicalUrlFor('de-buyer')}" />`)
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
