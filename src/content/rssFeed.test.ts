import { describe, expect, it } from 'vitest'

import { buildRssFeed, toRfc822, articleStructuredData } from './rssFeed'
import { parseEntry } from './regulatoryEntries'
import { CANONICAL_ORIGIN } from '../lib/publicPageMetadata'

const OPTIONS = {
  title: 'DDP Brokerage — Regulatory updates',
  description: 'Notes on regulatory developments affecting licensed cannabis supply.',
  link: `${CANONICAL_ORIGIN}/regulatory-updates`,
  feedUrl: `${CANONICAL_ORIGIN}/regulatory-updates/feed.xml`,
}

const make = (over: Record<string, string> = {}) => {
  const fields = {
    title: 'Thai licence sunset',
    description: 'What the sunset means for licensed producers supplying into the EU.',
    published: '2026-08-14',
    lastVerified: '2026-08-20',
    reviewer: 'A. Reviewer, Compliance Lead',
    ...over,
  }
  const front = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
  return parseEntry(
    '/content/regulatory/2026-08-thai-licence-sunset.md',
    `---\n${front}\n---\n\nBody text.\n`,
  )
}

describe('the feed carries what a compliance reader needs', () => {
  const feed = () => buildRssFeed([make()], OPTIONS)

  it('is valid RSS with a self reference', () => {
    expect(feed()).toContain('<rss version="2.0"')
    expect(feed()).toContain(`<atom:link href="${OPTIONS.feedUrl}" rel="self"`)
  })

  it('uses the canonical URL as a permanent guid', () => {
    const url = `${CANONICAL_ORIGIN}/regulatory-updates/2026-08-thai-licence-sunset`
    expect(feed()).toContain(`<guid isPermaLink="true">${url}</guid>`)
    expect(feed()).toContain(`<link>${url}</link>`)
  })

  /**
   * THE DATE DECISION, ASSERTED.
   *
   * The sitemap publishes lastVerified — a crawler wants to know whether to
   * re-read. A feed reader wants to know what is NEW, so pubDate is the
   * publication date. Using lastVerified here would push an old entry back to
   * the top of somebody's reader every time it was re-checked, which is how a
   * feed teaches people to ignore it.
   */
  it('dates items by publication, not by verification', () => {
    const entry = make({ published: '2026-08-14', lastVerified: '2026-08-20' })
    const xml = buildRssFeed([entry], OPTIONS)

    expect(xml).toContain('<pubDate>Fri, 14 Aug 2026 00:00:00 GMT</pubDate>')
    expect(xml).not.toContain('20 Aug 2026 00:00:00 GMT</pubDate>')
  })

  /** The verification date is the reason to trust the item, so it is visible. */
  it('states the verification date and reviewer in the item description', () => {
    expect(feed()).toContain('Last verified 2026-08-20')
    expect(feed()).toContain('Reviewed by A. Reviewer, Compliance Lead')
  })

  it('emits RFC 822 dates, which is what RSS requires — not ISO 8601', () => {
    expect(toRfc822('2026-08-09')).toBe('Sun, 09 Aug 2026 00:00:00 GMT')
    expect(toRfc822('2026-12-31')).toBe('Thu, 31 Dec 2026 00:00:00 GMT')
    expect(() => toRfc822('2026-02-30')).toThrow()
  })

  it('escapes XML rather than emitting it', () => {
    const xml = buildRssFeed([make({ title: 'Rules & "limits" <changed>' })], OPTIONS)

    expect(xml).toContain('Rules &amp; &quot;limits&quot; &lt;changed&gt;')
    expect(xml).not.toContain('<changed>')
  })

  /**
   * An empty feed is valid and is rendered rather than refused — unlike the
   * sitemap, where empty is worse than absent. Somebody who subscribes before
   * the first entry should get a feed that starts working, not a 404 they have
   * to remember to retry.
   */
  it('renders an empty feed rather than refusing one', () => {
    const xml = buildRssFeed([], OPTIONS)

    expect(xml).toContain('<rss version="2.0"')
    expect(xml).not.toContain('<item>')
  })

  it('carries no HTML body, only the plain description', () => {
    const xml = buildRssFeed([make()], OPTIONS)

    expect(xml).not.toContain('<p>')
    expect(xml).not.toContain('Body text')
  })
})

describe('Article schema describes the document, not the company', () => {
  it('carries the headline, dates and language', () => {
    const data = articleStructuredData(make())

    expect(data['@type']).toBe('Article')
    expect(data.headline).toBe('Thai licence sunset')
    expect(data.datePublished).toBe('2026-08-14')
    expect(data.dateModified).toBe('2026-08-14')
    expect(data.inLanguage).toBe('en')
  })

  it('tracks dateModified when an entry is updated', () => {
    expect(articleStructuredData(make({ updated: '2026-08-25' })).dateModified).toBe('2026-08-25')
  })

  it('names an individual reviewer as a Person', () => {
    expect(articleStructuredData(make()).reviewedBy).toEqual({
      '@type': 'Person',
      name: 'A. Reviewer, Compliance Lead',
    })
  })

  it('falls back to the team as an Organization', () => {
    const entry = make()
    const anonymous = { ...entry, reviewer: 'DDP Brokerage — Compliance & Operations' }
    expect(articleStructuredData(anonymous).reviewedBy).toEqual({
      '@type': 'Organization',
      name: 'DDP Brokerage — Compliance & Operations',
    })
  })

  /**
   * DELIBERATE OMISSIONS, asserted so that adding either is a visible decision
   * rather than a drive-by. A publisher or Organization block asserts a legal
   * name, an address and affiliations — facts about the company that its
   * officers decide, not something that arrives by default in markup.
   */
  it('asserts no legal identity, address or affiliation', () => {
    const json = JSON.stringify(articleStructuredData(make()))

    for (const forbidden of ['legalName', 'address', 'taxID', 'duns', 'sameAs', 'publisher', 'parentOrganization']) {
      expect(json, `${forbidden} asserts a fact about the company`).not.toContain(forbidden)
    }
  })
})
