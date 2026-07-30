import { describe, it, expect } from 'vitest'
import {
  validateNewPassword,
  passwordByteLength,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
} from './passwordPolicy'

const GOOD = 'sunflower7field'

describe('validateNewPassword', () => {
  it('accepts a password that meets the policy and matches its confirmation', () => {
    expect(validateNewPassword(GOOD, GOOD)).toEqual({ ok: true })
  })

  it('rejects an empty password', () => {
    expect(validateNewPassword('', '')).toEqual({ ok: false, reason: 'empty' })
  })

  it(`rejects fewer than ${MIN_PASSWORD_LENGTH} characters`, () => {
    const short = 'a1b2c3d8'
    expect(short.length).toBeLessThan(MIN_PASSWORD_LENGTH)
    expect(validateNewPassword(short, short)).toEqual({ ok: false, reason: 'too-short' })
  })

  it('accepts exactly the minimum length', () => {
    const exact = 'abcdefgh19'
    expect(exact.length).toBe(MIN_PASSWORD_LENGTH)
    expect(validateNewPassword(exact, exact)).toEqual({ ok: true })
  })

  it('rejects a mismatched confirmation', () => {
    expect(validateNewPassword(GOOD, `${GOOD}x`)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('reports the password problem before the mismatch', () => {
    // Both are wrong. Telling the user "they do not match" first makes them
    // retype a password that was never going to be accepted.
    expect(validateNewPassword('short1', 'different')).toEqual({ ok: false, reason: 'too-short' })
  })

  it('requires a letter and a number', () => {
    expect(validateNewPassword('1234567890', '1234567890')).toEqual({ ok: false, reason: 'no-letter' })
    expect(validateNewPassword('abcdefghij', 'abcdefghij')).toEqual({ ok: false, reason: 'no-number' })
  })

  it('counts a Thai password as having letters', () => {
    // [a-zA-Z] would call this letterless and reject a perfectly valid password
    // for the majority of this app's suppliers.
    const thai = 'ดอกทานตะวัน7'
    expect(validateNewPassword(thai, thai)).toEqual({ ok: true })
  })

  it('rejects a password that exceeds bcrypt’s 72-BYTE limit', () => {
    // 25 Thai characters is 75 UTF-8 bytes. bcrypt hashes the first 72 and
    // silently discards the rest, so the user would end up with a password
    // whose tail does nothing — and no indication that happened.
    const thai = `${'ก'.repeat(24)}1`
    expect([...thai].length).toBeLessThan(MAX_PASSWORD_BYTES)
    expect(passwordByteLength(thai)).toBeGreaterThan(MAX_PASSWORD_BYTES)
    expect(validateNewPassword(thai, thai)).toEqual({ ok: false, reason: 'too-long' })
  })

  it('accepts a long ASCII passphrase that fits in 72 bytes', () => {
    const phrase = 'correct horse battery staple 7 and then some more words'
    expect(passwordByteLength(phrase)).toBeLessThanOrEqual(MAX_PASSWORD_BYTES)
    expect(validateNewPassword(phrase, phrase)).toEqual({ ok: true })
  })

  it('counts an emoji as one character, not two', () => {
    // '🌻'.length is 2 in UTF-16. Counting that way would let a 9-visible-
    // character password through as if it were 10.
    const nine = '🌻abcdefg1'
    expect([...nine].length).toBe(9)
    expect(nine.length).toBe(10)
    expect(validateNewPassword(nine, nine)).toEqual({ ok: false, reason: 'too-short' })
  })
})

describe('passwordByteLength', () => {
  it('measures UTF-8 bytes, not UTF-16 units', () => {
    expect(passwordByteLength('abc')).toBe(3)
    expect(passwordByteLength('ก')).toBe(3)
  })
})
