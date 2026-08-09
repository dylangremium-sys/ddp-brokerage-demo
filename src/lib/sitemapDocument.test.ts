import { describe, expect, it } from 'vitest'

import {
  buildSitemapXml,
  isValidLastmod,
  sitemapEntries,
  sourceFilesForPage,
} from './sitemapDocument'
import { CANONICAL_ORIGIN, approvedSitemapUrls, indexablePages } from './publicPageMetadata'
import type { Page } from '../types'
import { LOCALISED_BUYER_CONTENT } from '../pages/public/localisedBuyerContent'

/** The buyer pages rendered from one shared component — see the note below. */
const LOCALISED_PAGES: Page[] = LOCALISED_BUYER_CONTENT.map((c) => c.page)

const locsOf = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const lastmodsOf = (xml: string) => [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1])

/** Dates for every indexable page, for the "fully dated" cases below. */
const allDated = (date = '2026-08-08') =>
  Object.fromEntries(indexablePages().map((page) => [page, date])) as Partial<Record<Page, string>>

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

describe('lastmod is derived or absent, never invented', () => {
  it('writes a date for every URL when every date is known', () => {
    const xml = buildSitemapXml(sitemapEntries(allDated('2026-08-08')))

    expect(lastmodsOf(xml)).toEqual(indexablePages().map(() => '2026-08-08'))
  })

  it('keeps distinct dates distinct rather than flattening them', () => {
    const dates = { ...allDated('2026-07-09'), about: '2026-08-08' } as Partial<Record<Page, string>>
    const xml = buildSitemapXml(sitemapEntries(dates))

    expect(new Set(lastmodsOf(xml)).size).toBe(2)
  })

  /**
   * ALL-OR-NOTHING. A sitemap where two of five URLs carry a date does not read
   * as "three are undated" — it reads as "three are older than the two that are
   * dated", which is a claim nobody made.
   *
   * The build script hits this when git history is shallow, which is the normal
   * state of a CI clone: `git log -1 -- an/old/file` there does not fail, it
   * returns the boundary commit, so a file untouched for months reports as
   * changed this week. A confidently wrong date is the thing the previous
   * hand-maintained-sitemap decision refused to publish.
   */
  it('omits every date when any single date is missing', () => {
    const partial = { ...allDated() }
    delete partial[indexablePages()[0]]

    const xml = buildSitemapXml(sitemapEntries(partial))

    expect(lastmodsOf(xml)).toEqual([])
    expect(locsOf(xml)).toEqual(approvedSitemapUrls())
  })

  it('omits every date when none are supplied at all', () => {
    expect(lastmodsOf(buildSitemapXml(sitemapEntries()))).toEqual([])
  })

  /**
   * A build timestamp would stamp today on all five pages at every deploy,
   * telling a search engine the whole site changed whenever anything did. The
   * builder cannot produce one: it has no clock, and every date it writes is
   * passed in from git.
   */
  it('has no clock of its own to stamp a build date from', () => {
    const xml = buildSitemapXml(sitemapEntries())
    expect(xml).not.toMatch(/<lastmod>/)
  })

  it('rejects anything that is not a real W3C calendar date', () => {
    expect(isValidLastmod('2026-08-08')).toBe(true)
    expect(isValidLastmod('2026-02-30')).toBe(false)
    expect(isValidLastmod('2026-8-8')).toBe(false)
    expect(isValidLastmod('08/08/2026')).toBe(false)
    expect(isValidLastmod('2026-08-08T12:00:00Z')).toBe(false)

    expect(() => buildSitemapXml([{ loc: `${CANONICAL_ORIGIN}/about`, lastmod: 'yesterday' }])).toThrow(
      /W3C dates/,
    )
  })
})

describe('every indexable page can actually be dated', () => {
  /**
   * A page with no declared sources would silently be undated, and because
   * dates are all-or-nothing it would strip them from the whole sitemap. That
   * would look like "git was shallow" rather than "someone added a page and
   * forgot", so it is asserted here instead.
   */
  it.each(indexablePages())('%s declares the sources whose history dates it', (page) => {
    const sources = sourceFilesForPage(page)

    expect(sources.length).toBeGreaterThan(0)
    expect(sources).toContain('src/translations.ts')
    expect(sources).toContain('src/lib/publicPageMetadata.ts')
  })

  /** The sources unique to a page, with the ones every page shares removed. */
  const ownSourcesOf = (page: Page) =>
    sourceFilesForPage(page)
      .filter((f) => !f.startsWith('src/translations') && !f.includes('publicPageMetadata'))
      .join(',')

  /**
   * Pages that have a component to themselves must have a source list to
   * themselves, or one of them is silently dated by another's history.
   */
  it('gives each single-component page a source list of its own', () => {
    const solo = indexablePages().filter((page) => !LOCALISED_PAGES.includes(page))
    const own = solo.map(ownSourcesOf)

    expect(new Set(own).size).toBe(own.length)
  })

  /**
   * The localised buyer pages are the deliberate exception, and the exception
   * has a cost worth writing down rather than discovering later.
   *
   * /de and /cs are rendered by ONE component from ONE content file, so they
   * share a source list and therefore always share a lastmod: editing the
   * German copy moves the Czech date too. That is an over-claim, in the same
   * direction and for the same reason as including translations.ts — it errs
   * toward "look at this again" rather than toward a date that says a page is
   * unchanged when its words were rewritten.
   *
   * Splitting the content per language would make the dates exact. It would
   * also fragment the one file that keeps the two legal notices in step across
   * languages, which is the more valuable property.
   */
  it('dates the localised buyer pages together, because they share a component', () => {
    const [first, ...rest] = LOCALISED_PAGES

    for (const page of rest) {
      expect(ownSourcesOf(page)).toBe(ownSourcesOf(first))
    }
    expect(ownSourcesOf(first)).toContain('LocalisedBuyerPage')
  })

  it('declares no sources for a page the register does not approve', () => {
    expect(sourceFilesForPage('farmer-register')).toEqual([])
    expect(sourceFilesForPage('admin-dashboard' as Page)).toEqual([])
  })
})
