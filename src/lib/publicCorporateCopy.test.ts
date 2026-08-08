import { describe, expect, it } from 'vitest'
import { T } from '../translations'

/**
 * Gate 5 of the search-exposure master plan, made executable.
 *
 * The rule: "Do not publish absolute claims unless documentary/legal authority
 * exists for the exact claim." The plan lists the phrases that require strong
 * evidence and explicit review before they may appear on a public page.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE
 *   The corporate pages are indexable, so a phrase added here is a claim the
 *   company publishes to the world and that search engines cache. The review
 *   that caught this class of wording once already — the landing page's
 *   "Buyer-Readiness Platform", reworded because standalone "readiness" reads
 *   as a certification claim about the supply itself — was a human reading the
 *   copy. A human reads the copy once; this reads it on every commit.
 *
 * SCOPE
 *   The `corp*` keys: the copy authored for /about, /contact, /privacy and
 *   /terms. The pre-existing landing keys these pages REUSE are deliberately
 *   out of scope, and they have to be: `landingAuthorityNote` contains several
 *   of the banned phrases precisely because it NEGATES them ("DDP does not
 *   certify export readiness, pharmaceutical readiness, or legal compliance").
 *   A scan that cannot tell an assertion from its denial would force the
 *   removal of the strongest disclaimer on the site. Reviewing the existing
 *   landing copy is P1.5, tracked separately.
 */

/** The plan's list, plus the near-misses that mean the same thing. */
const BANNED_CLAIMS: RegExp[] = [
  /fully compliant/i,
  /legally compliant/i,
  /approved for export/i,
  /export[- ]ready/i,
  /export readiness/i,
  /pharmaceutical(ly)? approved/i,
  /certified pharmaceutical/i,
  /pharmaceutical[- ]grade/i,
  /guaranteed compliant/i,
  /verified supplier/i,
  /verified batch/i,
  // Absolutes that assert an outcome the platform does not determine.
  /\bguarantee[sd]?\b/i,
  /\bcertifie[sd]\b/i,
  /\bwe certify\b/i,
  /100% (compliant|accurate|secure)/i,
]

/** Thai equivalents of the same claims. */
const BANNED_CLAIMS_TH: RegExp[] = [
  /รับรองว่าถูกกฎหมาย/,
  /พร้อมส่งออก/,
  /ได้รับการรับรองมาตรฐานเภสัชกรรม/,
  /รับประกันว่า/,
  /ปลอดภัย 100%/,
]

/** Every key authored for the public corporate pages. */
function corporateKeys(lang: 'en' | 'th'): Array<[string, string]> {
  return Object.entries(T[lang])
    .filter(([key]) => key.startsWith('corp'))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
}

describe('Gate 5 — no unsupported claims in public corporate copy', () => {
  it('has corporate copy to check at all', () => {
    // Guards the guard: if the key prefix ever changes, every assertion below
    // would pass vacuously over an empty list.
    expect(corporateKeys('en').length).toBeGreaterThan(30)
    expect(corporateKeys('th').length).toBeGreaterThan(30)
  })

  it('makes no banned English claim', () => {
    for (const [key, value] of corporateKeys('en')) {
      for (const pattern of BANNED_CLAIMS) {
        expect(value, `translations.ts en.${key} publishes a claim matching ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('makes no banned Thai claim', () => {
    for (const [key, value] of corporateKeys('th')) {
      for (const pattern of BANNED_CLAIMS_TH) {
        expect(value, `translations.ts th.${key} publishes a claim matching ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  /**
   * A placeholder that reaches production is a published statement that the
   * company could not be bothered to finish. The facts this repository does not
   * evidence — registration number, data-protection officer, retention periods,
   * governing law — were omitted rather than stubbed, and this keeps it that way.
   */
  it('ships no unfilled placeholder', () => {
    for (const lang of ['en', 'th'] as const) {
      for (const [key, value] of corporateKeys(lang)) {
        expect(value, `${lang}.${key}`).not.toMatch(/TODO|TBC|TBD|XXX|\[.*?\]|lorem ipsum/i)
      }
    }
  })
})

describe('the corporate copy exists in both languages', () => {
  /**
   * A missing key renders the string "undefined" on a public page. TypeScript
   * does catch this — T[lang] is a union, so a property present on only one
   * side is a type error — but the failure message here names the key, and this
   * file is where someone adding a page will look.
   */
  it('has the same corporate keys in English and Thai', () => {
    const en = corporateKeys('en').map(([key]) => key).sort()
    const th = corporateKeys('th').map(([key]) => key).sort()
    expect(th).toEqual(en)
  })

  it('leaves no corporate string empty', () => {
    for (const lang of ['en', 'th'] as const) {
      for (const [key, value] of corporateKeys(lang)) {
        expect(value.trim(), `${lang}.${key} is empty`).not.toBe('')
      }
    }
  })
})

describe('the pages state their provenance', () => {
  /**
   * The master plan requires a named content owner and a last-reviewed date on
   * every public corporate page. Both are rendered by CorporatePageShell from
   * these keys, so asserting the keys asserts the requirement.
   */
  it('names a content owner', () => {
    expect(T.en.corpOwnerValue).toMatch(/DDP/)
    expect(T.th.corpOwnerValue).toMatch(/DDP/)
  })

  it('carries a review date in both languages', () => {
    expect(T.en.corpReviewedValue).toMatch(/\d{4}/)
    // Thai copy uses the Buddhist era, so the Gregorian year will not appear.
    expect(T.th.corpReviewedValue).toMatch(/\d{4}/)
  })
})
