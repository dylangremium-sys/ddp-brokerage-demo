import { describe, expect, it } from 'vitest'

import {
  CONSENT_TEXT,
  SIGNUP_RESPONSE,
  SubscriptionError,
  canonicaliseAddress,
  isPlausibleAddress,
  isWellFormedToken,
  resolveConfirmation,
  resolveUnsubscribe,
} from './subscriptionConsent'

describe('the consent statement says what a consent statement has to', () => {
  /**
   * Stored against every subscription, so changing the sign-up copy later
   * cannot retroactively alter what somebody already agreed to.
   */
  it('says what arrives, how often, and how to stop', () => {
    expect(CONSENT_TEXT).toMatch(/regulatory updates/i)
    expect(CONSENT_TEXT).toMatch(/week/i)
    expect(CONSENT_TEXT).toMatch(/unsubscribe/i)
    expect(CONSENT_TEXT.length).toBeLessThanOrEqual(500)
  })

  it('names no mechanism, under the standing copy constraint', () => {
    for (const forbidden of [/\bA\.?I\.?\b/, /automat/i, /algorithm/i]) {
      expect(CONSENT_TEXT).not.toMatch(forbidden)
    }
  })
})

describe('addresses are checked for shape, not for existence', () => {
  it.each([
    'a@b.co',
    'someone@ddpbrokerage.com',
    'first.last+updates@gmail.com',
  ])('accepts %s', (address) => {
    expect(isPlausibleAddress(address)).toBe(true)
  })

  it.each([
    ['no at sign', 'nobody.example.com'],
    ['two at signs', 'a@b@c.com'],
    ['no dot in domain', 'a@localhost'],
    ['leading dot in domain', 'a@.com'],
    ['consecutive dots', 'a@b..com'],
    ['whitespace', 'a b@c.com'],
    ['empty local part', '@b.com'],
    ['too short', 'a@b'],
  ])('rejects %s', (_label, address) => {
    expect(isPlausibleAddress(address)).toBe(false)
  })

  it('rejects an address longer than the column allows', () => {
    expect(isPlausibleAddress(`${'a'.repeat(250)}@b.com`)).toBe(false)
  })
})

describe('two spellings of one mailbox are one subscription', () => {
  /**
   * Without this, one person becomes two subscriptions, two confirmation
   * emails, and two rows in an unsubscribe list that only removes one of them.
   */
  it('treats gmail dots and +tags as the same mailbox', () => {
    const canonical = canonicaliseAddress('A.Person+updates@Gmail.com')
    expect(canonical).toBe('aperson@gmail.com')
    expect(canonicaliseAddress('aperson@gmail.com')).toBe(canonical)
  })

  it('does NOT strip dots for providers that honour them', () => {
    // Removing dots on a domain that treats them as significant would merge two
    // genuinely different people into one subscription.
    expect(canonicaliseAddress('first.last@ddpbrokerage.com')).toBe('first.last@ddpbrokerage.com')
  })

  it('lower-cases everywhere, since domains are case-insensitive', () => {
    expect(canonicaliseAddress('Someone@Example.COM')).toBe('someone@example.com')
  })

  it('returns null for an address that cannot be canonicalised', () => {
    expect(canonicaliseAddress('not-an-address')).toBeNull()
    expect(canonicaliseAddress('.+@gmail.com')).toBeNull()
  })
})

describe('tokens are rejected before they cost a query', () => {
  it('accepts a URL-safe token of the right length', () => {
    expect(isWellFormedToken('a'.repeat(43))).toBe(true)
    expect(isWellFormedToken('A1_-'.repeat(8))).toBe(true)
  })

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['not URL-safe', `${'a'.repeat(40)}/+=`],
    ['empty', ''],
  ])('rejects %s', (_label, token) => {
    expect(isWellFormedToken(token)).toBe(false)
  })
})

describe('confirming', () => {
  /**
   * A forwarded link, a mail client prefetching, or a second click on a slow
   * connection all produce a double confirmation. Showing a failure would tell
   * somebody their subscription is broken while it is working.
   */
  it('is idempotent, and does not rewrite existing evidence', () => {
    expect(resolveConfirmation({ status: 'pending' })).toEqual({ outcome: 'confirmed', changed: true })
    expect(resolveConfirmation({ status: 'confirmed' })).toEqual({ outcome: 'confirmed', changed: false })
  })

  /**
   * Consent that was withdrawn cannot be restored by clicking a link issued
   * before it was withdrawn. Re-subscribing starts from the form.
   */
  it('refuses to resurrect an unsubscribed address', () => {
    expect(() => resolveConfirmation({ status: 'unsubscribed' })).toThrow(SubscriptionError)
  })
})

describe('unsubscribing', () => {
  /**
   * A person trying to stop mail and being shown an error is the worst outcome
   * available, and the one that turns into a complaint. It never fails.
   */
  it.each(['pending', 'confirmed', 'unsubscribed'] as const)('succeeds from %s', (status) => {
    expect(resolveUnsubscribe({ status }).outcome).toBe('unsubscribed')
  })

  it('reports whether anything actually changed', () => {
    expect(resolveUnsubscribe({ status: 'confirmed' }).changed).toBe(true)
    expect(resolveUnsubscribe({ status: 'unsubscribed' }).changed).toBe(false)
  })
})

describe('the sign-up response discloses nothing about a third party', () => {
  /**
   * The same answer for new, already-pending, already-confirmed and malformed.
   * Distinguishing them would turn the endpoint into a way to ask "is this
   * address subscribed?" for any address a caller can type.
   */
  it('is phrased as what was done, not what was found', () => {
    expect(SIGNUP_RESPONSE).toMatch(/if that address/i)
    expect(SIGNUP_RESPONSE).not.toMatch(/already|exists|unknown|not found|invalid/i)
  })

  it('tells the reader the subscription is not active yet', () => {
    expect(SIGNUP_RESPONSE).toMatch(/click/i)
  })
})
