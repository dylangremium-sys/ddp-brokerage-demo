import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildSitemapXml, sitemapEntries } from './sitemapDocument'
import {
  CANONICAL_ORIGIN,
  approvedSitemapUrls,
  canonicalUrlFor,
  indexablePages,
  isIndexable,
  metadataForPage,
} from './publicPageMetadata'
import { PUBLIC_CORPORATE_PAGES, isReachableWhileSignedOut } from './navigationGuard'
import { getInitialPageFromPath, pathForPage } from './urlRouting'
import type { Page } from '../types'

/**
 * The indexability register — the pure half. The DOM applier is exercised
 * separately in publicPageMetadata.dom.test.ts so this file stays in the
 * suite's default `environment: 'node'`.
 *
 * What these assertions are really protecting: a page becomes publicly
 * indexable through FOUR separate files agreeing — the register, the sitemap,
 * the router and the navigation guard. Any one of them silently disagreeing
 * produces a failure that looks like success from the outside: a URL in the
 * sitemap that renders the landing page, or a corporate page a signed-out
 * visitor is bounced away from. Nothing else in the repository compares them.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relativePath: string) => readFileSync(join(REPO_ROOT, relativePath), 'utf8')

/** Pages that must never be indexable, one per role surface. */
const OPERATIONAL_PAGES: Page[] = [
  'ddp-overview', 'ddp-master', 'ddp-compliance-watchtower', 'ddp-buyer-provisioning',
  'farmer-dashboard', 'farmer-my-stock', 'farmer-stock-form',
  'buyer-dashboard', 'login', 'set-password', 'forgot-password',
]

describe('the landing page keeps the metadata it already publishes', () => {
  it('has its expected title, description and canonical', () => {
    const meta = metadataForPage('landing')
    expect(meta.title).toBe('DDP Brokerage — Procurement Intelligence')
    expect(meta.canonicalPath).toBe('/')
    expect(meta.robots).toBe('index,follow')
    expect(canonicalUrlFor('landing')).toBe(`${CANONICAL_ORIGIN}/`)
  })

  /**
   * index.html's static description is what a crawler that does not execute
   * JavaScript reads. The register's landing entry is what restores that
   * description after a visitor navigates to /privacy and back. If the two
   * drift, the site tells one story to a plain fetch and another to a rendering
   * crawler — and neither would look broken in isolation.
   */
  it('matches the static description in index.html verbatim', () => {
    const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '')
    const staticDescription = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]*)"/is)?.[1]
    expect(staticDescription?.trim()).toBe(metadataForPage('landing').description)
  })
})

/**
 * PUBLIC_CORPORATE_PAGES means "a signed-out visitor may see this", which is
 * not the same as "a search engine may list it". Two members prove the
 * difference:
 *
 *   regulatory-hub is a real page that ships noindex until it has entries to
 *   list, because a hub listing nothing spends crawl attention on a promise.
 *
 *   regulatory-entry is not a URL at all — it is the member that says "render
 *   whichever entry the path names". Entries are files, one or two new ones a
 *   week, so they carry their own metadata rather than a register entry.
 *
 * Indexing assertions therefore run over what the REGISTER approves;
 * reachability assertions still run over every public page.
 */
const PUBLISHED_CORPORATE_PAGES = PUBLIC_CORPORATE_PAGES.filter(isIndexable)

describe('the corporate pages are approved for indexing', () => {
  it('separates published pages from merely-public ones', () => {
    expect(PUBLISHED_CORPORATE_PAGES.length).toBeGreaterThan(0)
    expect(PUBLIC_CORPORATE_PAGES).toContain('regulatory-hub')
    expect(PUBLISHED_CORPORATE_PAGES).not.toContain('regulatory-hub')
  })

  it.each(PUBLISHED_CORPORATE_PAGES)('%s is index,follow with its own canonical', (page) => {
    const meta = metadataForPage(page)
    expect(meta.robots).toBe('index,follow')
    expect(meta.canonicalPath).toBe(pathForPage(page))
    // Its own path, not "/" — a corporate page canonicalising to the landing
    // page would ask a search engine to drop it as a duplicate, which is the
    // opposite of publishing it.
    expect(meta.canonicalPath).not.toBe('/')
  })

  it.each(PUBLISHED_CORPORATE_PAGES)('%s has a title and a snippet-length description', (page) => {
    const meta = metadataForPage(page)
    expect(meta.title.trim().length).toBeGreaterThan(10)
    expect(meta.description.trim().length).toBeGreaterThan(40)
    // 160 characters is roughly what a result snippet shows; beyond that the
    // tail is written for nobody.
    expect(meta.description.length).toBeLessThanOrEqual(160)
  })

  it.each(PUBLISHED_CORPORATE_PAGES)('%s cold-loads on its own URL', (page) => {
    // The sitemap sends visitors straight to these paths with no in-app
    // navigation first. A path the router does not accept would render the
    // landing page to every one of them.
    expect(getInitialPageFromPath(pathForPage(page))).toBe(page)
  })

  it.each(PUBLIC_CORPORATE_PAGES)('%s is reachable by a signed-out visitor', (page) => {
    // An indexable page the navigation guard bounces to login is a page that
    // ranks and then shows a login screen to everyone who clicks the result.
    expect(isReachableWhileSignedOut(page)).toBe(true)
  })
})

describe('everything else is fail-closed', () => {
  it.each(OPERATIONAL_PAGES)('%s is noindex,nofollow', (page) => {
    expect(metadataForPage(page).robots).toBe('noindex,nofollow')
    expect(isIndexable(page)).toBe(false)
  })

  /**
   * /farmer is routable and marked noindex, and its canonical points at itself
   * rather than at "/" — canonicalising onboarding to the landing page would
   * ask a search engine to consolidate the two, the opposite of keeping them
   * apart.
   */
  it('keeps farmer onboarding routable but out of search', () => {
    const meta = metadataForPage('farmer-register')
    expect(meta.robots).toBe('noindex,nofollow')
    expect(meta.canonicalPath).toBe('/farmer')
  })

  /**
   * P0.4 — THE THREE CONDITIONS THAT MAKE THE EXCLUSION REACHABLE.
   *
   * The defect was that /farmer's exclusion could not be delivered: robots.txt
   * disallowed the path, so a compliant crawler never fetched the page and
   * never read the noindex on it. Two controls, stacked, and the weaker won.
   *
   * Containment now requires all three of these to hold together. Any one of
   * them alone is insufficient, and breaking any one reopens the hole, so they
   * are asserted as a set rather than as three unrelated facts:
   *
   *   1. the crawler is ALLOWED to fetch /farmer          (robots.txt)
   *   2. the response carries X-Robots-Tag: noindex       (vercel.json)
   *   3. the rendered page carries meta robots: noindex   (this register)
   *
   * The reason (2) is not redundant with (3): the SPA rewrite serves /farmer as
   * a client-rendered document, so (3) exists only after JavaScript runs, while
   * (2) is on the response itself.
   */
  it('makes the /farmer exclusion reachable: crawlable, header-excluded, meta-excluded', () => {
    const directives = read('public/robots.txt')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))

    // 1. Not disallowed — otherwise (2) and (3) are both unreachable.
    expect(
      directives.some((line) => /^Disallow:\s*\/farmer/i.test(line)),
      'robots.txt disallows /farmer again. That makes both the X-Robots-Tag header and the ' +
        'meta robots tag unreachable to every compliant crawler — the original defect.',
    ).toBe(false)

    // 2. The authoritative control, independent of JavaScript.
    const vercelConfig = JSON.parse(read('vercel.json')) as {
      headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    }
    const header = (vercelConfig.headers ?? [])
      .find((rule) => rule.source === '/farmer')
      ?.headers.find((entry) => entry.key.toLowerCase() === 'x-robots-tag')
    expect(header?.value.replace(/\s+/g, ''), 'no X-Robots-Tag: noindex on /farmer').toBe('noindex,nofollow')

    // 3. Defence in depth for anything reading the rendered DOM.
    expect(metadataForPage('farmer-register').robots).toBe('noindex,nofollow')

    // And crawlable must not have become indexable.
    expect(isIndexable('farmer-register')).toBe(false)
    expect(approvedSitemapUrls().some((url) => url.includes('/farmer'))).toBe(false)
  })

  /**
   * The structural property that makes an operational leak impossible rather
   * than merely absent: metadata is keyed by a Page enum member and read from a
   * static map. There is no parameter through which a farm name, a batch id or
   * a buyer's organisation could be passed in, so none can reach the document
   * head — where a crawler, the browser history and the referrer header would
   * all pick it up.
   */
  it('exposes no way to pass a title or description in', () => {
    const source = read('src/lib/publicPageMetadata.ts')
    const exportedFunctions = [...source.matchAll(/export function (\w+)\(([^)]*)\)/g)]
    expect(exportedFunctions.length).toBeGreaterThan(0)
    for (const [, name, params] of exportedFunctions) {
      expect(params, `${name}() must not accept free-text metadata`).not.toMatch(/title|description|content/i)
    }
  })

  it('carries no test or demo fixture values in any published string', () => {
    // The landing page's illustrative batch card is fixture data. If one of its
    // values ever reached a title or description it would be published as fact.
    const forbidden = [/purple gelato/i, /F4-122025/i, /\blorem\b/i, /localhost/i, /example\.com/i, /\bTODO\b/, /\bdemo\b/i]
    for (const page of indexablePages()) {
      const { title, description } = metadataForPage(page)
      for (const pattern of forbidden) {
        expect(`${title} ${description}`, `${page} publishes ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})

describe('the register and the sitemap are one decision', () => {
  // The sitemap is generated into dist/ at build time rather than kept in
  // public/, so this reads the builder that produces it. The decision it
  // encodes is unchanged: the register says which pages are public, and the
  // sitemap must say exactly that and nothing else.
  const sitemap = buildSitemapXml(sitemapEntries())
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())

  /**
   * Both directions matter and they fail differently. A register entry missing
   * from the sitemap is a page nobody is told about; a sitemap entry missing
   * from the register is a URL submitted to search engines that the application
   * marks noindex — a direct contradiction that Search Console reports as an
   * error against the whole sitemap.
   */
  it('publishes exactly the pages the register approves', () => {
    expect([...sitemapUrls].sort()).toEqual([...approvedSitemapUrls()].sort())
  })

  it('lists every URL on the canonical host, never the redirecting apex', () => {
    expect(sitemapUrls.filter((url) => !url.startsWith(`${CANONICAL_ORIGIN}/`))).toEqual([])
  })

  it('approves more than one page — the entry condition the programme waited on', () => {
    // The search-exposure programme was queued because the site had exactly one
    // indexable URL, which left its later phases with no subject matter. This
    // is the assertion that records the condition being met.
    expect(indexablePages().length).toBeGreaterThanOrEqual(2)
  })
})

describe('robots.txt agrees with the register', () => {
  const directives = read('public/robots.txt')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))

  it('does not disallow crawling of any page it approves for indexing', () => {
    // The self-inflicted wound: a page listed in the sitemap and blocked in
    // robots.txt cannot be read, so it is indexed — if at all — as a bare URL
    // with no description.
    const disallowed = directives
      .filter((line) => /^Disallow:/i.test(line))
      .map((line) => line.replace(/^Disallow:\s*/i, ''))

    for (const page of indexablePages()) {
      const path = pathForPage(page)
      const blocked = disallowed.filter((rule) => rule !== '' && path.startsWith(rule))
      expect(blocked, `${path} is approved for indexing but disallowed by ${blocked.join(', ')}`).toEqual([])
    }
  })
})
