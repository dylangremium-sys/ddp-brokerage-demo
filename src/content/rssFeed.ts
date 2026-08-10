// ─── RSS feed for regulatory updates ────────────────────────────────────────
//
// WHY RSS AT ALL, IN 2026
//   Because of who reads this. Compliance and regulatory-affairs staff follow
//   sources they cannot afford to miss, and a feed reader is how that is done
//   without handing an address to a company they are still evaluating. It costs
//   the reader nothing and costs DDP no personal data, no consent record and no
//   retention policy — which is why this ships before email capture rather than
//   after it.
//
// WHAT IT IS BUILT FROM
//   The same entries as the pages and the sitemap. There is no second list and
//   no separate feed content: an entry is published, and it appears in the feed
//   because it exists, not because anyone remembered to add it.
//
// DATES: pubDate IS THE PUBLICATION DATE, DELIBERATELY
//   The sitemap publishes `lastVerified`, because "still true as of" is the
//   claim that matters to a crawler deciding whether to re-read a page. A feed
//   is a different question — a reader wants to know what is NEW, and re-dating
//   an old entry because it was re-verified would push it back to the top of
//   their reader as though it were news. So the feed uses `published` and
//   states the verification date in the item description instead.
//
// NO HTML IN DESCRIPTIONS
//   Items carry the entry's plain description, not its rendered body. Feed
//   readers vary wildly in what markup they accept and how they sanitise it,
//   and a regulatory note that renders differently in one reader than another
//   is worse than a short one that renders identically everywhere.

import { CANONICAL_ORIGIN } from '../lib/publicPageMetadata'
import type { RegulatoryEntry } from './regulatoryEntries'

/** RFC 822, which is what RSS requires — not ISO 8601. */
const RFC822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const RFC822_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Converts YYYY-MM-DD to an RFC 822 date.
 *
 * Fixed at midnight UTC. An entry is dated to a day, not a moment, and
 * inventing a time would imply a precision the frontmatter does not carry.
 */
export function toRfc822(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)

  // TWO DIFFERENT FAILURE MODES, and a NaN check only catches one of them.
  // '2026-08-32' is an Invalid Date. '2026-02-30' is not — JavaScript rolls it
  // over to 2 March and hands back a perfectly valid object, so a typo in a
  // frontmatter date would have been published as a different date entirely.
  // Round-tripping through ISO is what distinguishes them.
  if (Number.isNaN(parsed.getTime())) throw new Error(`not a date: ${date}`)
  if (parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`not a real calendar date: ${date} (rolls over to ${parsed.toISOString().slice(0, 10)})`)
  }

  const day = RFC822_DAYS[parsed.getUTCDay()]
  const month = RFC822_MONTHS[parsed.getUTCMonth()]
  return `${day}, ${String(parsed.getUTCDate()).padStart(2, '0')} ${month} ${parsed.getUTCFullYear()} 00:00:00 GMT`
}

/** XML text escaping. Ampersand first, or the others are double-escaped. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface FeedOptions {
  title: string
  description: string
  /** The hub, which the feed describes. */
  link: string
  /** Where this feed is served from, for the atom:link self reference. */
  feedUrl: string
}

/**
 * Renders the feed.
 *
 * An empty feed is valid RSS and is rendered rather than refused — unlike the
 * sitemap, where an empty file is worse than none. A reader who subscribes
 * before the first entry should get an empty feed that starts working, not a
 * 404 they have to remember to retry.
 */
export function buildRssFeed(entries: RegulatoryEntry[], options: FeedOptions): string {
  const items = entries
    .map((entry) => {
      const url = `${CANONICAL_ORIGIN}${entry.canonicalPath}`
      // The verification date belongs in the reader's view, not only on the
      // page: it is the reason to trust the item, and a feed reader shows the
      // description without following the link.
      const description = `${entry.description} (Last verified ${entry.lastVerified}. Reviewed by ${entry.reviewer}.)`

      return `    <item>
      <title>${escapeXml(entry.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${toRfc822(entry.published)}</pubDate>
      <description>${escapeXml(description)}</description>
    </item>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERATED. Do not edit.

  Built from the same entries as the pages and the sitemap, so an entry appears
  here because it exists rather than because anyone remembered to add it.

  pubDate is the PUBLICATION date, not the verification date. The sitemap
  publishes lastVerified because a crawler wants to know whether to re-read;
  a feed reader wants to know what is new, and re-dating an old entry because it
  was re-verified would push it back to the top of their reader as though it
  were news. The verification date is stated in each item's description instead.
-->
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(options.title)}</title>
    <link>${escapeXml(options.link)}</link>
    <description>${escapeXml(options.description)}</description>
    <language>en</language>
    <atom:link href="${escapeXml(options.feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`
}

/**
 * `Article` structured data for one entry.
 *
 * WHAT IS AND IS NOT ASSERTED
 *   This describes the DOCUMENT — its headline, its dates, its language, who
 *   reviewed it. It deliberately does NOT carry an `Organization` block with a
 *   legal name, address or affiliations: what this company may assert about
 *   itself is a decision for its officers, and structured data is not the place
 *   for it to arrive by default.
 *
 *   `reviewedBy` is the field a reader of the markup would look for and the one
 *   that matches what the page already shows. Where an entry names an
 *   individual it is a Person; otherwise it is the team, as an Organization.
 */
export function articleStructuredData(entry: RegulatoryEntry): Record<string, unknown> {
  const url = `${CANONICAL_ORIGIN}${entry.canonicalPath}`
  const namesAnIndividual = /[A-Za-z]\.|,/.test(entry.reviewer)

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: entry.title,
    description: entry.description,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    datePublished: entry.published,
    dateModified: entry.updated,
    inLanguage: 'en',
    author: { '@type': 'Organization', name: 'DDP Brokerage' },
    reviewedBy: namesAnIndividual
      ? { '@type': 'Person', name: entry.reviewer }
      : { '@type': 'Organization', name: entry.reviewer },
  }
}
