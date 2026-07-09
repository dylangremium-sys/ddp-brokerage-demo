import { describe, expect, it } from 'vitest'
import { hasValue, hasFarmLicence, hasGacpOrGap, hasCoa, farmForItem } from './complianceEvidence'
import { makeFarm, makeInventoryItem } from './testFixtures'

describe('complianceEvidence — shared evidence-presence helpers', () => {
  it('hasValue treats empty/whitespace strings and falsy values as absent', () => {
    expect(hasValue('')).toBe(false)
    expect(hasValue('   ')).toBe(false)
    expect(hasValue(undefined)).toBe(false)
    expect(hasValue(null)).toBe(false)
    expect(hasValue(false)).toBe(false)
    expect(hasValue('CULT-123')).toBe(true)
    expect(hasValue(true)).toBe(true)
  })

  it('hasFarmLicence is false for a missing farm and for a farm with no licence evidence', () => {
    expect(hasFarmLicence(null)).toBe(false)
    expect(hasFarmLicence(undefined)).toBe(false)
    expect(hasFarmLicence(makeFarm({ cultivationLicence: '', processingLicence: '', manufacturingLicence: '', medicalCannabisLicence: '', exportLicence: '', importLicence: '' }))).toBe(false)
  })

  it('hasFarmLicence is true when any one licence field is present', () => {
    expect(hasFarmLicence(makeFarm({ exportLicence: 'EXP-1' }))).toBe(true)
  })

  it('hasGacpOrGap requires at least one of gacpCert/gapCert', () => {
    expect(hasGacpOrGap(makeFarm({ gacpCert: '', gapCert: '' }))).toBe(false)
    expect(hasGacpOrGap(makeFarm({ gapCert: 'GAP-1' }))).toBe(true)
  })

  it('hasCoa is true if storage path, cert filename, or coaAvailable flag is set', () => {
    expect(hasCoa(makeInventoryItem({ coaStoragePath: undefined, certFileName: '', coaAvailable: false }))).toBe(false)
    expect(hasCoa(makeInventoryItem({ coaStoragePath: 'path/to/coa.pdf' }))).toBe(true)
    expect(hasCoa(makeInventoryItem({ certFileName: 'coa.pdf' }))).toBe(true)
    expect(hasCoa(makeInventoryItem({ coaAvailable: true }))).toBe(true)
  })

  it('farmForItem matches by farmId first, then tradingName, then legalBusinessName', () => {
    const farm = makeFarm({ id: 'farm-42', tradingName: 'Alpha Farm', legalBusinessName: 'Alpha Co Ltd' })
    expect(farmForItem(makeInventoryItem({ farmId: 'farm-42' }), [farm])?.id).toBe('farm-42')
    expect(farmForItem(makeInventoryItem({ farmId: undefined, farmName: 'Alpha Farm' }), [farm])?.id).toBe('farm-42')
    expect(farmForItem(makeInventoryItem({ farmId: undefined, farmName: 'Unknown Farm' }), [farm])).toBeNull()
  })
})
