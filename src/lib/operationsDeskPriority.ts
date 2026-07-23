import type { ComplianceSeverity, EvidenceStatus, RiskSeverity } from '../types'

/**
 * Operations Desk priority classifier.
 *
 * DISPLAY ONLY. Priority is a presentation projection computed fresh on every
 * render — it is never persisted, never written back to any record, and carries
 * no legal or compliance meaning. No column, table or migration backs it.
 *
 * The classifier deliberately takes no age/date input: an item is never
 * critical merely because it is old. Ranking is driven only by states that
 * existing authoritative logic already treats as blocking:
 *
 *  - `rejected` / `expired` evidence is what procurementControl's own buyer
 *    gate counts as a blocking requirement (blockerRequirements), and
 *  - `blocker` risk severity is deriveAutoRisks' own top severity, assigned
 *    only when a COA test result is an actual `fail`.
 *
 * Anything not matching a known critical/high signal falls through to
 * 'normal' — the classifier never escalates on an unrecognised input.
 */
export type OperationsDeskPriority = 'critical' | 'high' | 'normal'

export const OPERATIONS_DESK_PRIORITIES: OperationsDeskPriority[] = ['critical', 'high', 'normal']

/** Lower rank sorts first. */
export const PRIORITY_RANK: Record<OperationsDeskPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
}

export const PRIORITY_LABEL: Record<OperationsDeskPriority, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
}

/**
 * The states that feed the classification. Every field is optional because
 * each queue only knows about its own signals; an empty signal object is a
 * valid input and classifies as 'normal'.
 */
export interface OperationsDeskPrioritySignal {
  /** Evidence state taken from an authoritative derivation, never from a label. */
  evidenceStatus?: EvidenceStatus
  /** Severity from deriveAutoRisks / applyRiskOverrides. */
  riskSeverity?: RiskSeverity
  /** Severity from a stored ComplianceAlert. */
  complianceSeverity?: ComplianceSeverity
  /** A record is sitting in a queue waiting for a human decision. */
  awaitingHumanReview?: boolean
}

export function classifyOperationsDeskPriority(
  signal: OperationsDeskPrioritySignal,
): OperationsDeskPriority {
  // ── Critical: an existing rule already treats this state as blocking ──────
  if (signal.riskSeverity === 'blocker') return 'critical'
  if (signal.evidenceStatus === 'rejected' || signal.evidenceStatus === 'expired') return 'critical'
  if (signal.complianceSeverity === 'critical') return 'critical'

  // ── High: awaiting action, or required evidence absent ────────────────────
  if (signal.evidenceStatus === 'missing') return 'high'
  if (signal.riskSeverity === 'high') return 'high'
  if (signal.complianceSeverity === 'high') return 'high'
  if (signal.awaitingHumanReview === true) return 'high'

  // ── Normal: routine queue work, incomplete onboarding, follow-up ──────────
  return 'normal'
}
