import type { ComplianceAlert, ComplianceRule, ComplianceRuleEntityType, ComplianceSeverity } from '../types'
import { isRuleEnforced } from './complianceRules'

// Read-only join between human-approved/active compliance_rules and the
// compliance_alerts already raised against a specific entity. Never invents
// an alert and never upgrades a status — it can only surface an existing,
// unresolved, rule-driven concern as an additive signal alongside whatever
// the page's own evidence/risk logic already shows.

export interface ComplianceRuleImpact {
  hasImpact: true
  safeStatusLabel: 'blocked pending legal review' | 'missing evidence' | 'needs review'
  ruleCode: string
  ruleTitle: string
  severity: ComplianceSeverity
  isBlocking: boolean
  reason: string
}

const UNRESOLVED_ALERT_STATUSES: ComplianceAlert['status'][] = ['open', 'in_review', 'blocked']

/**
 * Returns the compliance-rule impact for one entity, or null if no
 * approved/active rule has an unresolved alert against it. Draft, suggested,
 * paused, retired, and rejected rules are never considered (isRuleEnforced
 * is the only gate). Resolved/dismissed alerts are treated as cleared and
 * never surfaced here.
 */
export function getComplianceRuleImpact(
  entityType: ComplianceRuleEntityType,
  entityId: string | undefined | null,
  rules: ComplianceRule[],
  alerts: ComplianceAlert[],
): ComplianceRuleImpact | null {
  if (!entityId) return null

  const enforcedRuleById = new Map(rules.filter(isRuleEnforced).map(rule => [rule.id, rule]))
  if (enforcedRuleById.size === 0) return null

  const relevantAlert = alerts.find(alert =>
    alert.entityType === entityType &&
    alert.entityId === entityId &&
    !!alert.ruleId &&
    enforcedRuleById.has(alert.ruleId) &&
    UNRESOLVED_ALERT_STATUSES.includes(alert.status),
  )
  if (!relevantAlert) return null

  const rule = enforcedRuleById.get(relevantAlert.ruleId!)!
  const safeStatusLabel: ComplianceRuleImpact['safeStatusLabel'] =
    relevantAlert.status === 'blocked'
      ? 'blocked pending legal review'
      : rule.isBlocking
        ? 'missing evidence'
        : 'needs review'

  return {
    hasImpact: true,
    safeStatusLabel,
    ruleCode: rule.ruleCode,
    ruleTitle: rule.title,
    severity: rule.severity,
    isBlocking: rule.isBlocking,
    reason: relevantAlert.alertTitle,
  }
}
