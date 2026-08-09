// ─── Sitemap document builder ───────────────────────────────────────────────
//
// WHY THE SITEMAP IS GENERATED RATHER THAN WRITTEN
//   It used to be a hand-maintained file in public/. That was correct while it
//   was the only mechanism that had to agree with the register, and two tests
//   held them in step. Prerendering added a THIRD thing that has to agree: a
//   URL in the sitemap now needs a prerendered document behind it, or Vercel
//   falls through to the SPA rewrite and hands the crawler the landing document
//   under the landing canonical — a failure that looks exactly like success.
//
//   Three artefacts kept in step by assertion is one more than is comfortable.
//   So the sitemap is now produced by the SAME loop that writes the documents,
//   from the same route list, in scripts/prerender-public-routes.mjs. A page
//   cannot be advertised without a document existing, because the advert is
//   written from the act of writing the document.
//
//   The register is still the authority on WHICH pages are public. This module
//   only turns that decision into XML.
//
// WHY THIS FILE IS PURE
//   Reading git and writing files happens in the build script. Everything that
//   decides what the XML SAYS lives here, so it is asserted in the default node
//   suite with no build, no git and no filesystem.

import type { Page } from '../types'
import { CANONICAL_ORIGIN, indexablePages, metadataForPage } from './publicPageMetadata'

/**
 * The sources whose history dates a page.
 *
 * WHY A DECLARED LIST AND NOT THE MODULE GRAPH
 *   The honest question a `lastmod` answers is "did the words on this page
 *   change". The bundler's import graph would answer a different one — it
 *   reaches every shared utility a component happens to touch, so a change to
 *   an unrelated helper would date the page as freshly edited.
 *
 * WHY translations.ts IS IN EVERY LIST
 *   It holds the words. A page's component is mostly structure; the sentences a
 *   reader and a crawler actually see are keys in that file, so a copy edit that
 *   did not touch the component is still a change to the page.
 *
 *   The cost is an over-claim: editing a Thai string for one page moves the date
 *   on all five. That is an approximation and worth being plain about. It errs
 *   toward "look at this again", where the alternative — omitting translations
 *   and dating a page as unchanged after its text was rewritten — errs toward
 *   "do not bother", which is the stale timestamp the previous decision refused
 *   to hand-maintain.
 *
 * WHY publicPageMetadata.ts IS IN EVERY LIST
 *   It holds the title and description. Those are the page as it appears in a
 *   result, so editing one is editing the page.
 */
const SHARED_SOURCES = ['src/translations.ts', 'src/lib/publicPageMetadata.ts'] as const

/** Chrome shared by the four corporate pages: header, footer, provenance line. */
const CORPORATE_SHELL = 'src/components/public/CorporatePageShell.tsx'

const PAGE_SOURCES: Partial<Record<Page, readonly string[]>> = {
  landing: ['src/pages/public/LandingPage.tsx'],
  about: ['src/pages/public/AboutPage.tsx', CORPORATE_SHELL],
  contact: ['src/pages/public/ContactPage.tsx', CORPORATE_SHELL],
  privacy: ['src/pages/public/PrivacyPage.tsx', CORPORATE_SHELL],
  terms: ['src/pages/public/TermsPage.tsx', CORPORATE_SHELL],
  // Standalone: it carries its own chrome and its own German copy, so neither
  // the corporate shell nor translations.ts changes what it says.
  'de-buyer': ['src/pages/public/GermanBuyerPage.tsx'],
}

/** Every file whose last commit dates `page`, shared sources included. */
export function sourceFilesForPage(page: Page): string[] {
  const own = PAGE_SOURCES[page]
  if (!own) return []
  return [...own, ...SHARED_SOURCES]
}

export interface SitemapEntry {
  loc: string
  /** W3C date, YYYY-MM-DD. Omitted when it could not be established. */
  lastmod?: string
}

/**
 * The entries the sitemap may contain, in register order.
 *
 * `lastmodByPage` is supplied by the build script from git. A page missing from
 * it simply gets no date — see buildSitemapXml for why that is all-or-nothing
 * in practice.
 */
export function sitemapEntries(lastmodByPage: Partial<Record<Page, string>> = {}): SitemapEntry[] {
  return indexablePages().map((page) => {
    const entry: SitemapEntry = { loc: `${CANONICAL_ORIGIN}${metadataForPage(page).canonicalPath}` }
    const lastmod = lastmodByPage[page]
    if (lastmod) entry.lastmod = lastmod
    return entry
  })
}

/** True for a W3C date of the form YYYY-MM-DD that is also a real calendar date. */
export function isValidLastmod(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Renders the sitemap.
 *
 * ALL-OR-NOTHING DATES. If any entry lacks a lastmod, none are written.
 *
 * A sitemap where two of five URLs carry a date does not read as "three are
 * undated" — it reads as "three are older than the two that are dated", which
 * is a claim nobody made. The previous decision was to publish no lastmod at
 * all rather than a hand-maintained one that goes stale silently; this keeps
 * the spirit of it by refusing to publish a set of dates that is only partly
 * derived. The build script logs loudly when it happens.
 */
export function buildSitemapXml(entries: SitemapEntry[]): string {
  if (entries.length === 0) {
    throw new Error('refusing to write an empty sitemap — an empty one is worse than none')
  }

  const offenders = entries.filter((entry) => !entry.loc.startsWith(`${CANONICAL_ORIGIN}/`))
  if (offenders.length > 0) {
    // The apex 308-redirects to www. A <loc> on the wrong host points a crawler
    // at a redirect instead of at the page.
    throw new Error(
      `sitemap entries are not on the canonical host: ${offenders.map((o) => o.loc).join(', ')}`,
    )
  }

  const invalid = entries.filter((entry) => entry.lastmod && !isValidLastmod(entry.lastmod))
  if (invalid.length > 0) {
    throw new Error(
      `sitemap lastmod values are not W3C dates: ${invalid.map((i) => `${i.loc}=${i.lastmod}`).join(', ')}`,
    )
  }

  const dated = entries.every((entry) => entry.lastmod)

  const body = entries
    .map((entry) => {
      const lines = [`    <loc>${entry.loc}</loc>`]
      if (dated) lines.push(`    <lastmod>${entry.lastmod}</lastmod>`)
      return `  <url>\n${lines.join('\n')}\n  </url>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERATED by scripts/prerender-public-routes.mjs. Do not edit.

  Written by the same loop that writes the prerendered documents, from the same
  route list, so a URL cannot be advertised here without a document existing to
  serve it. The register in src/lib/publicPageMetadata.ts decides which pages
  are public; this file is that decision rendered as XML.

  The host is www.ddpbrokerage.com. The apex 308-redirects to www, so every
  <loc> must use www or a crawler is pointed at a redirect.

  lastmod is the date of the last commit touching the page's own component, the
  corporate shell where it applies, translations.ts and the metadata register —
  never a build timestamp, which would claim every page changed on every deploy.
  Dates are all-or-nothing: if any could not be derived from git, none are
  written. See src/lib/sitemapDocument.ts.

  Farmer onboarding, authentication, operational and evidence surfaces are out
  of scope by policy, not by omission.
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`
}
