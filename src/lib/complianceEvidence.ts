import type { FarmProfile, InventoryItem } from '../types'

// Shared evidence-presence helpers used by both the rule-based alert deriver
// (complianceAlerts.ts) and the export-readiness scorer (complianceScoring.ts).
// Previously duplicated independently in both files — consolidated here so a
// future change to what counts as "evidence present" only needs to happen once.

export function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value)
}

export function hasFarmLicence(farm?: FarmProfile | null): boolean {
  if (!farm) return false
  return [
    farm.cultivationLicence,
    farm.processingLicence,
    farm.manufacturingLicence,
    farm.medicalCannabisLicence,
    farm.exportLicence,
    farm.importLicence,
  ].some(hasValue)
}

export function hasGacpOrGap(farm?: FarmProfile | null): boolean {
  if (!farm) return false
  return [farm.gacpCert, farm.gapCert].some(hasValue)
}

export function hasCoa(item: InventoryItem): boolean {
  return hasValue(item.coaStoragePath) || hasValue(item.certFileName) || item.coaAvailable === true
}

export function farmForItem(item: InventoryItem, farms: FarmProfile[]): FarmProfile | null {
  return farms.find(farm => farm.id === item.farmId || farm.tradingName === item.farmName || farm.legalBusinessName === item.farmName) ?? null
}
