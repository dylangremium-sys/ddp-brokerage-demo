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
import ContactPage from '../pages/public/ContactPage'
import PrivacyPage from '../pages/public/PrivacyPage'
import TermsPage from '../pages/public/TermsPage'

// Re-exported so scripts/prerender-public-routes.mjs has exactly one module to
// load. The document builder and the path rule are TypeScript that only the
// bundler compiles; a plain .mjs script cannot import them directly, and giving
// it a second loader would be a second way for the two halves to disagree.
export { buildPrerenderedDocument, outputPathForPage } from '../lib/prerenderDocument'

/**
 * The language the prerendered bytes are written in.
 *
 * Matches `<html lang="en">` in index.html and the one URL per page that
 * sitemap.xml publishes. Not a preference — a statement of what the static
 * document claims to be.
 */
const PRERENDER_LANG = 'en' as const

/** Prop stubs. Nothing below is invoked during a render. */
const noop = () => {}

export interface PrerenderedRoute {
  page: Page
  /** Static markup for `<div id="root">`, or '' for a head-only document. */
  bodyHtml: string
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
    // Head-only. See the /farmer note in this file's header.
    { page: 'farmer-register', bodyHtml: '' },
  ]
}
