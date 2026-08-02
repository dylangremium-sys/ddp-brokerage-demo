// ─── Dual-calendar handling: Buddhist Era (พ.ศ.) and Common Era ──────────────
//
// Thai official documents — licences, permits, COAs, FDA and DTAM filings —
// are dated in the Buddhist Era. B.E. 2569 is 2026 CE. Every date this platform
// reads off a Thai document, and every date it prints onto one, crosses that
// boundary.
//
// The failure this module exists to prevent is not a rendering nuisance. A
// 543-year error on a permit expiry either lets a consignment ship against a
// lapsed permit, or holds a valid one at the port. Both are regulatory events.
//
// Three rules follow, and they are enforced here rather than left to callers:
//
//   1. CE is canonical in storage. Everything computes on CE.
//   2. BE is stored explicitly alongside it, never re-derived silently at read
//      time. If the two disagree, that is a data-quality exception to surface —
//      not something to resolve by quietly preferring one. `reconcileDualYear`
//      returns the disagreement; it does not paper over it.
//   3. A bare four-digit year is never trusted. `classifyEra` says what a year
//      can and cannot be, and returns 'ambiguous' rather than guessing.
//
// NOTE ON THE OFFSET. Thailand moved its new year to 1 January in 1941 CE, so
// for every date this platform will ever handle the offset is a flat 543 across
// the whole year. Documents dated before 1941 used a 1 April year start and are
// NOT convertible with this module. `classifyEra` rejects them rather than
// returning a wrong answer quietly.
//
// NOTE ON `Date`. This module does no `new Date()` parsing anywhere. It is
// string and integer arithmetic throughout. `new Date('2026-01-01')` is parsed
// as UTC midnight, which in any timezone west of Greenwich renders as
// 31 December 2025 — silently shifting a permit expiry by a day, and across a
// year boundary by a year. That bug is exactly the class of error this module
// is here to eliminate, so it does not get to enter through the back door.

import type { Lang } from '../types'

/** BE − CE. Constant for every date after Thailand's 1941 new-year reform. */
export const BE_CE_OFFSET = 543

/**
 * Earliest CE year this module will convert.
 *
 * Before 1941 the Thai year began on 1 April, so a BE year maps onto two
 * different CE years depending on the month and the flat offset is wrong for
 * roughly a quarter of the calendar. No licence, permit or COA predates this,
 * so refusing is free — and refusing is the only honest option, because the
 * alternative is a plausible-looking answer that is off by one year.
 */
export const EARLIEST_CONVERTIBLE_CE_YEAR = 1941

/**
 * Latest CE year accepted. Not a Y10K joke: it catches a BE year that has been
 * run through the conversion twice (2026 → 2569 → 3112), which is the single
 * most common dual-calendar defect and is otherwise invisible.
 */
export const LATEST_CONVERTIBLE_CE_YEAR = 2200

export type Era = 'be' | 'ce'

/**
 * What a bare four-digit year can be.
 *
 * With the constants above, 'ambiguous' is UNREACHABLE, and that is a derived
 * property worth stating rather than an accident: the CE window ends at 2200
 * and the BE window starts at 2484, so the two never overlap. Every real Thai
 * document year therefore classifies with certainty — 2569 can only be BE
 * (as CE it is beyond the ceiling), 2026 can only be CE (as BE it is 1483,
 * before the new-year reform).
 *
 * The branch is kept, and `thaiCalendar.test.ts` asserts the non-overlap
 * directly, so that widening either constant surfaces as a failing test rather
 * than silently opening a path where the module guesses an era.
 */
export type EraClassification =
  | { readonly era: Era; readonly certain: true }
  | { readonly era: null; readonly certain: false; readonly reason: 'ambiguous' | 'out-of-range' }

export function classifyEra(year: number): EraClassification {
  if (!Number.isInteger(year)) return { era: null, certain: false, reason: 'out-of-range' }

  const plausibleCe = year >= EARLIEST_CONVERTIBLE_CE_YEAR && year <= LATEST_CONVERTIBLE_CE_YEAR
  const plausibleBe =
    year >= EARLIEST_CONVERTIBLE_CE_YEAR + BE_CE_OFFSET && year <= LATEST_CONVERTIBLE_CE_YEAR + BE_CE_OFFSET

  if (plausibleCe && plausibleBe) return { era: null, certain: false, reason: 'ambiguous' }
  if (plausibleCe) return { era: 'ce', certain: true }
  if (plausibleBe) return { era: 'be', certain: true }
  return { era: null, certain: false, reason: 'out-of-range' }
}

export function ceYearToBe(ceYear: number): number {
  return ceYear + BE_CE_OFFSET
}

export function beYearToCe(beYear: number): number {
  return beYear - BE_CE_OFFSET
}

// ─── Dual dates ─────────────────────────────────────────────────────────────

/**
 * A date carried in both calendars.
 *
 * `ce` is the canonical ISO 8601 calendar date and the only field arithmetic
 * ever touches. `beYear` is stored, not derived on read, so that a mismatch
 * introduced upstream — a mis-keyed permit, a bad OCR extraction — remains
 * visible instead of being silently corrected into agreement.
 */
export interface DualDate {
  readonly ce: string
  readonly beYear: number
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days in a month, with a proleptic Gregorian leap rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export type DateParseFailure =
  | 'malformed'
  | 'impossible-date'
  | 'era-ambiguous'
  | 'era-out-of-range'

export type DualDateResult =
  | { readonly ok: true; readonly value: DualDate }
  | { readonly ok: false; readonly reason: DateParseFailure }

/**
 * Build a DualDate from an ISO date whose era is already known.
 *
 * Use this at every boundary where the era is established by the source — a
 * Thai-language permit is BE, a Supabase `date` column is CE — rather than
 * calling the parser and hoping the year happens to be unambiguous.
 */
export function dualDateFrom(iso: string, era: Era): DualDateResult {
  const m = ISO_DATE_RE.exec(iso)
  if (!m) return { ok: false, reason: 'malformed' }

  const rawYear = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])

  const ceYear = era === 'be' ? beYearToCe(rawYear) : rawYear
  if (ceYear < EARLIEST_CONVERTIBLE_CE_YEAR || ceYear > LATEST_CONVERTIBLE_CE_YEAR) {
    return { ok: false, reason: 'era-out-of-range' }
  }
  if (month < 1 || month > 12) return { ok: false, reason: 'impossible-date' }
  if (day < 1 || day > daysInMonth(ceYear, month)) return { ok: false, reason: 'impossible-date' }

  const ce = `${String(ceYear).padStart(4, '0')}-${m[2]}-${m[3]}`
  return { ok: true, value: { ce, beYear: ceYearToBe(ceYear) } }
}

/**
 * Parse an ISO date of UNKNOWN era, inferring it from the year.
 *
 * Returns 'era-ambiguous' rather than guessing when the year is valid in both
 * calendars. A caller that cannot resolve the ambiguity must raise a
 * data-quality exception for a human — never pick a default.
 */
export function parseDualDate(iso: string): DualDateResult {
  const m = ISO_DATE_RE.exec(iso)
  if (!m) return { ok: false, reason: 'malformed' }

  const classification = classifyEra(Number(m[1]))
  if (!classification.certain) {
    return { ok: false, reason: classification.reason === 'ambiguous' ? 'era-ambiguous' : 'era-out-of-range' }
  }
  return dualDateFrom(iso, classification.era)
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export type DualYearMismatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed-ce' }
  | {
      readonly ok: false
      readonly reason: 'offset-mismatch'
      readonly ceYear: number
      readonly beYear: number
      /** What the BE year should have been. Report it; do not write it. */
      readonly expectedBeYear: number
      /**
       * Signed difference from the correct offset. −543 or +543 means the pair
       * was converted one time too few or too many — by far the likeliest
       * cause, and worth naming in the exception a reviewer reads.
       */
      readonly drift: number
    }

/**
 * Assert that a stored CE/BE pair agrees.
 *
 * §2 of the technology plan requires the assertion to exist and the mismatch to
 * surface as a data-quality exception. This returns the mismatch; the caller
 * decides where it goes. Nothing here mutates or "corrects" a stored value:
 * overwriting one side of a disagreement destroys the evidence that there was
 * one, and the wrong side is as likely to be the one you keep.
 */
export function reconcileDualYear(ceYear: number, beYear: number): DualYearMismatch {
  const expectedBeYear = ceYearToBe(ceYear)
  if (beYear === expectedBeYear) return { ok: true }
  return {
    ok: false,
    reason: 'offset-mismatch',
    ceYear,
    beYear,
    expectedBeYear,
    drift: beYear - expectedBeYear,
  }
}

/**
 * Reconcile a stored DualDate against its own CE date.
 *
 * A CE side that is not a well-formed ISO date reports 'malformed-ce', not a
 * mismatch with NaN fields. They are different findings — one is a broken
 * record, the other is a 543-year error — and a reviewer must be able to tell
 * them apart from the exception alone.
 */
export function reconcileDualDate(value: DualDate): DualYearMismatch {
  const m = ISO_DATE_RE.exec(value.ce)
  if (!m) return { ok: false, reason: 'malformed-ce' }
  return reconcileDualYear(Number(m[1]), value.beYear)
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
] as const

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/**
 * Render by locale: Thai readers get พ.ศ., English readers get CE.
 *
 * The era marker is always printed. An unlabelled Thai date is precisely the
 * artefact that makes a 543-year error survive review, because both readings
 * look like a plausible year.
 */
export function formatDualDate(value: DualDate, lang: Lang): string {
  const m = ISO_DATE_RE.exec(value.ce)
  if (!m) return value.ce

  const monthIndex = Number(m[2]) - 1
  const day = Number(m[3])
  if (monthIndex < 0 || monthIndex > 11) return value.ce

  if (lang === 'th') {
    return `${day} ${THAI_MONTHS[monthIndex]} พ.ศ. ${value.beYear}`
  }
  return `${day} ${EN_MONTHS[monthIndex]} ${m[1]} CE`
}

/** Compact both-calendars rendering for documents that must satisfy either reader. */
export function formatDualDateBoth(value: DualDate): string {
  const m = ISO_DATE_RE.exec(value.ce)
  if (!m) return value.ce
  return `${value.ce} CE (พ.ศ. ${value.beYear})`
}

// ─── Expiry ─────────────────────────────────────────────────────────────────

/**
 * Has this date passed as at `asOfCe`?
 *
 * Both arguments are ISO CE dates and the comparison is a plain string compare,
 * which is exact for zero-padded ISO 8601 and immune to timezone shifts. An
 * expiry is inclusive of its own day: a licence expiring 2026-12-31 is valid
 * throughout 31 December and lapses on 1 January — which is how D4's cliff is
 * written in the regulation.
 */
export function isExpiredAsOf(value: DualDate, asOfCe: string): boolean {
  return asOfCe > value.ce
}
