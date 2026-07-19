import { deriveRuleBasedComplianceAlerts, mergeComplianceAlerts } from './complianceAlerts'
import type { ComplianceAlert, ComplianceRule, FarmProfile, InventoryItem } from '../types'

/**
 * The compliance alerts the Operations Desk should see — the SAME view the
 * Compliance Watchtower builds (DDPComplianceWatchtower.tsx merges
 * `deriveRuleBasedComplianceAlerts(farms, inventory, rules)` with its stored
 * alerts). Rule-derived alerts come from ENFORCED rules only (that filtering
 * lives in deriveRuleBasedComplianceAlerts) and are unioned with the
 * persisted/stored alerts, deduplicated by id — a stored row (e.g. a resolved
 * or manually-edited one) overrides the matching auto row. Auto alerts are
 * DERIVED for display, never persisted.
 *
 * Returns null when the source failed, so the desk reports the gap rather than a
 * false all-clear. Pure, so the merge is unit-testable.
 */
export function resolveDeskComplianceAlerts(
  failed: boolean,
  farms: FarmProfile[],
  inventory: InventoryItem[],
  rules: ComplianceRule[],
  storedAlerts: ComplianceAlert[],
): ComplianceAlert[] | null {
  if (failed) return null
  return mergeComplianceAlerts(deriveRuleBasedComplianceAlerts(farms, inventory, rules), storedAlerts)
}
