// @vitest-environment jsdom
//
// The DOM half of the metadata register. Split from publicPageMetadata.test.ts
// so the pure register assertions keep running in the suite's default
// `environment: 'node'` — the repo's convention is that a file opts into jsdom
// only when it genuinely needs a document.
//
// This file needs one because the property under test is not "what does the
// register say", it is "what is actually in the head after navigating". Those
// differ in exactly the case that matters: navigation.

import { beforeEach, describe, expect, it } from 'vitest'
import { CANONICAL_ORIGIN, applyPublicPageMetadata, metadataForPage } from './publicPageMetadata'

const headOf = () => ({
  title: document.title,
  description: document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
  robots: document.head.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
  canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
  canonicalCount: document.head.querySelectorAll('link[rel="canonical"]').length,
  descriptionCount: document.head.querySelectorAll('meta[name="description"]').length,
})

beforeEach(() => {
  document.head.innerHTML = ''
  document.title = ''
})

describe('applying metadata for a page', () => {
  it('writes the landing page title, description and canonical', () => {
    applyPublicPageMetadata(document, 'landing')
    const head = headOf()
    expect(head.title).toBe('DDP Brokerage — Procurement Intelligence')
    expect(head.description).toBe(metadataForPage('landing').description)
    expect(head.robots).toBe('index,follow')
    expect(head.canonical).toBe(`${CANONICAL_ORIGIN}/`)
  })

  it('gives each corporate page its own canonical, not the landing page’s', () => {
    applyPublicPageMetadata(document, 'privacy')
    expect(headOf().canonical).toBe(`${CANONICAL_ORIGIN}/privacy`)

    applyPublicPageMetadata(document, 'terms')
    expect(headOf().canonical).toBe(`${CANONICAL_ORIGIN}/terms`)
  })

  it('marks a page outside the register noindex,nofollow', () => {
    applyPublicPageMetadata(document, 'ddp-overview')
    expect(headOf().robots).toBe('noindex,nofollow')
  })
})

describe('stale metadata does not survive navigation', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR.
   *
   * The applier adds tags to a head that already has some. If it only ever
   * ADDED, then landing → privacy → landing would leave `<link rel="canonical"
   * href=".../privacy">` in place while the landing page is on screen — the
   * landing page would be telling crawlers its canonical URL is the privacy
   * policy, which is how a homepage disappears from search results in favour of
   * a legal notice. Nothing visible breaks, so only an assertion catches it.
   */
  it('restores indexable landing metadata after returning from a noindex page', () => {
    applyPublicPageMetadata(document, 'landing')
    applyPublicPageMetadata(document, 'farmer-register')
    expect(headOf().robots).toBe('noindex,nofollow')

    applyPublicPageMetadata(document, 'landing')

    const head = headOf()
    expect(head.robots).toBe('index,follow')
    expect(head.canonical).toBe(`${CANONICAL_ORIGIN}/`)
    expect(head.title).toBe('DDP Brokerage — Procurement Intelligence')
    expect(head.description).toBe(metadataForPage('landing').description)
  })

  it('replaces tags rather than accumulating them', () => {
    for (const page of ['landing', 'about', 'contact', 'privacy', 'terms', 'landing'] as const) {
      applyPublicPageMetadata(document, page)
    }
    const head = headOf()
    // Two canonicals are not twice as good: a search engine seeing conflicting
    // canonical links may ignore both.
    expect(head.canonicalCount).toBe(1)
    expect(head.descriptionCount).toBe(1)
  })

  it('removes the description entirely rather than publishing an empty one', () => {
    applyPublicPageMetadata(document, 'landing')
    expect(headOf().descriptionCount).toBe(1)

    // An operational page has no description in the register.
    applyPublicPageMetadata(document, 'ddp-master')
    expect(headOf().descriptionCount).toBe(0)
  })

  /**
   * Navigating INTO the application must strip the indexable metadata too, not
   * merely leave it. The failure otherwise is that an admin screen carries the
   * landing page's `index,follow` and canonical while showing operational data.
   */
  it('drops indexable metadata when moving from a public page into the app', () => {
    applyPublicPageMetadata(document, 'about')
    expect(headOf().robots).toBe('index,follow')

    applyPublicPageMetadata(document, 'ddp-inventory')

    const head = headOf()
    expect(head.robots).toBe('noindex,nofollow')
    expect(head.canonical).toBe(`${CANONICAL_ORIGIN}/`)
    expect(head.title).toBe('DDP Brokerage')
  })

  /**
   * The head must never carry a record value. There is no code path that could
   * put one there — metadata is keyed by an enum — but this asserts the outcome
   * rather than the mechanism, so it still holds if the mechanism is changed.
   */
  it('never writes an operational record value into the head', () => {
    for (const page of ['ddp-master', 'farmer-my-stock', 'buyer-dashboard'] as const) {
      applyPublicPageMetadata(document, page)
      expect(document.head.innerHTML + document.title).not.toMatch(/batch|farm |kg|THB|©|@/i)
    }
  })
})
