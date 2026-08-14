import type { Page } from '../types'
import { PUBLIC_PAGES, resolveNavigationTarget, type NavigationContext } from './navigationGuard'
import { getInitialPageFromPath } from './urlRouting'

/**
 * Deep links that land on authenticated surface, resolved SAFELY.
 *
 * THE HOLE THIS CLOSES. A cold load and a Back/Forward press are the only two
 * ways into the app that do not pass through goTo(), and therefore not through
 * resolveNavigationTarget: App.tsx's useState initialiser and its popstate
 * handler both called setPage directly. That was safe only while every path in
 * PATH_TO_PAGE led to a PUBLIC page — a page the guard would admit for anyone —
 * and urlRouting.test.ts existed to fail the moment someone added an admin or
 * farmer route to the map.
 *
 * Someone did: fifteen console addresses. The test failed, the addresses came
 * back out, and this file is what makes them possible.
 *
 * WHY THE COLD LOAD CANNOT SIMPLY CALL THE GUARD. At the instant the useState
 * initialiser runs, identity is unknown — `currentProfile` is null and
 * `authLoading` is true, because the session is restored asynchronously. Passing
 * the requested page to the guard right there would resolve EVERY deep link for
 * a signed-in admin as though they were signed out, and bounce them to /login
 * milliseconds before their own session arrived. The bypass was not laziness; it
 * was avoiding that.
 *
 * So the intent is HELD rather than honoured or discarded, and replayed through
 * the guard once identity is known. Three outcomes, all of them the guard's
 * decision and none of them this file's:
 *
 *   public page      → honoured immediately, exactly as before
 *   demo mode        → honoured immediately; demo has no identity to wait for,
 *                      and the guard admits everything in it anyway
 *   anything else    → held, and replayed on the first auth resolution
 *
 * WHAT A SIGNED-OUT VISITOR ACTUALLY GETS, measured against production rather
 * than inferred from this file: the PUBLIC LANDING PAGE, not 'login'.
 *
 * consumeDeepLinkIntent resolves to 'login' for a stranger and the unit test
 * says so — but App.tsx only calls it inside the bootstrap block's
 * `action.kind === 'route'` branch, and there is nothing to route a signed-out
 * visitor to. So the intent is never consumed, the visitor stays on the public
 * page decideColdLoad already put them on, and nothing about the console is
 * rendered or hinted at.
 *
 * That is the safer of the two outcomes and it is being kept deliberately:
 * bouncing a stranger to /login would confirm that /console/* means something.
 * The held intent also survives, so if that visitor then signs in as an admin
 * the bootstrap route fires and takes them to the screen they originally
 * bookmarked. Documented here because "signed-out visitors get login" is what
 * the PR for this change said, and it is not what the product does.
 *
 * The holding place is module scope, mirroring lib/authRedirect.ts, for the same
 * reason: it must survive a render and be readable from code that runs outside
 * one, and it must not be a piece of state whose staleness could be captured in
 * a closure.
 */

/** The page a deep link asked for, if it could not be honoured on arrival. */
let heldIntent: Page | null = null

/**
 * What a cold load should do with the current pathname.
 *
 * PURE, and exported for the test that matters: for every path in the routing
 * map, either the page returned is one the guard would admit for any visitor, or
 * it is held. There is no third case, and asserting that is much stronger than
 * asserting that the map only contains public pages — which is what the old
 * invariant said, and what stopped the console having addresses at all.
 */
export function decideColdLoad(
  pathname: string,
  opts: { isDemo: boolean },
): { page: Page; held: Page | null } {
  const mapped = getInitialPageFromPath(pathname)
  if (!mapped) return { page: 'landing', held: null }

  // A public page is admitted for anyone, so there is nothing to wait for.
  if (PUBLIC_PAGES.includes(mapped)) return { page: mapped, held: null }

  // Demo mode has no identity to resolve and the guard admits everything in it.
  // Honouring immediately is what makes /console/* usable in a demo build.
  if (opts.isDemo) return { page: mapped, held: null }

  // Authenticated surface, identity unknown. Hold it: landing is public, so the
  // visitor waits on a page the guard would have given them anyway.
  return { page: 'landing', held: mapped }
}

/** Record an intent that could not be honoured on arrival. */
export function holdDeepLinkIntent(page: Page | null): void {
  heldIntent = page
}

/**
 * Take the held intent and resolve it against the identity that has now
 * arrived. Returns null when there was nothing held, or when the guard sends
 * the visitor exactly where they already are.
 *
 * CONSUMED, not peeked: a deep link is honoured at most once. Leaving it in
 * place would re-route the operator on every later auth event — a token
 * refresh, a StrictMode double-init — dragging them back off whatever screen
 * they had since navigated to. That is the same defect `didBootstrapRoute`
 * exists to prevent, and it would be reintroduced here.
 */
export function consumeDeepLinkIntent(ctx: NavigationContext, currentPage: Page): Page | null {
  const held = heldIntent
  heldIntent = null
  if (!held) return null
  const target = resolveNavigationTarget(held, ctx)
  return target === currentPage ? null : target
}

/** Whether an intent is waiting. For tests and for assertions at call sites. */
export function hasHeldDeepLinkIntent(): boolean {
  return heldIntent !== null
}

/** Test seam — module state must not leak between cases. */
export function __resetDeepLinkIntent(): void {
  heldIntent = null
}
