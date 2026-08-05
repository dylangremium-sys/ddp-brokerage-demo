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
 *   - Only the farmer-register page is mapped for now. Further routes should be
 *     added here rather than scattered across App.tsx.
 */

import type { Page } from '../types'

/** pathname → Page mappings that accept a cold load. */
const PATH_TO_PAGE: Record<string, Page> = {
  '/farmer': 'farmer-register',
}

/** Page → canonical path. Pages not listed here revert to root. */
const PAGE_TO_PATH: Partial<Record<Page, string>> = {
  'farmer-register': '/farmer',
}

/**
 * Returns the Page that should be shown for `pathname` on a fresh load,
 * or null if the path has no special mapping (caller uses its own default).
 */
export function getInitialPageFromPath(pathname: string): Page | null {
  return PATH_TO_PAGE[pathname] ?? null
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
