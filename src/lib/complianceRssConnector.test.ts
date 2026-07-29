import { describe, expect, it } from 'vitest'
import type { RegulatorySource } from '../types'
import {
  parseRssOrAtomFeed,
  extractRssItems,
  extractAtomItems,
  buildFeedItemSnapshot,
  buildRssMonitoringDecisions,
  executeRssConnector,
  feedItemSourceId,
  FeedParseError,
  type ParsedFeed,
  type RssConnectorOptions,
  type RssFetchImpl,
  type RssFetchResponse,
} from './complianceRssConnector'
import type { SourceContentSnapshot } from './complianceSourceMonitoring'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Thai FDA Notices</title>
  <item>
    <title>Notice A</title>
    <link>https://www.fda.moph.go.th/a</link>
    <guid>guid-a</guid>
    <description>Body A &amp; more</description>
    <pubDate>Wed, 09 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>ประกาศ B</title>
    <link>https://www.fda.moph.go.th/b</link>
    <guid>guid-b</guid>
    <description><![CDATA[เนื้อหาภาษาไทย ๑๒๓]]></description>
    <pubDate>Wed, 09 Jul 2026 11:00:00 GMT</pubDate>
  </item>
</channel></rss>`

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>DFT Atom Feed</title>
  <entry>
    <title>Entry A</title>
    <link href="https://api.dft.go.th/a" rel="alternate"/>
    <id>atom-a</id>
    <summary>Summary A</summary>
    <updated>2026-07-09T10:00:00Z</updated>
  </entry>
</feed>`

const RSS_URL = 'https://www.fda.moph.go.th/rss.xml'
const ATOM_URL = 'https://api.dft.go.th/atom.xml'
const ALLOWED = ['www.fda.moph.go.th', 'api.dft.go.th']

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'source-rss-1',
    name: 'Thai FDA — Narcotics Control Division',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: RSS_URL,
    isActive: true,
    lastCheckedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface MockOpts {
  status?: number
  contentType?: string | null
  redirected?: boolean
  url?: string
  contentLength?: number
  throwError?: Error
}

let lastFetchCallCount = 0

function mockFetch(body: string, opts: MockOpts = {}): RssFetchImpl {
  const status = opts.status ?? 200
  return async () => {
    lastFetchCallCount++
    if (opts.throwError) throw opts.throwError
    const resp: RssFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      url: opts.url,
      redirected: opts.redirected,
      headers: {
        get(name: string): string | null {
          const k = name.toLowerCase()
          if (k === 'content-type') return opts.contentType === null ? null : (opts.contentType ?? 'application/rss+xml')
          if (k === 'content-length') return opts.contentLength != null ? String(opts.contentLength) : null
          return null
        },
      },
      text: async () => body,
    }
    return resp
  }
}

const OPTS: RssConnectorOptions = { userAgent: 'DDP-Compliance-Bot/1.0 (+compliance@ddp.example)', now: () => '2026-07-10T00:00:00.000Z' }

// The connector module's own source, imported raw for the static-safety
// assertions (no global fetch, no AI reference).
const RAW_MODULES = import.meta.glob('./complianceRssConnector.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const MODULE_SOURCE = Object.values(RAW_MODULES)[0] ?? ''

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe('parseRssOrAtomFeed / extractors', () => {
  it('parses an RSS 2.0 feed and its item fields', () => {
    const feed = parseRssOrAtomFeed(RSS_XML)
    expect(feed.kind).toBe('rss')
    expect(feed.title).toBe('Thai FDA Notices')
    expect(feed.items).toHaveLength(2)
    const a = feed.items[0]
    expect(a.title).toBe('Notice A')
    expect(a.link).toBe('https://www.fda.moph.go.th/a')
    expect(a.id).toBe('guid-a')
    expect(a.content).toBe('Body A & more') // entity decoded
    expect(a.published).toBe('Wed, 09 Jul 2026 10:00:00 GMT')
    expect(extractRssItems(RSS_XML)).toHaveLength(2)
  })

  it('parses an Atom feed and its entry fields', () => {
    const feed = parseRssOrAtomFeed(ATOM_XML)
    expect(feed.kind).toBe('atom')
    expect(feed.title).toBe('DFT Atom Feed')
    expect(feed.items).toHaveLength(1)
    const e = feed.items[0]
    expect(e.title).toBe('Entry A')
    expect(e.link).toBe('https://api.dft.go.th/a')
    expect(e.id).toBe('atom-a')
    expect(e.summary).toBe('Summary A')
    expect(e.published).toBe('2026-07-09T10:00:00Z')
    expect(extractAtomItems(ATOM_XML)).toHaveLength(1)
  })

  it('preserves Thai / Unicode item text (raw and CDATA)', () => {
    const feed = parseRssOrAtomFeed(RSS_XML)
    expect(feed.items[1].title).toBe('ประกาศ B')
    expect(feed.items[1].content).toBe('เนื้อหาภาษาไทย ๑๒๓')
    expect(feed.items[1].rawText).toContain('ประกาศ B')
    expect(feed.items[1].rawText).toContain('เนื้อหาภาษาไทย ๑๒๓')
  })

  it('rejects malformed (unterminated) feed XML with malformed_feed', () => {
    expect(() => parseRssOrAtomFeed('<rss version="2.0"><channel><item><title>x</title></item>'))
      .toThrow(FeedParseError)
    try {
      parseRssOrAtomFeed('<rss version="2.0"><channel><item><title>x</title></item>')
    } catch (err) {
      expect((err as FeedParseError).code).toBe('malformed_feed')
    }
  })

  it('rejects non-feed XML with not_a_feed', () => {
    try {
      parseRssOrAtomFeed('<catalog><book>Compliance</book></catalog>')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(FeedParseError)
      expect((err as FeedParseError).code).toBe('not_a_feed')
    }
    expect(() => parseRssOrAtomFeed('<html><body>hi</body></html>')).toThrow(FeedParseError)
  })
})

// ─── Checksums / monitoring decisions ────────────────────────────────────────

describe('buildFeedItemSnapshot + buildRssMonitoringDecisions', () => {
  it('produces a stable checksum for identical item content', async () => {
    const feed = parseRssOrAtomFeed(RSS_XML)
    const s1 = await buildFeedItemSnapshot(feed.items[0])
    const s2 = await buildFeedItemSnapshot(feed.items[0])
    expect(s1.checksum).toBe(s2.checksum)
    const other = await buildFeedItemSnapshot(feed.items[1])
    expect(other.checksum).not.toBe(s1.checksum)
  })

  it('first-seen items return changed_pending_review', async () => {
    const source = makeSource()
    const feed = parseRssOrAtomFeed(RSS_XML)
    const decisions = await buildRssMonitoringDecisions(source, feed, new Map(), '2026-07-10T00:00:00.000Z')
    expect(decisions).toHaveLength(2)
    expect(decisions.every(d => d.kind === 'changed_pending_review')).toBe(true)
    // Intent only: proposed legal update, if any, is status 'new'.
    for (const d of decisions) {
      if (d.proposedLegalUpdate) expect(d.proposedLegalUpdate.status).toBe('new')
    }
  })

  it('unchanged item (matching prior checksum) returns unchanged', async () => {
    const source = makeSource()
    const feed = parseRssOrAtomFeed(RSS_XML)
    const item0 = feed.items[0]
    const snap = await buildFeedItemSnapshot(item0)
    const previous = new Map<string, SourceContentSnapshot>([
      [feedItemSourceId(source, item0), {
        sourceId: feedItemSourceId(source, item0),
        normalizedContent: snap.normalizedContent,
        checksum: snap.checksum,
        retrievedAt: '2026-07-01T00:00:00.000Z',
      }],
    ])
    const decisions = await buildRssMonitoringDecisions(source, feed, previous, '2026-07-10T00:00:00.000Z')
    expect(decisions[0].kind).toBe('unchanged')
    expect(decisions[1].kind).toBe('changed_pending_review') // item B still first-seen
  })

  it('changed item (different prior checksum) returns changed_pending_review', async () => {
    const source = makeSource()
    const feed = parseRssOrAtomFeed(RSS_XML)
    const item0 = feed.items[0]
    const previous = new Map<string, SourceContentSnapshot>([
      [feedItemSourceId(source, item0), {
        sourceId: feedItemSourceId(source, item0),
        normalizedContent: 'stale content',
        checksum: 'deadbeef-not-the-current-checksum',
        retrievedAt: '2026-07-01T00:00:00.000Z',
      }],
    ])
    const decisions = await buildRssMonitoringDecisions(source, feed, previous, '2026-07-10T00:00:00.000Z')
    expect(decisions[0].kind).toBe('changed_pending_review')
  })

  it('a duplicate item within the same feed is reported as duplicate', async () => {
    const source = makeSource()
    // Append a byte-identical copy of Notice A (same guid + content) — a notice
    // repeated within the same feed. Identical normalized content → duplicate.
    const dupXml = RSS_XML.replace('</channel>', `
  <item>
    <title>Notice A</title>
    <link>https://www.fda.moph.go.th/a</link>
    <guid>guid-a</guid>
    <description>Body A &amp; more</description>
    <pubDate>Wed, 09 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel>`)
    const feed = parseRssOrAtomFeed(dupXml)
    expect(feed.items).toHaveLength(3)
    const decisions = await buildRssMonitoringDecisions(source, feed, new Map(), '2026-07-10T00:00:00.000Z')
    expect(decisions.some(d => d.kind === 'duplicate')).toBe(true)
  })

  it('an item with no usable content yields invalid_source', async () => {
    const source = makeSource()
    const emptyFeed: ParsedFeed = {
      kind: 'rss',
      title: null,
      items: [{ title: null, link: null, id: 'empty-1', summary: null, content: null, published: null, rawText: '\n\n\n\n\n' }],
    }
    const decisions = await buildRssMonitoringDecisions(source, emptyFeed, new Map(), '2026-07-10T00:00:00.000Z')
    expect(decisions[0].kind).toBe('invalid_source')
  })
})

// ─── executeRssConnector — success + safety rejections (fetch fully mocked) ──

describe('executeRssConnector', () => {
  it('fetches (via mock) and parses an RSS feed', async () => {
    lastFetchCallCount = 0
    const result = await executeRssConnector(makeSource(), ALLOWED, mockFetch(RSS_XML), OPTS)
    expect(result.ok).toBe(true)
    expect(result.feedKind).toBe('rss')
    expect(result.itemCount).toBe(2)
    expect(result.decisions).toHaveLength(2)
    expect(lastFetchCallCount).toBe(1) // the injected mock is the only fetch
  })

  it('fetches (via mock) and parses an Atom feed', async () => {
    const result = await executeRssConnector(
      makeSource({ url: ATOM_URL }),
      ALLOWED,
      mockFetch(ATOM_XML, { contentType: 'application/atom+xml' }),
      OPTS,
    )
    expect(result.ok).toBe(true)
    expect(result.feedKind).toBe('atom')
    expect(result.itemCount).toBe(1)
  })

  it('rejects a non-HTTPS source before fetching', async () => {
    lastFetchCallCount = 0
    const result = await executeRssConnector(
      makeSource({ url: 'http://www.fda.moph.go.th/rss.xml' }),
      ALLOWED,
      mockFetch(RSS_XML),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_https')
    expect(lastFetchCallCount).toBe(0) // never fetched
  })

  it('rejects an off-allowlist host before fetching', async () => {
    lastFetchCallCount = 0
    const result = await executeRssConnector(
      makeSource({ url: 'https://evil.example.com/rss.xml' }),
      ALLOWED,
      mockFetch(RSS_XML),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('off_allowlist')
    expect(lastFetchCallCount).toBe(0)
  })

  it('rejects an HTML response by content-type', async () => {
    const result = await executeRssConnector(makeSource(), ALLOWED, mockFetch('<html></html>', { contentType: 'text/html' }), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid_content_type')
  })

  it('handles a fetch timeout (AbortError) as timeout', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const result = await executeRssConnector(makeSource(), ALLOWED, mockFetch('', { throwError: abort }), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('timeout')
  })

  it('rejects an oversized response', async () => {
    const big = `<?xml version="1.0"?><rss><channel>${'<item><title>x</title></item>'.repeat(50)}</channel></rss>`
    const result = await executeRssConnector(makeSource(), ALLOWED, mockFetch(big), { ...OPTS, maxResponseBytes: 32 })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('oversized_response')
  })

  it('rejects a redirected response (no redirect following)', async () => {
    const result = await executeRssConnector(
      makeSource(),
      ALLOWED,
      mockFetch(RSS_XML, { redirected: true, url: 'https://evil.example.com/rss.xml' }),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('redirect_blocked')
  })

  it('rejects malformed feed content fetched with an XML content-type', async () => {
    const result = await executeRssConnector(
      makeSource(),
      ALLOWED,
      mockFetch('<rss><channel><item><title>x</title></item>', { contentType: 'application/xml' }),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('malformed_feed')
  })

  it('rejects non-feed XML fetched with an XML content-type', async () => {
    const result = await executeRssConnector(
      makeSource(),
      ALLOWED,
      mockFetch('<catalog><book>x</book></catalog>', { contentType: 'text/xml' }),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_a_feed')
  })
})

// ─── Capability + no-network guarantees ──────────────────────────────────────

describe('safety guarantees', () => {
  it('the module references no global fetch / network API and no AI provider', () => {
    expect(MODULE_SOURCE).not.toMatch(/\bfetch\s*\(/) // only the injected fetchImpl(...) is called
    expect(MODULE_SOURCE).not.toMatch(/XMLHttpRequest/)
    expect(MODULE_SOURCE).not.toMatch(/\baxios\b/)
    expect(MODULE_SOURCE).not.toMatch(/node-fetch/)
    expect(MODULE_SOURCE).not.toMatch(/globalThis\.fetch|window\.fetch/)
    expect(MODULE_SOURCE).not.toMatch(/aiCompliance/)
    expect(MODULE_SOURCE).not.toMatch(/anthropic/i)
    expect(MODULE_SOURCE).not.toMatch(/openai/i)
  })

  it('connector output carries no legal_update / rule / AI write capability', async () => {
    const forbiddenKeys = ['legalUpdate', 'legalUpdateId', 'proposedLegalUpdate', 'ruleCode', 'ruleId', 'approved', 'persist']
    const ok = await executeRssConnector(makeSource(), ALLOWED, mockFetch(RSS_XML), OPTS)
    const rejected = await executeRssConnector(makeSource({ url: 'http://x/rss.xml' }), ALLOWED, mockFetch(RSS_XML), OPTS)
    for (const result of [ok, rejected]) {
      expect(result.performsPersistence).toBe(false)
      expect(result.canCreateLegalUpdate).toBe(false)
      expect(result.canCreateRule).toBe(false)
      expect(result.canCallAI).toBe(false)
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(false)
      }
    }
  })
})

// ─── Source-policy field projection (Cannamonitor integration) ───────────────
//
// The connector gained an optional FeedItemFieldPolicy. These tests pin the two
// properties that matter: it is OFF by default (no existing source changes
// behaviour), and when supplied it runs BEFORE rawText is assembled.

describe('feed item field policy', () => {
  const FEED = `<rss version="2.0"><channel><item>
    <title>Synthetic Title</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/?p=1</guid>
    <pubDate>Fri, 10 Jul 2026 09:00:00 +0000</pubDate>
    <description>SYNTHETIC_DESCRIPTION_MARKER</description>
  </item></channel></rss>`

  it('is identity when no policy is supplied — existing behaviour is unchanged', () => {
    const feed = parseRssOrAtomFeed(FEED)
    expect(feed.items[0].summary).toBe('SYNTHETIC_DESCRIPTION_MARKER')
    expect(feed.items[0].rawText).toContain('SYNTHETIC_DESCRIPTION_MARKER')
  })

  it('applies the projection before rawText is assembled', () => {
    const metadataOnly = {
      policyId: 'test-metadata-only',
      projectFields: (f: { title: string | null; link: string | null; id: string | null; published: string | null }) => ({
        ...f,
        summary: null,
        content: null,
      }),
    }
    const feed = parseRssOrAtomFeed(FEED, metadataOnly)
    expect(feed.items[0].summary).toBeNull()
    expect(feed.items[0].content).toBeNull()
    // The prohibited value is absent from rawText — not stripped afterwards, but
    // never concatenated in the first place.
    expect(feed.items[0].rawText).not.toContain('SYNTHETIC_DESCRIPTION_MARKER')
    expect(feed.items[0].rawText).toContain('Synthetic Title')
  })

  it('projects atom entries too', () => {
    const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Synthetic Atom Title</title>
      <link href="https://example.com/b"/>
      <id>urn:uuid:1</id>
      <published>2026-07-10T09:00:00Z</published>
      <summary>SYNTHETIC_SUMMARY_MARKER</summary>
    </entry></feed>`
    const metadataOnly = {
      policyId: 'test-metadata-only',
      projectFields: (f: Record<string, string | null>) => ({ ...f, summary: null, content: null }),
    }
    const feed = parseRssOrAtomFeed(ATOM, metadataOnly as never)
    expect(feed.items[0].rawText).not.toContain('SYNTHETIC_SUMMARY_MARKER')
    expect(feed.items[0].rawText).toContain('Synthetic Atom Title')
  })
})
