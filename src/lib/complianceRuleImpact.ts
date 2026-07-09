import type { ComplianceAlert, ComplianceRule, ComplianceRuleEntityType, ComplianceSeverity } from '../types'
import { isRuleEnforced } from './complianceRules'
import { SAFE_RULE_IMPACT_LABEL, type SafeRuleImpactLabel } from './complianceTerminology'

// Read-only join between human-approved/active compliance_rules and the
// compliance_alerts already raised against a specific entity. Never invents
// an alert and never upgrades a status — it can only surface an existing,
// unresolved, rule-driven concern as an additive signal alongside whatever
// the page's own evidence/risk logic already shows.

export interface ComplianceRuleImpact {
  hasImpact: true
  safeStatusLabel: SafeRuleImpactLabel
  ruleCode: string
  ruleTitle: string
  severity: ComplianceSeverity
  isBlocking: boolean
  reason: string
}

const UNRESOLVED_ALERT_STATUSES: ComplianceAlert['status'][] = ['open', 'in_review', 'blocked']

// Callers invoke getComplianceRuleImpact once per row in a table (Master
// Inventory, Missing Documents, Risk Register), all sharing the same `rules`
// array reference within a render. Cache the derived enforced-rule map per
// array reference so it's built once per render instead of once per row.
const enforcedRuleMapCache = new WeakMap<ComplianceRule[], Map<string, ComplianceRule>>()

function getEnforcedRuleMap(rules: ComplianceRule[]): Map<string, ComplianceRule> {
  const cached = enforcedRuleMapCache.get(rules)
  if (cached) return cached
  const map = new Map(rules.filter(isRuleEnforced).map(rule => [rule.id, rule]))
  enforcedRuleMapCache.set(rules, map)
  return map
}

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

  const enforcedRuleById = getEnforcedRuleMap(rules)
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
  const safeStatusLabel: SafeRuleImpactLabel =
    relevantAlert.status === 'blocked'
      ? SAFE_RULE_IMPACT_LABEL.blockedPendingLegalReview
      : rule.isBlocking
        ? SAFE_RULE_IMPACT_LABEL.missingEvidence
        : SAFE_RULE_IMPACT_LABEL.needsReview

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
