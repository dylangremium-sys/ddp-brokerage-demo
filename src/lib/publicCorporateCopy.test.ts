import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { T } from '../translations'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relativePath: string) => readFileSync(join(REPO_ROOT, relativePath), 'utf8')

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
  /fully compliant/iu,
  /legally compliant/iu,
  /approved for export/iu,
  /export[- ]ready/iu,
  /export readiness/iu,
  /pharmaceutical(ly)? approved/iu,
  /certified pharmaceutical/iu,
  /pharmaceutical[- ]grade/iu,
  /guaranteed compliant/iu,
  /verified supplier/iu,
  /verified batch/iu,
  // Absolutes that assert an outcome the platform does not determine.
  /\bguarantee[sd]?\b/iu,
  /\bcertifie[sd]\b/iu,
  /\bwe certify\b/iu,
  /100% (compliant|accurate|secure)/iu,
]

/** Thai equivalents of the same claims. */
const BANNED_CLAIMS_TH: RegExp[] = [
  /รับรองว่าถูกกฎหมาย/u,
  /พร้อมส่งออก/u,
  /ได้รับการรับรองมาตรฐานเภสัชกรรม/u,
  /รับประกันว่า/u,
  /ปลอดภัย 100%/u,
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

describe('the privacy policy matches the network behaviour it describes', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR.
   *
   * The first version of this policy told visitors the browser "talks only to
   * our own backend". It was false: vercel.json's CSP has always permitted
   * fonts.googleapis.com and fonts.gstatic.com, and index.html preconnects to
   * both and pulls a stylesheet from Google — so Google receives the IP address
   * of every visitor to a page that claims no third party is contacted.
   *
   * A privacy policy that denies a data flow is worse than one that omits it,
   * and nothing in a normal test suite looks at prose. So this derives the
   * claim's subject matter from the CSP itself: every external host the browser
   * is PERMITTED to reach must be disclosed by name in the public copy. Adding
   * a host to vercel.json without updating the policy now fails here.
   *
   * It deliberately reads the deployed policy in vercel.json rather than a
   * copy: the file that governs the browser is the only honest source.
   */
  const csp = read('vercel.json').match(/"Content-Security-Policy",\s*\n?\s*"value":\s*"([^"]+)"/s)?.[1]
    ?? read('vercel.json').match(/default-src[^"]+/)?.[0]
    ?? ''

  /** Every external origin the CSP permits, across all fetch directives. */
  const externalHosts = [...new Set(
    [...csp.matchAll(/(?:https|wss):\/\/([a-z0-9.-]+)/gu)].map((match) => match[1]),
  )].sort()

  /**
   * How each host must be described to a reader. A hostname in a privacy
   * policy tells a non-technical visitor nothing; the operator's NAME is the
   * disclosure. Both language versions must carry it.
   */
  const DISCLOSURE: Array<{ hostPattern: RegExp; mustMention: { en: RegExp; th: RegExp }; who: string }> = [
    {
      hostPattern: /^fonts\.(googleapis|gstatic)\.com$/u,
      mustMention: { en: /Google Fonts/u, th: /Google Fonts/u },
      who: 'Google (fonts)',
    },
    {
      hostPattern: /\.supabase\.co$/u,
      mustMention: { en: /Supabase/u, th: /Supabase/u },
      who: 'Supabase (database, storage, auth)',
    },
  ]

  const privacyCopy = (lang: 'en' | 'th') =>
    corporateKeys(lang)
      .filter(([key]) => key.startsWith('corpPrivacy'))
      .map(([, value]) => value)
      .join('\n')

  it('found the content security policy to check against', () => {
    // Guards the guard: a regex that stopped matching would make every
    // assertion below pass over an empty host list.
    expect(csp).toMatch(/default-src/u)
    expect(externalHosts.length).toBeGreaterThan(0)
  })

  it('has a disclosure rule for every external host the CSP permits', () => {
    // If a NEW external host is added to the CSP, it lands here first: there is
    // no rule describing how to disclose it, so this fails and forces the
    // decision to be made rather than skipped.
    const undisclosed = externalHosts.filter(
      (host) => !DISCLOSURE.some((rule) => rule.hostPattern.test(host)),
    )
    expect(
      undisclosed,
      `vercel.json permits ${undisclosed.join(', ')} but the privacy policy has no disclosure ` +
        'rule for it. Add the host to the policy copy and to DISCLOSURE, or remove it from the CSP.',
    ).toEqual([])
  })

  it.each(DISCLOSURE)('names $who in the English policy', ({ hostPattern, mustMention, who }) => {
    // Only require the disclosure if the CSP actually permits that host — so
    // removing a host (e.g. self-hosting the fonts) does not leave a stale
    // claim that this test insists on keeping.
    if (!externalHosts.some((host) => hostPattern.test(host))) return
    expect(privacyCopy('en'), `the English privacy copy does not name ${who}`).toMatch(mustMention.en)
  })

  it.each(DISCLOSURE)('names $who in the Thai policy', ({ hostPattern, mustMention, who }) => {
    if (!externalHosts.some((host) => hostPattern.test(host))) return
    expect(privacyCopy('th'), `the Thai privacy copy does not name ${who}`).toMatch(mustMention.th)
  })

  it('no longer claims the browser contacts only our own backend', () => {
    // The exact false sentence, in both languages. Pinned so it cannot return.
    expect(privacyCopy('en')).not.toMatch(/only (to )?our own backend/u)
    expect(privacyCopy('en')).not.toMatch(/no other outside service is contacted\./u)
    expect(privacyCopy('th')).not.toMatch(/ระบบหลังบ้านของเราเท่านั้น/u)
  })

  /**
   * The demo build is the other case the first draft got wrong. With no
   * database configured, lib/browserPersistence.ts makes localStorage the
   * database — it holds farm profiles, inventory and review requests, not a
   * language preference. The policy has to say so.
   */
  it('discloses that browser storage is the database in an unconfigured build', () => {
    expect(privacyCopy('en')).toMatch(/browser storage IS the database/iu)
    expect(privacyCopy('th')).toMatch(/ฐานข้อมูล/u)
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
