import { describe, it, expect } from 'vitest'
import { validateFarmProfile, blockingIssues, FIELD_STEPS } from './farmProfileValidation'

/**
 * P1 / W10.1 — the farm onboarding wizard validated nothing, and neither does
 * the database: `public.farms` has ZERO CHECK constraints and three NOT NULL
 * columns, measured against production 2026-08-06. A farm could be submitted
 * with no name, no way to contact it, and 900% THC.
 */

/** A draft that passes, so each test can break exactly one thing. */
const valid = (overrides: Record<string, unknown> = {}) => ({
  tradingName: 'Green Valley Farm',
  province: 'Chiang Mai',
  primaryContact: 'Somchai',
  email: 'somchai@example.com',
  ...overrides,
})

const codes = (draft: Record<string, unknown>) => validateFarmProfile(draft).map((i) => i.code)

describe('a complete draft', () => {
  it('has nothing to report', () => {
    expect(validateFarmProfile(valid())).toEqual([])
  })
})

describe('what a farm record cannot be without', () => {
  it.each(['tradingName', 'province', 'primaryContact'])('requires %s', (field) => {
    expect(codes(valid({ [field]: '' }))).toContain('required')
  })

  it('treats whitespace as absent', () => {
    expect(codes(valid({ tradingName: '   ' }))).toContain('required')
  })

  it('requires at least one way to make contact', () => {
    expect(codes(valid({ email: '' }))).toContain('contact-required')
  })

  it.each(['email', 'mobileNumber', 'lineId'])('accepts %s alone as that contact', (field) => {
    const value = field === 'email' ? 'a@b.co' : field === 'mobileNumber' ? '+66 81 234 5678' : 'somchai-line'
    const draft = valid({ email: '', mobileNumber: '', lineId: '', [field]: value })
    expect(codes(draft)).not.toContain('contact-required')
  })
})

describe('formats, checked only once something is typed', () => {
  it('rejects an address that cannot receive mail', () => {
    for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '@nope.com']) {
      expect(codes(valid({ email: bad })), bad).toContain('email-invalid')
    }
  })

  it('accepts ordinary addresses, including the awkward ones', () => {
    for (const good of ['a@b.co', 'first.last+tag@sub.example.co.th', "o'brien@farm.th"]) {
      expect(codes(valid({ email: good })), good).not.toContain('email-invalid')
    }
  })

  it('accepts Thai and international mobile formats', () => {
    for (const good of ['+66812345678', '+66 81 234 5678', '081-234-5678', '(02) 123 4567']) {
      expect(codes(valid({ mobileNumber: good })), good).not.toContain('phone-invalid')
    }
  })

  it('rejects a number too short to dial, or that is not one', () => {
    for (const bad of ['12345', 'call me', '081 234 abcd']) {
      expect(codes(valid({ mobileNumber: bad })), bad).toContain('phone-invalid')
    }
  })

  it('does not complain about optional fields left empty', () => {
    expect(validateFarmProfile(valid({ mobileNumber: '', lineId: '', typicalThc: '' }))).toEqual([])
  })
})

describe('numbers, as the form itself invites them to be typed', () => {
  // Every numeric field prompts with its unit: 'e.g. 800 kg', 'e.g. 2000
  // kg/year', 'e.g. 0.1%'. Refusing those would block precisely the farmers who
  // followed the instructions — which an earlier version of this file did.
  it.each([
    ['qtyAvailableNow', '800 kg'],
    ['annualCapacity', '2000 kg/year'],
    ['avgYieldPerHarvest', '500 kg'],
    ['typicalThc', '22%'],
    ['typicalThc', '0.1%'],
    ['typicalCbd', '20–25%'],
    ['harvestsPerYear', '4 per year'],
  ])('accepts %s = %s', (field, value) => {
    expect(codes(valid({ [field]: value }))).toEqual([])
  })

  it('reads a range from its lower bound', () => {
    expect(codes(valid({ typicalThc: '20–25%' }))).toEqual([])
    expect(codes(valid({ typicalThc: '120–130%' }))).toContain('percent-out-of-range')
  })

  it('still rejects a value with no number in it at all', () => {
    expect(codes(valid({ annualCapacity: 'lots' }))).toContain('not-a-number')
    expect(codes(valid({ qtyAvailableNow: 'a few sacks' }))).toContain('not-a-number')
  })

  it('still rejects a negative quantity written with its unit', () => {
    expect(codes(valid({ qtyAvailableNow: '-5 kg' }))).toContain('negative')
  })
})

describe('numbers', () => {
  it('rejects text where a quantity belongs', () => {
    expect(codes(valid({ annualCapacity: 'lots' }))).toContain('not-a-number')
  })

  it('rejects a negative quantity', () => {
    expect(codes(valid({ qtyAvailableNow: '-5' }))).toContain('negative')
  })

  it('accepts zero and decimals', () => {
    expect(validateFarmProfile(valid({ qtyAvailableNow: '0', avgYieldPerHarvest: '12.5' }))).toEqual([])
  })

  it('bounds cannabinoid percentages the way inventory_batches bounds its own', () => {
    expect(codes(valid({ typicalThc: '900' }))).toContain('percent-out-of-range')
    expect(codes(valid({ typicalCbd: '-1' }))).toContain('percent-out-of-range')
    expect(codes(valid({ typicalThc: '18.5' }))).not.toContain('percent-out-of-range')
  })
})

describe('severity — what actually stops a submission', () => {
  it('warns, without blocking, when the cannabinoids do not add up', () => {
    const issues = validateFarmProfile(valid({ typicalThc: '70', typicalCbd: '45' }))
    expect(issues.map((i) => i.code)).toContain('cannabinoids-implausible')
    // A plausibility opinion must not stop a farm from onboarding.
    expect(blockingIssues(issues)).toEqual([])
  })

  it('blocks on a real error', () => {
    expect(blockingIssues(validateFarmProfile(valid({ tradingName: '' })))).toHaveLength(1)
  })
})

describe('telling the farmer where to go', () => {
  it('reports the wizard step for every issue', () => {
    const issues = validateFarmProfile({ typicalThc: '900' })
    expect(issues.length).toBeGreaterThan(0)
    for (const i of issues) expect(i.step).toBeGreaterThanOrEqual(1)
  })

  it('orders issues by step, so the farmer walks back once', () => {
    const issues = validateFarmProfile({ typicalThc: '900', tradingName: '', province: '' })
    const steps = issues.map((i) => i.step)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  it('places the every-field-blank case on the earliest step', () => {
    expect(validateFarmProfile({})[0]?.step).toBe(1)
  })

  it('knows a step for every field it can report on', () => {
    for (const field of Object.keys(FIELD_STEPS)) {
      expect(FIELD_STEPS[field]).toBeGreaterThanOrEqual(1)
    }
  })
})
