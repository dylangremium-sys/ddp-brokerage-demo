import { describe, expect, it } from 'vitest'
import { daysOpen, displayName, isIdentifier, shortIdentifier } from './entityName'
import { initialLanguage } from './languagePreference'

/**
 * Standing rule 4: identifiers in mono, names in body type, and a UUID must
 * never serve as a record title.
 *
 * These are the shapes production actually holds — measured on the Operations
 * Desk, 24 matters: 11 rendered their farm as a bare UUID and one as
 * "BIG HAIRY ASS ·", a dangling separator where a farm name should have been.
 */

const UNNAMED = 'Farm with no name on file'
const A_UUID = 'b1f4182c-3a2b-419b-b050-84609ac13492'

describe('displayName', () => {
  it('passes a real name through untouched', () => {
    expect(displayName('Mae Rim Organics', UNNAMED)).toEqual({
      name: 'Mae Rim Organics', unnamed: false,
    })
  })

  it('never renders a bare UUID as the title, and keeps it as the identifier', () => {
    const shown = displayName(A_UUID, UNNAMED)
    expect(shown.name).toBe(UNNAMED)
    expect(shown.identifier).toBe(A_UUID)
    expect(shown.unnamed).toBe(true)
  })

  it('strips a dangling separator left by an empty join', () => {
    // "BIG HAIRY ASS ·" — a real row in production.
    expect(displayName('BIG HAIRY ASS ·', UNNAMED).name).toBe('BIG HAIRY ASS')
    expect(displayName('· billyboy', UNNAMED).name).toBe('billyboy')
  })

  it('falls back to the supplied id when the label carries none', () => {
    const shown = displayName('', UNNAMED, 'farm-7')
    expect(shown.name).toBe(UNNAMED)
    expect(shown.identifier).toBe('farm-7')
  })

  it('treats a separator-only label as no name at all', () => {
    expect(displayName(' · ', UNNAMED, 'farm-7').unnamed).toBe(true)
  })

  it('is case-insensitive about UUIDs, because sources differ', () => {
    expect(displayName(A_UUID.toUpperCase(), UNNAMED).unnamed).toBe(true)
  })

  // The whole-label test passed these through, because a composite is not a bare
  // identifier. The Operations Desk built exactly this shape for every
  // compliance matter, so the id printed as the record's title.
  it('never renders an identifier as the title just because a word is glued to it', () => {
    const shown = displayName(`farm · ${A_UUID}`, UNNAMED)
    expect(shown.name).not.toContain(A_UUID)
    expect(shown.name).toBe('farm')
    expect(shown.identifier).toBe(A_UUID)
  })

  it('keeps the real half of a composite and demotes the identifier half', () => {
    const shown = displayName(`Sunrise Mango · ${A_UUID}`, UNNAMED)
    expect(shown.name).toBe('Sunrise Mango')
    expect(shown.identifier).toBe(A_UUID)
    expect(shown.unnamed).toBe(false)
  })

  it('falls back to unnamed when every part is an identifier', () => {
    const shown = displayName(`${A_UUID} · ${A_UUID}`, UNNAMED)
    expect(shown.name).toBe(UNNAMED)
    expect(shown.identifier).toBe(A_UUID)
    expect(shown.unnamed).toBe(true)
  })

  it('leaves a genuine two-part name alone', () => {
    expect(displayName('Northern Lights · Green Valley', UNNAMED).name)
      .toBe('Northern Lights · Green Valley')
  })
})

describe('isIdentifier', () => {
  it('separates an id from a name, so callers need no second copy of the rule', () => {
    expect(isIdentifier(A_UUID)).toBe(true)
    expect(isIdentifier(` ${A_UUID.toUpperCase()} `)).toBe(true)
    expect(isIdentifier('Mae Rim Organics')).toBe(false)
    expect(isIdentifier('')).toBe(false)
  })
})

describe('shortIdentifier', () => {
  it('truncates a long id and leaves a short one alone', () => {
    expect(shortIdentifier(A_UUID)).toBe('b1f4182c…')
    expect(shortIdentifier('farm-7')).toBe('farm-7')
  })
})

describe('daysOpen', () => {
  const now = new Date('2026-08-11T12:00:00.000Z')

  it('counts whole days since the record was made', () => {
    expect(daysOpen('2026-08-04T12:00:00.000Z', now)).toBe(7)
  })

  it('never returns a negative age for a future timestamp', () => {
    expect(daysOpen('2026-09-01T12:00:00.000Z', now)).toBe(0)
  })

  it('returns null for an unparseable date rather than NaN', () => {
    // NaN sorts above every number and renders as "NaN days open".
    expect(daysOpen('not a date', now)).toBeNull()
  })
})

describe('the farm portal has its own opening language', () => {
  const storage = (value: string | null): Storage => ({
    getItem: () => value, setItem: () => undefined, removeItem: () => undefined,
    clear: () => undefined, key: () => null, length: 0,
  })

  // Both settings are covered, so flipping FARMER_PORTAL_DEFAULT_LANGUAGE to
  // 'th' after the copy review is a one-value change with a test already behind
  // it, not a change that needs new tests written under time pressure.
  it('uses whichever fallback it is given', () => {
    expect(initialLanguage(storage(null), [], 'th')).toBe('th')
    expect(initialLanguage(storage(null), [], 'en')).toBe('en')
    expect(initialLanguage(storage(null), [])).toBe('en')
  })

  it('never overrides a choice the farmer already made', () => {
    // Someone who picked English on a Thai handset meant it.
    expect(initialLanguage(storage('en'), ['th-TH'], 'th')).toBe('en')
  })

  it('still prefers the handset over the fallback', () => {
    // A Thai phone gets Thai whatever the fallback is set to.
    expect(initialLanguage(storage(null), ['th-TH'], 'en')).toBe('th')
    expect(initialLanguage(storage(null), ['en-GB'], 'th')).toBe('en')
  })
})

describe('the mono line under a batch joins only what exists', () => {
  // Every batch on the live farm has an empty batch number, so a fixed
  // "code · qty" template rendered "— · 50 kg": a separator with nothing on one
  // side of it, which is the shape of missing data rather than a fact.
  const line = (parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ')

  it('drops the separator when there is no code', () => {
    expect(line(['', '50 kg'])).toBe('50 kg')
    expect(line([undefined, '50 kg'])).toBe('50 kg')
  })

  it('keeps it when both parts are real', () => {
    expect(line(['DSO-0112', '80 kg'])).toBe('DSO-0112 · 80 kg')
  })
})
