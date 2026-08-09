import { describe, expect, it } from 'vitest'

import { renderPublicRoutes } from '../prerender/entry'
import { indexablePages, isIndexable, metadataForPage } from './publicPageMetadata'
import { getInitialPageFromPath, pathForPage } from './urlRouting'
import { PUBLIC_PAGES } from './navigationGuard'
import { DRAFTED, NEEDS_NATIVE_REVIEW, PENDING_SECTIONS } from '../pages/public/thaiSupplierCopy'
import { T } from '../translations'

/**
 * /th/suppliers is the acquisition-side page: supply is the commercial focus,
 * and this is the only page that speaks to it in the language of the people who
 * supply. It matters more than /de or /cs.
 *
 * It is also the page whose Thai will be judged hardest, by licensed operators
 * and their compliance staff. So the tests here are about PROVENANCE as much as
 * content: the sentences that bound what the company claims must be the
 * human-written Thai that already existed, not anything drafted for this page.
 */

const body = () => renderPublicRoutes().find((r) => r.page === 'th-supplier')!.bodyHtml

describe('the page carries the existing Thai, not a retyped version of it', () => {
  it('is rendered at all', () => {
    expect(body().length).toBeGreaterThan(800)
  })

  /**
   * THE ASSERTION THAT MATTERS MOST.
   *
   * Both legal notices must be the exact human-written Thai from
   * translations.ts. If either were retyped or re-translated it could drift
   * into a weaker statement than the company makes in English and Thai
   * elsewhere — and on this page, drift would be toward promising a Thai
   * producer something DDP has not promised.
   */
  it('uses the exact existing Thai for both legal notices', () => {
    expect(body()).toContain(T.th.landingAuthorityNote)
    expect(body()).toContain(T.th.landingDisclaimer)
  })

  it('uses the exact existing Thai for the four process steps', () => {
    for (const key of [
      'homeProcessStep1Desc', 'homeProcessStep2Desc',
      'homeProcessStep3Desc', 'homeProcessStep4Desc',
    ] as const) {
      expect(body()).toContain(T.th[key])
    }
  })

  /**
   * The "after you apply" section now publishes the SEQUENCE rather than the
   * old single sentence — a producer wants to know what happens, and the
   * sequence says it without inventing a duration. The admin-only note is
   * still the existing human Thai, unchanged.
   */
  it('publishes the sequence, and keeps the existing Thai admin note', () => {
    expect(body()).toContain(T.th.farmerRegAdminOnlyNote)
    for (const step of ['step1', 'step2', 'step3', 'step4'] as const) {
      expect(body()).toContain(DRAFTED[step])
    }
  })

  /**
   * The claim sentence and the product forms are REUSED from the homepage
   * supplier block rather than translated twice, so the two pages cannot drift
   * apart on what the company says it is buying.
   */
  it('reuses the homepage supplier claim rather than restating it', () => {
    expect(body()).toContain(T.th.landingSupplierDemand)
    expect(body()).toContain(T.th.landingSupplierForms)
    expect(body()).toContain(T.th.landingSupplierSend)
  })

  it('links to the application form with a real href a crawler can follow', () => {
    expect(body()).toContain(`<a href="${pathForPage('farmer-register')}"`)
  })

  it('has exactly one heading', () => {
    expect(body().match(/<h1[\s>]/g) ?? []).toHaveLength(1)
  })

  /** Same bar as /de and /cs: no certification, approval or partnership. */
  it('claims nothing about DDP that the English site does not', () => {
    for (const forbidden of ['ได้รับการรับรองจาก', 'ได้รับอนุญาตจาก', 'รับประกัน', 'GMP']) {
      expect(body(), `"${forbidden}" is an unreviewed claim`).not.toContain(forbidden)
    }
  })
})

describe('the drafted Thai is declared, not hidden', () => {
  /**
   * The machine-drafted strings are listed with the English they came from so a
   * Thai reviewer can check them without reading the code. A drafted string
   * that is not on the list is a string nobody knows to review.
   */
  it('lists every drafted string with the English it came from', () => {
    expect(NEEDS_NATIVE_REVIEW.length).toBeGreaterThan(0)

    for (const entry of NEEDS_NATIVE_REVIEW) {
      expect(entry.en.length, `${entry.key} has no English source`).toBeGreaterThan(3)
      expect(entry.th.length, `${entry.key} has no Thai`).toBeGreaterThan(1)
      expect(entry.th, `${entry.key} is not Thai`).toMatch(/[ก-๙]/)
    }
  })

  it('renders every drafted string it declares, so the list is not stale', () => {
    for (const { key, th } of NEEDS_NATIVE_REVIEW) {
      expect(body(), `${key} is declared for review but not on the page`).toContain(th)
    }
  })

  /**
   * The technical requirements come from the brief and are the substance of the
   * page. They are asserted individually because dropping one silently would
   * mean telling a producer they need less documentation than they do.
   */
  it('states the documentation requirements the brief specifies', () => {
    const html = body()
    expect(html).toContain('ISO/IEC 17025')
    expect(html).toContain('0.877')
    expect(html).toContain('THCA')
    expect(html).toContain('COA')
  })

  /**
   * The 0.877 factor is the whole point of that line: a COA reporting delta-9
   * alone understates total THC and is the most common way a batch looks
   * compliant when it is not. If the line ever loses the distinction it stops
   * being a requirement and becomes decoration.
   */
  it('keeps the distinction between total THC and delta-9 alone', () => {
    expect(body()).toMatch(/เดลตา-9|delta-9/i)
  })
})

describe('missing sections are absent, not stubbed', () => {
  it('records what is still pending and why', () => {
    expect(PENDING_SECTIONS.length).toBeGreaterThan(0)
    for (const entry of PENDING_SECTIONS) {
      expect(entry.why.length, `${entry.section} has no reason recorded`).toBeGreaterThan(30)
    }
  })

  /**
   * No placeholder reaches a visitor. A supplier reading "coming soon" on a
   * page about documentation requirements learns something worse than nothing
   * about whether this company is serious.
   */
  it('renders no placeholder text for a pending section', () => {
    const html = body()
    for (const marker of ['TODO', 'TBD', 'coming soon', 'เร็ว ๆ นี้', 'placeholder', 'Lorem']) {
      expect(html, `"${marker}" is on the page`).not.toContain(marker)
    }
  })
})

describe('it is reachable, and deliberately not yet indexed', () => {
  it('cold-loads from its own path, trailing slash or not', () => {
    expect(getInitialPageFromPath('/th/suppliers')).toBe('th-supplier')
    expect(getInitialPageFromPath('/th/suppliers/')).toBe('th-supplier')
  })

  it('is public, so the guard admits a signed-out visitor', () => {
    expect(PUBLIC_PAGES).toContain('th-supplier')
  })

  it('declares Thai as its document language', () => {
    expect(metadataForPage('th-supplier').lang).toBe('th')
  })

  /**
   * noindex until a Thai speaker has read the drafted strings and the pending
   * sections have cleared wording. Publishing early spends the one first
   * impression this audience gives.
   *
   * When it is ready this test is the thing that has to change, deliberately,
   * alongside the register and the hand-written URL list.
   */
  it('is NOT yet indexable, and therefore not in the sitemap', () => {
    expect(metadataForPage('th-supplier').robots).toBe('noindex,nofollow')
    expect(isIndexable('th-supplier')).toBe(false)
    expect(indexablePages()).not.toContain('th-supplier')
  })

  /** Prerendered regardless, because it is shared directly with producers. */
  it('is prerendered anyway, so a shared link previews properly', () => {
    expect(body().length).toBeGreaterThan(800)
  })
})
