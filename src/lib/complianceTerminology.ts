// Single source of truth for the safe, human-approval-respecting compliance
// status vocabulary shown on the Compliance Watchtower and Supply Ledger
// pages. Centralised so a future wording change only requires editing this
// one file — every consumer imports the labels rather than re-typing them.
//
// Never add a term here that implies legal/regulatory/pharmaceutical
// approval, export readiness, certification, or a quality/buyer guarantee.
// Only cautious, human-approval-respecting wording belongs in this file.

export const SAFE_RULE_IMPACT_LABEL = {
  blockedPendingLegalReview: 'blocked pending legal review',
  missingEvidence: 'missing evidence',
  needsReview: 'needs review',
} as const

export type SafeRuleImpactLabel =
  (typeof SAFE_RULE_IMPACT_LABEL)[keyof typeof SAFE_RULE_IMPACT_LABEL]

/** Shown when no approved/active rule has an unresolved alert against an entity. */
export const NO_RULE_IMPACT_LABEL = 'No rule impact'

/** CSS status-pill class for each safe rule-impact label. */
export const RULE_IMPACT_LABEL_CLASS: Record<SafeRuleImpactLabel, string> = {
  [SAFE_RULE_IMPACT_LABEL.blockedPendingLegalReview]: 'status-reject',
  [SAFE_RULE_IMPACT_LABEL.missingEvidence]: 'status-missing',
  [SAFE_RULE_IMPACT_LABEL.needsReview]: 'status-review-pending',
}
