import type { ComplianceAlert } from '../types'

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
