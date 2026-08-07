import { describe, it, expect } from 'vitest'
import { formatBatchPrice, NO_PRICE } from './formatPrice'

/**
 * P1 — row B-P3, "Price with explicit currency".
 *
 * Every one of the five places a batch price is rendered hardcoded the baht
 * sign, and two hardcoded the literal "THB/kg". Production accepts THB, USD
 * and EUR, and a batch now records which one it is — so a USD listing showed
 * as baht on every screen, a roughly thirty-fold misstatement with nothing to
 * hint at it.
 *
 * Separately, the guard against an unpriced batch was applied on some screens
 * and not others: the buyer pack rendered "—", while the farmer's own stock
 * list and status page rendered "฿0/kg" — telling a farm its crop was priced
 * at zero.
 */

describe('the currency shown is the currency stored', () => {
  it.each([
    ['THB', '฿45,000 THB/kg'],
    ['USD', '$45,000 USD/kg'],
    ['EUR', '€45,000 EUR/kg'],
  ] as const)('renders %s correctly', (currency, expected) => {
    expect(formatBatchPrice(45000, currency)).toBe(expected)
  })

  it('never shows baht for a batch priced in something else', () => {
    // The defect this replaces would have rendered exactly that.
    expect(formatBatchPrice(1200, 'USD')).not.toContain('฿')
    expect(formatBatchPrice(1200, 'USD')).not.toContain('THB')
  })

  it('falls back to THB only when the batch records no currency', () => {
    expect(formatBatchPrice(1000, null)).toBe('฿1,000 THB/kg')
    expect(formatBatchPrice(1000, undefined)).toBe('฿1,000 THB/kg')
  })
})

describe('a batch with no price is not a batch priced at zero', () => {
  it.each([0, null, undefined, NaN, -1])('renders %s as an em dash', (value) => {
    expect(formatBatchPrice(value as number, 'THB')).toBe(NO_PRICE)
  })

  it('never renders a zero price as a real figure', () => {
    // parseFloat('') || 0 makes 0 the value of "the farmer entered nothing".
    // "฿0/kg" answers the question wrongly; "—" leaves it open.
    expect(formatBatchPrice(0, 'THB')).not.toContain('0')
  })
})

describe('units', () => {
  it('uses the batch unit when given one', () => {
    expect(formatBatchPrice(500, 'THB', 'g')).toBe('฿500 THB/g')
  })

  it('defaults to kg', () => {
    expect(formatBatchPrice(500, 'THB')).toContain('/kg')
  })
})
