import { describe, expect, it } from 'vitest'

import { T } from '../translations'
import { metadataForPage, indexablePages } from './publicPageMetadata'

/**
 * HOW DDP RUNS ITS CHECKS IS INTERNAL. It is never described in public copy.
 *
 * Public wording says the work is done by the team — "verified against our
 * partners and reviewed by our team", "reviewed by a named reviewer" — and
 * never characterises the mechanism behind it. That is a standing instruction
 * from the business, not a style preference, and it applies to every page
 * including ones not written yet.
 *
 * This exists because the constraint was already broken when it was given, and
 * in the language least likely to be re-read. The English on /about said
 * "Every review ends with a person, not a score" — which only implies a
 * mechanism. The Thai said "ไม่ใช่คะแนนอัตโนมัติ", which names one outright:
 * "not an AUTOMATED score". Nobody reviewing the English would have caught it.
 *
 * A rule kept by remembering is a rule that lapses the first time someone adds
 * a page in a language the reviewer does not read.
 */

/** Words that describe a mechanism rather than the people doing the work. */
const FORBIDDEN = [
  { pattern: /\bA\.?I\.?\b/, label: 'AI' },
  { pattern: /artificial intelligence/i, label: 'artificial intelligence' },
  { pattern: /machine learning/i, label: 'machine learning' },
  { pattern: /\bautomat(?:ed|ic|ically|ion)\b/i, label: 'automated / automation' },
  { pattern: /\balgorithm/i, label: 'algorithm' },
  { pattern: /\bautomatically\b/i, label: 'automatically' },
  // Thai
  { pattern: /อัตโนมัติ/, label: 'อัตโนมัติ (automated)' },
  { pattern: /ปัญญาประดิษฐ์/, label: 'ปัญญาประดิษฐ์ (artificial intelligence)' },
  // German / Czech, for the localised buyer pages
  { pattern: /\bautomatisch/i, label: 'automatisch (German)' },
  { pattern: /\bKI\b/, label: 'KI (German AI)' },
  { pattern: /\bautomatick/i, label: 'automatický (Czech)' },
]

/**
 * The one exemption, and why it is not a hole.
 *
 * The acceptable-use clause on /terms forbids the VISITOR from extracting data
 * by automated means. It describes what a user may not do; it says nothing
 * about how DDP works, which is the thing the constraint protects. Removing it
 * would weaken a term of use to satisfy a rule about marketing language.
 *
 * Adding to this list should be hard. Anything here must be a restriction
 * placed on someone else, never a description of DDP's own work.
 */
const EXEMPT = new Set(['corpTermsAcceptableText'])

const languages = Object.keys(T) as Array<keyof typeof T>

describe('public copy never describes how the checking is done', () => {
  it('reads the copy it reasons about, so the assertions are not vacuous', () => {
    expect(languages.length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(T[languages[0]]).length).toBeGreaterThan(50)
  })

  it.each(languages)('%s copy names no mechanism', (lang) => {
    const offenders: string[] = []

    for (const [key, value] of Object.entries(T[lang])) {
      if (typeof value !== 'string' || EXEMPT.has(key)) continue
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(value)) {
          offenders.push(`${key} contains "${label}": ${value.slice(0, 90)}`)
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })

  /**
   * Titles and descriptions are the copy most people see and the copy least
   * often re-read, because they live in a register rather than on a page.
   */
  it('names no mechanism in any published title or description', () => {
    const offenders: string[] = []

    for (const page of indexablePages()) {
      const meta = metadataForPage(page)
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(meta.title)) offenders.push(`${page} title contains "${label}"`)
        if (pattern.test(meta.description)) offenders.push(`${page} description contains "${label}"`)
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })

  /**
   * The specific line this file was written for. Asserted by name so that
   * restoring it is a deliberate act rather than an accident of a merge.
   */
  it('does not reintroduce the "not a score" implication on /about', () => {
    expect(T.en.corpAboutReviewNote).not.toMatch(/not a score/i)
    expect(T.en.corpAboutReviewNote).toContain('named reviewer')
    expect(T.th.corpAboutReviewNote).not.toContain('อัตโนมัติ')
  })

  /**
   * The exemption is asserted rather than merely allowed, so that if the terms
   * are reworded and the clause disappears, this file notices and the exemption
   * can be removed instead of sitting here forever protecting nothing.
   */
  /**
   * The buyer reference is cleared in ONE exact phrasing. A variation is not a
   * smaller version of a cleared claim — it is an uncleared one, and this is
   * the kind of string that gets "tidied" by someone improving the copy.
   */
  it('references the buyer only in the cleared phrasing', () => {
    // The cleared phrasing, exactly. Anything else is not a smaller version of
    // a cleared claim — it is an uncleared one.
    const CLEARED = 'a certified pharmaceutical buyer in Central Europe'

    for (const lang of languages) {
      for (const [key, value] of Object.entries(T[lang])) {
        if (typeof value !== 'string') continue
        if (!/pharmaceutical buyer/i.test(value)) continue
        expect(
          value.includes(CLEARED),
          `${lang}.${key} references the buyer without the cleared phrasing: ${value}`,
        ).toBe(true)
      }
    }
  })

  /**
   * The licensed-operators notice is two keys so that sentence ① keeps its
   * approved translations byte-for-byte. Two keys are two things that can be
   * used singly, so this asserts they are always rendered together.
   */
  it('renders both halves of the licensed-operators notice together', () => {
    const sources = import.meta.glob(
      ['../pages/public/*.tsx', '../components/public/*.tsx'],
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>

    // Matches a RENDER — {copy.x} or {t.x} — not a mention in a comment, which
    // is what a looser check matched the first time this was written.
    const renders = (source: string, key: string) =>
      new RegExp(`\\{(?:copy|t)\\.${key}\\}`).test(source)

    for (const [path, source] of Object.entries(sources)) {
      for (const key of ['landingDisclaimer', 'eligibility']) {
        if (!renders(source, key)) continue
        expect(
          renders(source, `${key}Access`),
          `${path} renders ${key} without ${key}Access — the notice must never appear as half of itself`,
        ).toBe(true)
      }
    }
  })

  it('still needs its one exemption', () => {
    expect(T.en.corpTermsAcceptableText).toMatch(/automated means/i)
  })
})
