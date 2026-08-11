import { describe, expect, it } from 'vitest'
import { daysOpen, displayName, shortIdentifier } from './entityName'
import {
  FARMER_PORTAL_FALLBACK_LANGUAGE, initialLanguage,
} from './languagePreference'

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

describe('the farm portal opens in Thai', () => {
  const storage = (value: string | null): Storage => ({
    getItem: () => value, setItem: () => undefined, removeItem: () => undefined,
    clear: () => undefined, key: () => null, length: 0,
  })

  it('falls back to Thai on the portal and English elsewhere', () => {
    expect(initialLanguage(storage(null), [], FARMER_PORTAL_FALLBACK_LANGUAGE)).toBe('th')
    expect(initialLanguage(storage(null), [])).toBe('en')
  })

  it('never overrides a choice the farmer already made', () => {
    // Someone who picked English on a Thai handset meant it.
    expect(initialLanguage(storage('en'), ['th-TH'], FARMER_PORTAL_FALLBACK_LANGUAGE)).toBe('en')
  })

  it('still prefers the handset over the fallback', () => {
    expect(initialLanguage(storage(null), ['en-GB'], FARMER_PORTAL_FALLBACK_LANGUAGE)).toBe('en')
  })
})
