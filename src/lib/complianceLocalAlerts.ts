import type { ComplianceAlert, ComplianceRule } from '../types'
import { createBaselineComplianceRules } from './complianceRules'

/**
 * The single localStorage key for manually-stored demo compliance alerts.
 *
 * DEMO MODE ONLY. In Supabase mode alerts come from the server and this store is
 * never an authority. The Compliance Watchtower writes manual alerts to this key,
 * and the App hydrates the Operations Desk's compliance queue from the same key
 * in demo — so both read one source, never a duplicate.
 */
export const COMPLIANCE_ALERTS_STORAGE_KEY = 'ddp_compliance_alerts'

/**
 * Reads the stored demo compliance alerts with the same safe-parse-or-empty
 * fallback the Watchtower uses, so malformed local data degrades to [] rather
 * than throwing. Returns a genuine [] when nothing is stored.
 */
export function loadStoredComplianceAlerts(): ComplianceAlert[] {
  try {
    const raw = localStorage.getItem(COMPLIANCE_ALERTS_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ComplianceAlert[]) : []
  } catch {
    return []
  }
}

/**
 * The single localStorage key for the demo's MUTABLE compliance rule list.
 *
 * DEMO MODE ONLY. The Compliance Watchtower reads and writes its rules here (an
 * operator can approve/activate a rule), and the Operations Desk derives its
 * rule-based alerts from the same list — so an enforced demo rule is reflected on
 * both, never diverging. In Supabase mode rules come from the server and this
 * store is not an authority.
 */
export const COMPLIANCE_RULES_STORAGE_KEY = 'ddp_compliance_rules'

/**
 * Reads the stored demo compliance rules. Falls back to the baseline rule set
 * only when there is no valid stored list — nothing stored, or malformed/non-
 * array data — so a corrupt store degrades safely rather than throwing. A
 * genuinely stored list (including an empty one) is returned as-is, matching the
 * Watchtower's own `loadStored(rules, baseline)` behaviour.
 */
export function loadStoredComplianceRules(): ComplianceRule[] {
  try {
    const raw = localStorage.getItem(COMPLIANCE_RULES_STORAGE_KEY)
    if (!raw) return createBaselineComplianceRules()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ComplianceRule[]) : createBaselineComplianceRules()
  } catch {
    return createBaselineComplianceRules()
  }
}
