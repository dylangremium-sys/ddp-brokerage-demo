import { describe, it, expect } from 'vitest'
import {
  detectLanguage,
  initialLanguage,
  isSupportedLanguage,
  readStoredLanguage,
  storeLanguage,
  FALLBACK_LANGUAGE,
} from './languagePreference'

/**
 * P1 / W10.3 — Thai was unreachable on the farmer's primary entry path.
 *
 * `lang` was a hardcoded `'en'` that was never persisted, and the only toggle
 * lived inside an `isDemo` branch, so in production it never rendered. A Thai
 * farm scanning the QR code landed on an English form and could not change it,
 * while the bundle carried 498 Thai keys at full parity.
 *
 * Every function takes its storage and browser preferences as arguments, so
 * these run in this repository's `node` vitest environment with no DOM.
 */

/** An in-memory Storage, so the tests never depend on a real localStorage. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => { data.clear() },
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size },
  } as Storage
}

/** Storage that throws, as Safari private mode does. */
const hostileStorage = {
  getItem: () => { throw new Error('denied') },
  setItem: () => { throw new Error('denied') },
} as unknown as Storage

describe('isSupportedLanguage', () => {
  it('accepts the two languages the product actually ships', () => {
    expect(isSupportedLanguage('en')).toBe(true)
    expect(isSupportedLanguage('th')).toBe(true)
  })

  it('rejects anything else, including near-misses and non-strings', () => {
    for (const value of ['TH', 'th-TH', 'fr', '', null, undefined, 3, {}]) {
      expect(isSupportedLanguage(value)).toBe(false)
    }
  })
})

describe('detectLanguage', () => {
  it('matches a Thai handset, which reports a region', () => {
    // th-TH is what a Thai phone actually sends. Matching the whole string
    // would never hit, which is the failure this guards.
    expect(detectLanguage(['th-TH'])).toBe('th')
  })

  it('takes the first supported preference, not the first preference', () => {
    expect(detectLanguage(['fr-FR', 'th-TH', 'en-GB'])).toBe('th')
  })

  it('is case-insensitive on the primary subtag', () => {
    expect(detectLanguage(['TH-th'])).toBe('th')
  })

  it('returns null when nothing is supported, rather than guessing', () => {
    expect(detectLanguage(['fr-FR', 'de-DE'])).toBeNull()
    expect(detectLanguage([])).toBeNull()
    expect(detectLanguage()).toBeNull()
  })
})

describe('stored preference', () => {
  it('round-trips a choice', () => {
    const storage = fakeStorage()
    storeLanguage('th', storage)
    expect(readStoredLanguage(storage)).toBe('th')
  })

  it('ignores a corrupted or unsupported stored value', () => {
    expect(readStoredLanguage(fakeStorage({ 'ddp.lang': 'klingon' }))).toBeNull()
  })

  it('survives storage that throws, rather than breaking boot', () => {
    expect(readStoredLanguage(hostileStorage)).toBeNull()
    expect(() => storeLanguage('th', hostileStorage)).not.toThrow()
  })

  it('survives storage being absent entirely', () => {
    expect(readStoredLanguage(null)).toBeNull()
    expect(() => storeLanguage('th', null)).not.toThrow()
  })
})

describe('initialLanguage', () => {
  it('opens a Thai handset in Thai', () => {
    expect(initialLanguage(fakeStorage(), ['th-TH'])).toBe('th')
  })

  it('honours an explicit choice over the handset language', () => {
    // Someone on a Thai phone who picked English meant it, and must not be
    // overridden on every reload.
    expect(initialLanguage(fakeStorage({ 'ddp.lang': 'en' }), ['th-TH'])).toBe('en')
  })

  it('honours an explicit Thai choice on an English handset', () => {
    expect(initialLanguage(fakeStorage({ 'ddp.lang': 'th' }), ['en-GB'])).toBe('th')
  })

  it('falls back to English when nothing is known', () => {
    // Both arguments are explicit. Passing `undefined` for preferences would
    // trigger the parameter default, which reads the host's navigator — so the
    // test would silently depend on whatever language the machine running it
    // is set to, and would have asserted nothing about the no-preferences path.
    expect(initialLanguage(fakeStorage(), [])).toBe(FALLBACK_LANGUAGE)
    expect(initialLanguage(null, [])).toBe(FALLBACK_LANGUAGE)
  })

  it('does not throw when storage is hostile', () => {
    expect(() => initialLanguage(hostileStorage, ['th-TH'])).not.toThrow()
    expect(initialLanguage(hostileStorage, ['th-TH'])).toBe('th')
  })
})
