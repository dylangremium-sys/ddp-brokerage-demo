// Unit tests for the HTML page-change watcher.
//
// Every test drives an injected fetch — no socket is opened. The properties
// that matter are: it only fires when watched content actually changes, it
// reuses the shared safety gates rather than re-implementing them, and it
// describes itself as an observation about a PAGE rather than a finding about
// a LAW.

import { describe, it, expect } from 'vitest'
import {
  executeHtmlWatchConnector,
  htmlWatchItemId,
  HTML_WATCH_WINDOW_CHARS,
  HTML_WATCH_TERMS,
} from './complianceHtmlWatchConnector'
import type { RssFetchImpl, RssConnectorResult } from './complianceRssConnector'
import { buildMonitoringDecision, type SourceContentSnapshot } from './complianceSourceMonitoring'
import type { RegulatorySource } from '../types'

const HOST = 'www.fda.moph.go.th'
const SOURCE: RegulatorySource = {
  id: 'src-thai-fda',
  name: 'Thai FDA',
  jurisdiction: 'TH',
  sourceType: 'government_regulator',
  url: `https://${HOST}/`,
  isActive: true,
  monitoringMethod: 'html',
  createdAt: '',
  updatedAt: '',
}

const OPTS = { userAgent: 'test-agent', now: () => '2026-08-02T12:00:00.000Z' }

/** Returns the single watched item, failing the test if the connector did not
 *  produce one. Replaces `watchedItem(result)`: a non-null assertion would
 *  turn "the connector returned a failure" into an unreadable TypeError
 *  several lines away from the cause. */
function watchedItem(result: RssConnectorResult) {
  expect(result.ok, `connector failed: ${result.reason}`).toBe(true)
  const items = result.feed?.items ?? []
  expect(items).toHaveLength(1)
  return items[0]
}


function htmlFetch(body: string, opts: { status?: number; contentType?: string; contentLength?: string } = {}): RssFetchImpl {
  const { status = 200, contentType = 'text/html; charset=utf-8' } = opts
  const map = new Map<string, string>([['content-type', contentType]])
  if (opts.contentLength) map.set('content-length', opts.contentLength)
  return () => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
  })
}

/** Builds the snapshot a previous run would have stored for `text`. */
async function snapshotFor(text: string): Promise<Map<string, SourceContentSnapshot>> {
  const decision = await buildMonitoringDecision(htmlWatchItemId(SOURCE), text, null, [], '2026-08-01T12:00:00.000Z')
  const map = new Map<string, SourceContentSnapshot>()
  if (decision.snapshot) map.set(htmlWatchItemId(SOURCE), decision.snapshot)
  return map
}

describe('executeHtmlWatchConnector — change detection', () => {
  it('reports a first sighting as a candidate', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('Cannabis export licence rules updated.'), OPTS)
    expect(result.ok).toBe(true)
    expect(result.itemCount).toBe(1)
    expect(result.decisions[0].kind).toBe('changed_pending_review')
  })

  it('reports an UNCHANGED page as unchanged', async () => {
    const text = 'Cannabis export licence rules updated.'
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(text), {
      ...OPTS,
      previousSnapshots: await snapshotFor(text),
    })
    expect(result.ok).toBe(true)
    expect(result.decisions[0].kind).toBe('unchanged')
  })

  it('reports a genuinely changed page as changed', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('Cannabis export licence rules REVISED again.'), {
      ...OPTS,
      previousSnapshots: await snapshotFor('Cannabis export licence rules updated.'),
    })
    expect(result.decisions[0].kind).toBe('changed_pending_review')
  })

  it('does NOT fire on whitespace reflow alone', async () => {
    // An HTML-to-text conversion moves line breaks around between fetches
    // without the content changing. If that registered as a change, every run
    // would produce a candidate and the watcher would be pure noise.
    const original = 'Cannabis export licence rules updated.'
    const reflowed = 'Cannabis   export\n\nlicence  rules\tupdated.'
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(reflowed), {
      ...OPTS,
      previousSnapshots: await snapshotFor(original),
    })
    expect(result.decisions[0].kind).toBe('unchanged')
  })

  it('uses a stable item id, so the previous snapshot is found across runs', () => {
    expect(htmlWatchItemId(SOURCE)).toBe('src-thai-fda::page')
    // Two independent runs must agree, or every run looks like a first sighting.
    expect(htmlWatchItemId({ ...SOURCE })).toBe(htmlWatchItemId(SOURCE))
  })
})

describe('executeHtmlWatchConnector — noise suppression on long pages', () => {
  /** A ministry homepage: a lot of chrome, one relevant paragraph, and a
   *  visitor counter that changes on literally every request. */
  function ministryPage(counter: number): string {
    const chrome = Array.from({ length: 400 }, (_, i) => `Navigation item ${i} — about us, contact, sitemap, accessibility`).join('\n')
    const relevant = 'Notification on cannabis export licence requirements for registered operators.'
    const noise = `Visitors today: ${counter}`
    return [noise, chrome, relevant, chrome, noise].join('\n')
  }

  it('produces a page longer than the watch window (test premise)', () => {
    expect(ministryPage(1).length).toBeGreaterThan(HTML_WATCH_WINDOW_CHARS)
  })

  it('ignores a changing visitor counter far from any watched term', async () => {
    // The decisive test for usability. Whole-page fingerprinting would mark
    // this changed on every single run, which trains an operator to ignore the
    // alarm — strictly worse than having no watcher.
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(ministryPage(99_999)), {
      ...OPTS,
      previousSnapshots: await snapshotFor(
        // What the previous run would have stored: the selected window, not the page.
        watchedItem(await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(ministryPage(1)), OPTS)).rawText,
      ),
    })
    expect(result.decisions[0].kind).toBe('unchanged')
  })

  it('still fires when the watched text itself changes', async () => {
    const before = watchedItem(await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(ministryPage(1)), OPTS)).rawText
    const changedPage = ministryPage(1).replace('cannabis export licence requirements', 'cannabis export licence SUSPENSION')
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(changedPage), {
      ...OPTS,
      previousSnapshots: await snapshotFor(before),
    })
    expect(result.decisions[0].kind).toBe('changed_pending_review')
  })

  it('bounds the candidate text to the AI summariser evidence limit', async () => {
    // DEFAULT_MAX_EVIDENCE_CHARS is 20000. A candidate larger than that would
    // render the "Generate AI Draft Summary" button enabled and guaranteed to
    // fail with oversized_evidence — the same enabled-dead-end shape PR #104
    // had to remove from the source-URL path.
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(ministryPage(1)), OPTS)
    expect(watchedItem(result).rawText.length).toBeLessThanOrEqual(HTML_WATCH_WINDOW_CHARS)
  })

  it('carries verbatim source text, never fabricated text', async () => {
    const page = ministryPage(1)
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch(page), OPTS)
    for (const line of watchedItem(result).rawText.split('\n')) {
      expect(page).toContain(line)
    }
  })

  it('includes Thai terms, since the six html sources publish in Thai', () => {
    expect(HTML_WATCH_TERMS).toContain('กัญชา')
    expect(HTML_WATCH_TERMS).toContain('ประกาศ')
  })
})

describe('executeHtmlWatchConnector — safety gates', () => {
  it('refuses a host that is not allowlisted', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, ['other.example.com'], htmlFetch('x'), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('off_allowlist')
  })

  it('refuses a non-HTTPS source', async () => {
    const result = await executeHtmlWatchConnector({ ...SOURCE, url: `http://${HOST}/` }, [HOST], htmlFetch('x'), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_https')
  })

  it('refuses a source whose inferred kind is a feed, not a page', async () => {
    const result = await executeHtmlWatchConnector(
      { ...SOURCE, url: `https://${HOST}/feed/` },
      [HOST],
      htmlFetch('x'),
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('unsupported_connector')
  })

  it('applies the Cannamonitor policy gate to this transport too', async () => {
    // A gate that guards only the RSS path is not a gate. Adding a second
    // transport without re-applying it is exactly how such a gate stops holding.
    let fetched = false
    const spy: RssFetchImpl = (...args) => {
      fetched = true
      return htmlFetch('x')(...args)
    }
    const result = await executeHtmlWatchConnector(
      { ...SOURCE, url: 'https://cannamonitor.com/updates' },
      ['cannamonitor.com'],
      spy,
      OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('source_policy_denied')
    expect(fetched).toBe(false)
  })

  it('records a 403 as a failed run rather than as "nothing published"', async () => {
    // Three of the six Thai hosts answered 403 when measured on 2026-07-28, so
    // this is an expected steady state. It must be visible and attributable.
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('', { status: 403 }), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('fetch_failed')
    expect(result.reason).toContain('403')
  })

  it('refuses a feed served to an html-monitored source', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('<rss/>', { contentType: 'application/rss+xml' }), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid_content_type')
  })

  it('refuses an oversized declared length before reading the body', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('x', { contentLength: '99999999' }), OPTS)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('oversized_response')
  })

  it('refuses an empty document rather than fingerprinting nothing', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('   '), OPTS)
    expect(result.ok).toBe(false)
  })

  it('declares the same capability guarantees as the RSS connector', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('Cannabis rules.'), OPTS)
    expect(result.performsPersistence).toBe(false)
    expect(result.canCreateLegalUpdate).toBe(false)
    expect(result.canCreateRule).toBe(false)
    expect(result.canCallAI).toBe(false)
  })
})

describe('executeHtmlWatchConnector — how it describes itself', () => {
  it('titles the candidate as a page observation, not a legal finding', async () => {
    // This title is the first thing a reviewer reads in the Review Queue. It
    // must not assert that a law changed — only that a page did.
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('Cannabis rules.'), OPTS)
    const title = watchedItem(result).title ?? ''
    expect(title).toContain('watched page content changed')
    expect(title).not.toMatch(/law|regulation changed|new rule/i)
  })

  it('links the candidate back to the source page', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('Cannabis rules.'), OPTS)
    expect(watchedItem(result).link).toBe(SOURCE.url)
  })

  it('marks the feed kind as html', async () => {
    const result = await executeHtmlWatchConnector(SOURCE, [HOST], htmlFetch('Cannabis rules.'), OPTS)
    expect(result.feedKind).toBe('html')
  })
})
