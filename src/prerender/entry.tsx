// ─── Build-time render entry ────────────────────────────────────────────────
//
// Renders the public pages to static markup so the SERVED document already
// contains them. See lib/prerenderDocument.ts for what was measured in
// production and why the fix takes this shape.
//
// WHY THIS RENDERS THE REAL COMPONENTS
//   The alternative — writing the corporate copy a second time into static
//   files — is the failure the About page's own header warns about: a second
//   copy drifts, and the drift is always in the direction of a stronger claim
//   than the landing page makes. These are the same components `main` already
//   ships, so the prerendered bytes cannot say anything the running app does
//   not. Every page here reads its words from translations.ts by key.
//
// WHY THESE COMPONENTS CAN BE RENDERED WITHOUT A BROWSER
//   All five are pure presentation: no useState, no useEffect, no Supabase and
//   no module-scope DOM access. The two places they touch browser globals —
//   LandingPage's scroll helpers and urlRouting's syncUrlToPage — are inside
//   click handlers, which never run during a render. The handlers passed below
//   are therefore no-ops that exist only to satisfy the prop types.
//
// WHY THE CLIENT STILL USES createRoot, NOT hydrateRoot
//   main.tsx keeps `createRoot`, which discards the prerendered markup and
//   renders fresh. That is deliberate. `initialLanguage` reads localStorage and
//   `navigator.languages`, so the language the client picks is not knowable at
//   build time — a Thai visitor would hydrate against English markup and get a
//   mismatch. Prerendering in English matches `<html lang="en">` and the single
//   English URL per page that sitemap.xml declares.
//
//   The cost is that a visitor whose browser resolves to Thai sees English for
//   the moment before React takes over. That is a real, if small, regression
//   for those visitors, and it is the price of the whole document existing for
//   every consumer that never runs JavaScript at all. Revisit it if and when
//   per-language URLs are introduced, which is what would make hydration safe.
//
// WHY /farmer IS PRERENDERED WITH NO BODY
//   Two reasons, and the first is the load-bearing one.
//
//   Once `dist/index.html` carries landing markup and a canonical of `/`, every
//   path the SPA rewrite still serves inherits both — and before this file
//   existed, `/farmer` was one of them. It would have been handed landing-page
//   content under a canonical pointing at `/`, which is precisely what the
//   register refuses: "canonicalising onboarding to the landing page would ask
//   a search engine to consolidate them, which is the opposite of keeping them
//   apart." Giving /farmer its own document keeps its own canonical on it.
//
//   Second, it puts `noindex,nofollow` into the served bytes. That tag was the
//   third of the three controls guarding /farmer and the only one that needed
//   JavaScript to appear; it no longer does. The X-Robots-Tag header in
//   vercel.json remains authoritative and is unchanged.
//
//   The body is left empty on purpose: the registration flow is a stateful,
//   authenticated-adjacent surface, and it is excluded from search anyway, so
//   there is nothing to gain from rendering it at build time and a real risk in
//   pretending it is pure.

import { renderToStaticMarkup } from 'react-dom/server'
import type { Page } from '../types'
import LandingPage from '../pages/public/LandingPage'
import AboutPage from '../pages/public/AboutPage'
import GovernancePage from '../pages/public/GovernancePage'
import ContactPage from '../pages/public/ContactPage'
import PrivacyPage from '../pages/public/PrivacyPage'
import TermsPage from '../pages/public/TermsPage'
import LocalisedBuyerPage from '../pages/public/LocalisedBuyerPage'
import ThaiSupplierPage from '../pages/public/ThaiSupplierPage'
import { RegulatoryHubPage, RegulatoryEntryPage } from '../pages/public/RegulatoryUpdatesPage'
import { regulatoryEntries } from '../content/regulatoryEntries'
import { articleStructuredData, buildRssFeed } from '../content/rssFeed'

// Re-exported so scripts/prerender-public-routes.mjs has exactly one module to
// load. The document builder and the path rule are TypeScript that only the
// bundler compiles; a plain .mjs script cannot import them directly, and giving
// it a second loader would be a second way for the two halves to disagree.
export { buildPrerenderedDocument, outputPathFor, targetForPage } from '../lib/prerenderDocument'
import type { PrerenderTarget } from '../lib/prerenderDocument'
export { buildSitemapXml, sitemapEntries } from '../lib/sitemapDocument'
export { indexablePages } from '../lib/publicPageMetadata'

/**
 * The language the prerendered bytes are written in.
 *
 * Matches `<html lang="en">` in index.html and the one URL per page that
 * sitemap.xml publishes. Not a preference — a statement of what the static
 * document claims to be.
 */
const PRERENDER_LANG = 'en' as const

/** Where the feed is served from. Referenced by the hub and by every entry. */
export const FEED_PATH = '/regulatory-updates/feed.xml'
const FEED_URL = `https://www.ddpbrokerage.com${FEED_PATH}`

/** The feed itself, built from the same entries as the pages and the sitemap. */
export function renderRegulatoryFeed(): string {
  return buildRssFeed(regulatoryEntries(), {
    title: 'DDP Brokerage — Regulatory updates',
    description:
      'Notes on regulatory developments affecting licensed cannabis supply. Each entry carries the date it was last verified and the reviewer responsible.',
    link: 'https://www.ddpbrokerage.com/regulatory-updates',
    feedUrl: FEED_URL,
  })
}

/** Prop stubs. Nothing below is invoked during a render. */
const noop = () => {}

/** A route whose metadata comes from content rather than the register. */
export interface ContentRoute {
  /** For build output only. */
  label: string
  target: PrerenderTarget
  bodyHtml: string
}

export interface PrerenderedRoute {
  /**
   * The registered page this route renders.
   *
   * Content-derived routes (regulatory updates) will carry a target rather than
   * a Page — see PrerenderTarget in lib/prerenderDocument.ts. `page` stays on
   * this interface for the routes that legitimately have an enum member.
   */
  page: Page
  /** Static markup for `<div id="root">`, or '' for a head-only document. */
  bodyHtml: string
  /** An RSS feed this page is the human view of, if one exists. */
  feedUrl?: string
}

/**
 * Every route that gets a file of its own, in sitemap order followed by the
 * head-only exclusion.
 *
 * The five indexable entries are the register's `index,follow` set. If a page
 * is added to the register and the sitemap without being added here, it will
 * fall through to the SPA rewrite and be served the landing document under the
 * landing canonical — so prerenderRoutes.test.ts asserts this list and
 * `indexablePages()` agree.
 */
export function renderPublicRoutes(): PrerenderedRoute[] {
  const lang = PRERENDER_LANG

  return [
    {
      page: 'landing',
      bodyHtml: renderToStaticMarkup(
        <LandingPage
          lang={lang}
          setLang={noop}
          onSecureLogin={noop}
          onSupplierSignup={noop}
          onNavigate={noop}
        />,
      ),
    },
    {
      page: 'governance',
      bodyHtml: renderToStaticMarkup(<GovernancePage lang={lang} setLang={noop} onNavigate={noop} />),
    },
    {
      page: 'about',
      bodyHtml: renderToStaticMarkup(<AboutPage lang={lang} setLang={noop} onNavigate={noop} />),
    },
    {
      page: 'contact',
      bodyHtml: renderToStaticMarkup(<ContactPage lang={lang} setLang={noop} onNavigate={noop} />),
    },
    {
      page: 'privacy',
      bodyHtml: renderToStaticMarkup(<PrivacyPage lang={lang} setLang={noop} onNavigate={noop} />),
    },
    {
      page: 'terms',
      bodyHtml: renderToStaticMarkup(<TermsPage lang={lang} setLang={noop} onNavigate={noop} />),
    },
    {
      page: 'de-buyer',
      bodyHtml: renderToStaticMarkup(<LocalisedBuyerPage page="de-buyer" onNavigate={noop} />),
    },
    {
      page: 'cs-buyer',
      bodyHtml: renderToStaticMarkup(<LocalisedBuyerPage page="cs-buyer" onNavigate={noop} />),
    },
    // Prerendered although noindex: it is shared directly with producers, and
    // the served bytes are what a link preview reads.
    {
      page: 'th-supplier',
      bodyHtml: renderToStaticMarkup(<ThaiSupplierPage onNavigate={noop} />),
    },
    {
      page: 'regulatory-hub',
      bodyHtml: renderToStaticMarkup(<RegulatoryHubPage onNavigate={noop} />),
      // The hub is the human view of the feed, so it advertises it. A reader
      // subscribing from a feed-reader browser extension finds it here.
      feedUrl: FEED_PATH,
    },
    // Head-only. See the /farmer note in this file's header.
    { page: 'farmer-register', bodyHtml: '' },
  ]
}

/**
 * One route per published entry.
 *
 * These carry a TARGET rather than a Page: there is no enum member per entry,
 * which is the whole reason buildPrerenderedDocument was decoupled from the
 * register. The metadata is built from the entry's own frontmatter, so
 * publishing is adding a file — not editing a route map.
 */
export function renderRegulatoryEntryRoutes(): ContentRoute[] {
  return regulatoryEntries().map((entry) => ({
    label: entry.canonicalPath,
    target: {
      metadata: {
        title: entry.title,
        description: entry.description,
        canonicalPath: entry.canonicalPath,
        robots: 'index,follow' as const,
        lastReviewed: entry.lastVerified,
      },
      alternates: [],
      // Describes the document, never the company. See rssFeed.ts.
      structuredData: articleStructuredData(entry),
      feedUrl: FEED_URL,
    },
    bodyHtml: renderToStaticMarkup(<RegulatoryEntryPage entry={entry} onNavigate={noop} />),
  }))
}
