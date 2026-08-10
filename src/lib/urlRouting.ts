/**
 * URL ↔ Page mapping for deep-linkable routes.
 *
 * WHY THIS EXISTS
 *   The app uses in-memory state routing (Page enum in types.ts) rather than a
 *   URL router. That is intentional — the routing logic is pure and testable
 *   without a DOM. But it means every page is normally reached only through
 *   in-app navigation, so a fresh load always renders the landing page.
 *
 *   Farmers share links via WhatsApp and QR codes. A short, memorable URL
 *   (/farmer) that survives a copy-paste or scan must work on a cold load.
 *   This module is the one place that maps path ↔ page for the small set of
 *   routes that need deep-linking.
 *
 * CONTRACT
 *   - getInitialPageFromPath returns the Page for the given pathname (or null
 *     if the path maps to no special page, in which case the caller uses its
 *     normal default).
 *   - syncUrlToPage is called after every page transition. It either pushes or
 *     replaces the history entry so the address bar stays consistent. Navigating
 *     to a page with no URL mapping replaces with "/".
 *   - The mapped set is farmer-register plus the public corporate pages.
 *     Further routes should be added here rather than scattered across App.tsx.
 *
 * RELATIONSHIP TO SEARCH EXPOSURE
 *   A path in PAGE_TO_PATH is a URL a crawler can be pointed at, so this map
 *   and the indexability register in lib/publicPageMetadata.ts have to agree.
 *   They are deliberately separate concerns — routable is not the same as
 *   indexable, and /farmer is the case that proves it: it is routable, and it
 *   is disallowed in robots.txt and marked noindex. publicPageMetadata.test.ts
 *   asserts the two stay consistent.
 */

import type { Page } from '../types'

/** pathname → Page mappings that accept a cold load. */
const PATH_TO_PAGE: Record<string, Page> = {
  '/farmer': 'farmer-register',
  // The public corporate pages. Unlike /farmer these exist FOR the cold load:
  // a search result, a link in someone's email, and the sitemap all deliver a
  // visitor straight to the path with no in-app navigation beforehand. A
  // corporate page that only worked via an in-app click would be listed in the
  // sitemap and then render the landing page to everyone who arrived — the
  // failure would look like success in exactly the way the crawl-policy files
  // did before they were made static.
  // The German buyer page. Its whole purpose is the cold load: a German buyer
  // arrives from a search result, never from an in-app click.
  '/de': 'de-buyer',
  '/cs': 'cs-buyer',
  '/th/suppliers': 'th-supplier',
  '/regulatory-updates': 'regulatory-hub',
  '/about': 'about',
  '/contact': 'contact',
  '/privacy': 'privacy',
  '/terms': 'terms',
}

/** Page → canonical path. Pages not listed here revert to root. */
const PAGE_TO_PATH: Partial<Record<Page, string>> = {
  'farmer-register': '/farmer',
  'de-buyer': '/de',
  'cs-buyer': '/cs',
  'th-supplier': '/th/suppliers',
  'regulatory-hub': '/regulatory-updates',
  about: '/about',
  contact: '/contact',
  privacy: '/privacy',
  terms: '/terms',
}

/**
 * Normalises a pathname before it is looked up.
 *
 * WHY A TRAILING SLASH HAS TO BE ACCEPTED
 *   `/about` and `/about/` are the same page to every human who types one, but
 *   they were not the same key in the map above, so `/about/` fell through to
 *   null and cold-loaded the landing page instead.
 *
 *   That was survivable while every path was served the same empty shell. It
 *   stopped being survivable when the public routes gained prerendered
 *   documents: `/about/` is served `about/index.html` — real About markup, with
 *   the About title and the About canonical — and the app would then have
 *   replaced it with the landing page and rewritten the address bar to "/".
 *   A visitor would watch the right page turn into the wrong one, and a crawler
 *   that renders would record the disagreement.
 *
 *   Root is left alone: "/" IS the trailing slash, and stripping it would make
 *   the pathname empty.
 */
function normalisePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

/**
 * Returns the Page that should be shown for `pathname` on a fresh load,
 * or null if the path has no special mapping (caller uses its own default).
 */
export function getInitialPageFromPath(pathname: string): Page | null {
  const path = normalisePath(pathname)
  const mapped = PATH_TO_PAGE[path]
  if (mapped) return mapped

  // Published entries are files, not enum members — one or two new ones a week,
  // so they cannot be listed above. A single segment under the hub resolves to
  // 'regulatory-entry', and the renderer asks entryForPath which entry it is.
  //
  // This deliberately matches slugs that may not exist. An unknown one renders
  // the entry page's own "not found" rather than the landing page, which is the
  // honest answer — and vercel.json keeps /regulatory-updates/ out of the SPA
  // rewrite, so a wrong URL gets a real 404 before it ever reaches the app.
  if (/^\/regulatory-updates\/[^/]+$/.test(path)) return 'regulatory-entry'

  return null
}

/**
 * The canonical path for `page`, for use as a real `href`.
 *
 * Exists so that a component rendering an in-app link cannot invent a path.
 * The corporate pages are linked with genuine anchors — a crawler follows an
 * `href`, and a `<button>` is invisible to one — and this is what guarantees
 * the href a visitor sees is the same path the router will accept on a cold
 * load. Unmapped pages fall back to "/", matching syncUrlToPage.
 */
export function pathForPage(page: Page): string {
  return PAGE_TO_PATH[page] ?? '/'
}

/**
 * Keeps the address bar in sync with the in-memory `page` value.
 *
 * - Pushes a new history entry only when entering a deep-linked page so the
 *   browser Back button works (e.g. QR scan → register → Back → landing).
 * - Replaces with "/" when leaving a mapped page, so the landing page is not
 *   stacked twice in the history.
 */
export function syncUrlToPage(page: Page): void {
  if (typeof window === 'undefined') return
  const targetPath = PAGE_TO_PATH[page] ?? '/'
  const currentPath = window.location.pathname
  if (currentPath === targetPath) return

  // Use push (not replace) when entering a mapped deep-link so Back works.
  if (PAGE_TO_PATH[page]) {
    window.history.pushState(null, '', targetPath)
  } else {
    // Leaving a mapped page: replace so "/" does not pile up.
    window.history.replaceState(null, '', targetPath)
  }
}
