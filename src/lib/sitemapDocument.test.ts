import { describe, expect, it } from 'vitest'

import { buildSitemapXml, isValidLastmod, sitemapEntries } from './sitemapDocument'
import {
  CANONICAL_ORIGIN,
  approvedSitemapUrls,
  indexablePages,
  metadataForPage,
} from './publicPageMetadata'
const locsOf = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const lastmodsOf = (xml: string) => [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1])

describe('the sitemap says exactly what the register approves', () => {
  it('publishes every approved URL and nothing else', () => {
    expect(locsOf(buildSitemapXml(sitemapEntries()))).toEqual(approvedSitemapUrls())
  })

  it('declares the sitemap namespace', () => {
    expect(buildSitemapXml(sitemapEntries())).toContain(
      'http://www.sitemaps.org/schemas/sitemap/0.9',
    )
  })

  it('never advertises farmer, auth, admin or API paths', () => {
    const leaked = locsOf(buildSitemapXml(sitemapEntries())).filter((loc) =>
      /\/(farmer|admin|api|login|set-password|forgot-password)/i.test(loc),
    )
    expect(leaked).toEqual([])
  })

  /**
   * The apex 308-redirects to www, so a <loc> on the apex points a crawler at a
   * redirect rather than at the page. This throws rather than emitting it: a
   * sitemap full of redirects is reported against the whole file in Search
   * Console, so failing the build is the cheaper outcome.
   */
  it('refuses to write a URL on the redirecting apex', () => {
    expect(() =>
      buildSitemapXml([{ loc: 'https://ddpbrokerage.com/about' }]),
    ).toThrow(/canonical host/)
  })

  it('refuses to write an empty sitemap', () => {
    expect(() => buildSitemapXml([])).toThrow(/empty/)
  })
})

describe('lastmod is authored, never derived', () => {
  /**
   * WHY THESE DATES ARE WRITTEN DOWN RATHER THAN COMPUTED
   *
   * They were briefly taken from git — the last commit touching a page's
   * sources — and that had two faults.
   *
   * It answered the wrong question. "This file changed" is not "a person
   * checked this page is still true", and on a page about regulation the second
   * claim is the only one worth publishing.
   *
   * And it could not be trusted where it ran. `git log -1 -- some/old/file` in
   * a shallow clone does not fail; it returns the boundary commit. Measured on
   * a depth-1 clone of this repo, files untouched since June reported as
   * changed that week. A CI host clones shallow by default, so the wrong answer
   * was the normal answer.
   *
   * The register now holds the date, one place, written by a person.
   */
  it('gives every published URL the register\'s reviewed date', () => {
    for (const entry of sitemapEntries()) {
      const page = indexablePages().find(
        (p) => `${CANONICAL_ORIGIN}${metadataForPage(p).canonicalPath}` === entry.loc,
      )!
      expect(entry.lastmod).toBe(metadataForPage(page).lastReviewed)
    }
  })

  it.each(indexablePages())('%s declares a real calendar date', (page) => {
    expect(isValidLastmod(metadataForPage(page).lastReviewed)).toBe(true)
  })

  it('writes a date for every URL, because every page has one', () => {
    const xml = buildSitemapXml(sitemapEntries())

    expect(lastmodsOf(xml)).toHaveLength(locsOf(xml).length)
  })

  it('keeps distinct dates distinct rather than flattening them', () => {
    const xml = buildSitemapXml([
      { loc: `${CANONICAL_ORIGIN}/`, lastmod: '2026-07-09' },
      { loc: `${CANONICAL_ORIGIN}/about`, lastmod: '2026-08-08' },
    ])

    expect(new Set(lastmodsOf(xml)).size).toBe(2)
  })

  /**
   * The builder keeps its all-or-nothing rule even though the register now
   * always supplies a date. A sitemap where two of seven URLs carry a date does
   * not read as "five are undated" — it reads as "five are older", which is a
   * claim nobody made. The rule is now structurally satisfied rather than
   * relied upon, and it stays as the assertion that keeps it that way.
   */
  it('still omits every date if any entry reaches it without one', () => {
    const xml = buildSitemapXml([
      { loc: `${CANONICAL_ORIGIN}/`, lastmod: '2026-08-08' },
      { loc: `${CANONICAL_ORIGIN}/about` },
    ])

    expect(lastmodsOf(xml)).toEqual([])
    expect(locsOf(xml)).toHaveLength(2)
  })

  /**
   * A build timestamp would stamp today on every page at every deploy, telling
   * a search engine the whole site changed whenever anything did. Nothing in
   * this module can produce one: it has no clock, and the build script no
   * longer reads git either.
   */
  it('has no clock of its own to stamp a build date from', () => {
    expect(buildSitemapXml([{ loc: `${CANONICAL_ORIGIN}/` }])).not.toMatch(/<lastmod>/)
  })

  it('rejects anything that is not a real W3C calendar date', () => {
    expect(isValidLastmod('2026-08-08')).toBe(true)
    expect(isValidLastmod('2026-02-30')).toBe(false)
    expect(isValidLastmod('2026-8-8')).toBe(false)
    expect(isValidLastmod('08/08/2026')).toBe(false)
    expect(isValidLastmod('2026-08-08T12:00:00Z')).toBe(false)

    expect(() =>
      buildSitemapXml([{ loc: `${CANONICAL_ORIGIN}/about`, lastmod: 'yesterday' }]),
    ).toThrow(/W3C dates/)
  })
})

describe('the date a visitor sees is the date the sitemap publishes', () => {
  /**
   * There were three copies of each review date: the machine date hardcoded in
   * the page shell, the human-readable string in translations, and the sitemap.
   * Nothing held them together, so a page could tell a reader it was reviewed
   * in August while telling a crawler something else entirely.
   *
   * The shells now read the machine date from the register, so the two cannot
   * disagree. This asserts the hardcoding has not come back.
   */
  const shells = import.meta.glob(
    ['../components/public/CorporatePageShell.tsx', '../pages/public/LocalisedBuyerPage.tsx'],
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>

  it('reads both shells, so the assertions below are not vacuous', () => {
    expect(Object.keys(shells)).toHaveLength(2)
  })

  it.each(Object.entries(shells))('%s takes its <time> from the register', (_path, source) => {
    expect(source).toContain('dateTime={metadataForPage(page).lastReviewed}')
    expect(source, 'a hardcoded machine date has come back').not.toMatch(/dateTime="\d{4}-\d{2}-\d{2}"/)
  })
})
