import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetDeepLinkIntent,
  consumeDeepLinkIntent,
  decideColdLoad,
  hasHeldDeepLinkIntent,
  holdDeepLinkIntent,
} from './deepLinkIntent'

/**
 * The two halves of a guarded deep link.
 *
 * decideColdLoad decides what a cold load may honour immediately; urlRouting's
 * suite drives that across every mapped path. This file covers the other half —
 * what happens to a HELD intent once identity arrives — because that is where a
 * mistake is invisible: the wrong answer here does not throw, it silently sends
 * somebody somewhere they should not be, or strands them on the landing page
 * wondering why their bookmark stopped working.
 */
describe('a deep link held until identity resolves', () => {
  beforeEach(__resetDeepLinkIntent)

  const admin = { isDemo: false, isSignedIn: true, isAdminRole: true }
  const farmer = { isDemo: false, isSignedIn: true, isAdminRole: false }
  const strangerCtx = { isDemo: false, isSignedIn: false, isAdminRole: false }

  it('sends a signed-out visitor to login, not to the console screen they asked for', () => {
    holdDeepLinkIntent('ddp-overview')
    expect(consumeDeepLinkIntent(strangerCtx, 'landing')).toBe('login')
  })

  it('gives an admin the screen they bookmarked', () => {
    holdDeepLinkIntent('ddp-document-review')
    expect(consumeDeepLinkIntent(admin, 'ddp-overview')).toBe('ddp-document-review')
  })

  /**
   * A FARMER IS NOT TURNED AWAY HERE, AND THAT IS THE GUARD'S EXISTING SHAPE
   * rather than anything this file introduced.
   *
   * resolveNavigationTarget steers an ADMIN away from farmer pages
   * (FARMER_PAGES → 'ddp-overview') and has no converse rule, so a signed-in
   * farmer asking for an admin page is returned it. What stops them is the
   * render: `DDP_PAGES.includes(page) && !isAdminRole` paints AccessDenied, and
   * RLS refuses the reads behind it.
   *
   * That is exactly what a farmer already gets by clicking through in-app —
   * goTo() runs the same guard — so a deep link is no weaker than the app's own
   * navigation. Asserted as it behaves, not as I first assumed it behaved, and
   * flagged for the owner: the asymmetry is defensible but it is not obvious,
   * and a reader could easily take "routed through the guard" to mean more than
   * it does.
   */
  it('leaves a farmer to be stopped by AccessDenied, as in-app navigation does', () => {
    holdDeepLinkIntent('ddp-master')
    expect(consumeDeepLinkIntent(farmer, 'farmer-status')).toBe('ddp-master')
  })

  it('turns a signed-out visitor away from every console page', () => {
    for (const page of ['ddp-overview', 'ddp-master', 'ddp-document-review'] as const) {
      __resetDeepLinkIntent()
      holdDeepLinkIntent(page)
      expect(consumeDeepLinkIntent(strangerCtx, 'landing')).toBe('login')
    }
  })

  /**
   * The intent is consumed, not peeked. Left in place it would re-fire on every
   * later auth event — a token refresh, StrictMode's duplicate init — dragging
   * the operator back to the URL they arrived on, off whatever screen they had
   * since navigated to. That is the defect didBootstrapRoute already exists to
   * prevent, and this would have reintroduced it by another door.
   */
  it('fires once and once only', () => {
    holdDeepLinkIntent('ddp-overview')
    expect(consumeDeepLinkIntent(admin, 'landing')).toBe('ddp-overview')
    expect(hasHeldDeepLinkIntent()).toBe(false)
    expect(consumeDeepLinkIntent(admin, 'ddp-farms')).toBeNull()
  })

  it('returns null when the guard agrees with where the caller already is', () => {
    holdDeepLinkIntent('ddp-overview')
    expect(consumeDeepLinkIntent(admin, 'ddp-overview')).toBeNull()
  })

  it('holds nothing when nothing was held', () => {
    expect(consumeDeepLinkIntent(admin, 'landing')).toBeNull()
    expect(hasHeldDeepLinkIntent()).toBe(false)
  })

  it('a public deep link is never held in the first place', () => {
    const { page, held } = decideColdLoad('/governance', { isDemo: false })
    expect(page).toBe('governance')
    expect(held).toBeNull()
  })

  /**
   * Demo grants every role and has no session to wait for. Holding there would
   * strand the visitor: nothing ever resolves, so nothing ever replays.
   */
  it('honours a console path immediately in demo mode', () => {
    const { page, held } = decideColdLoad('/console/watchtower', { isDemo: true })
    expect(page).toBe('ddp-compliance-watchtower')
    expect(held).toBeNull()
  })

  it('holds a console path when identity is unknown, landing somewhere public', () => {
    const { page, held } = decideColdLoad('/console/watchtower', { isDemo: false })
    expect(page).toBe('landing')
    expect(held).toBe('ddp-compliance-watchtower')
  })
})
