import type {
  ComplianceRule,
  ComplianceRuleEntityType,
  ComplianceRuleStatus,
  ComplianceSeverity,
  ExportReadinessStatus,
  LegalUpdateAffectedArea,
  LegalUpdateStatus,
} from '../types.js'

export const AFFECTED_AREA_OPTIONS: LegalUpdateAffectedArea[] = [
  'Thai cultivation',
  'Thai cannabis control',
  'Thai export',
  'Czech import',
  'EU pharmaceutical standards',
  'GMP/GACP/GDP',
  'Data protection',
  'Buyer licensing',
  'Farm licensing',
  'COA/testing',
  'Chain of custody',
  'Marketing/claims',
  'Other',
]

export const LEGAL_UPDATE_STATUSES: LegalUpdateStatus[] = [
  'new',
  'needs_review',
  'reviewed',
  'rule_suggested',
  'sent_to_legal',
  'archived',
  'rejected',
]

export const COMPLIANCE_SEVERITIES: ComplianceSeverity[] = ['info', 'low', 'medium', 'high', 'critical']

export const RULE_ENTITY_TYPES: ComplianceRuleEntityType[] = [
  'farm',
  'batch',
  'coa',
  'buyer',
  'document',
  'shipment',
  'platform_claim',
  'data_protection',
]

export const RULE_STATUSES: ComplianceRuleStatus[] = [
  'draft',
  'suggested',
  'approved',
  'active',
  'paused',
  'retired',
  'rejected',
]

export const EXPORT_READINESS_STATUSES: ExportReadinessStatus[] = [
  'not_ready',
  'missing_documents',
  'needs_compliance_review',
  'buyer_ready_for_discussion',
  'export_readiness_incomplete',
  'ready_for_legal_review',
  'human_approved',
  'blocked',
]

export function formatComplianceLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

// ── TWO QUESTIONS, TWO PREDICATES ────────────────────────────────────────────
//
// There used to be one function here — `isEnforcedRuleStatus` — whose docblock
// called it "the single canonical definition". It was answering two different
// questions for two different sets of callers:
//
//   "has a human blessed this rule?"   → stamping approved_by / approved_at
//   "does this rule gate work now?"    → the buyer-pack gate, rule impact,
//                                        alert derivation, rule linking
//
// Those are not the same question, and a caller could not tell which one it had
// asked. 41_EFFECTIVE_DATED_RULESETS_HARDENING.sql had already reached this
// conclusion on the database side and said so plainly: "Two functions rather
// than one flag, because a single function serving both questions is a function
// whose callers cannot tell which one they asked." This is the same split,
// applied to the application.
//
// The enforcement question additionally depends on the EFFECTIVE WINDOW, which
// no predicate here can see from a bare status — so it lives with the rest of
// the enforcement logic, in complianceRuleEnforcement.ts (`isRuleEnforcedNow`).

/**
 * "A human has blessed this rule." True for `approved` and `active`; false for
 * draft, suggested, paused, retired and rejected.
 *
 * Use this for APPROVAL BOOKKEEPING — stamping `approved_by`/`approved_at`, or
 * counting how much review work has been signed off. It says nothing about
 * whether the rule is currently gating anything, because a blessed rule can sit
 * outside its effective window, and `approved` may or may not mean "switched
 * on" (see the OPEN QUESTION in complianceRuleEnforcement.ts).
 *
 * Takes a bare status so a pending Supabase write can ask without a full row.
 */
export function isHumanApprovedRuleStatus(status: ComplianceRuleStatus): boolean {
  return status === 'approved' || status === 'active'
}

/** Row-level form of {@link isHumanApprovedRuleStatus}. */
export function isRuleHumanApproved(rule: ComplianceRule): boolean {
  return isHumanApprovedRuleStatus(rule.status)
}

export function createBaselineComplianceRules(now = new Date().toISOString()): ComplianceRule[] {
  const base: Array<Omit<ComplianceRule, 'id' | 'createdAt' | 'updatedAt'>> = [
    {
      ruleCode: 'BATCH_COA_REQUIRED',
      title: 'COA required before buyer-readiness discussion',
      description: 'A batch should not advance to buyer-ready-for-discussion unless a COA is present as a received document or recorded COA evidence.',
      jurisdiction: null,
      entityType: 'batch',
      severity: 'high',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'COA_NOT_EXPIRED',
      title: 'COA expiry must be valid',
      description: 'A batch should not be marked export-review-ready if the recorded COA or batch expiry date has passed.',
      jurisdiction: null,
      entityType: 'coa',
      severity: 'high',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'COA_BATCH_NUMBER_MATCH',
      title: 'COA batch number must match inventory batch',
      description: 'A COA should reference the same batch number as the inventory record. If a separate COA batch reference is unavailable, the match remains unconfirmed.',
      jurisdiction: null,
      entityType: 'coa',
      severity: 'medium',
      isBlocking: false,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'FARM_LICENSE_REQUIRED',
      title: 'Farm licence evidence required',
      description: 'A farm cannot progress toward export-readiness where cultivation, medical cannabis, processing, manufacturing, or export licence evidence is missing.',
      jurisdiction: 'Thailand',
      entityType: 'farm',
      severity: 'high',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'GACP_GAP_REQUIRED',
      title: 'GACP/GAP evidence required for pharmaceutical-style review',
      description: 'GACP, GAP, or equivalent cultivation evidence should be present before pharmaceutical-style readiness review.',
      jurisdiction: null,
      entityType: 'farm',
      severity: 'medium',
      isBlocking: false,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'BUYER_LICENSE_REQUIRED',
      title: 'Buyer licence evidence required',
      description: 'Buyer eligibility should remain incomplete unless buyer licence evidence is present and reviewed.',
      jurisdiction: 'Buyer jurisdiction',
      entityType: 'buyer',
      severity: 'high',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'HEAVY_METALS_REQUIRED',
      title: 'Heavy metals testing required',
      description: 'Missing heavy-metals testing should trigger a compliance alert for the batch.',
      jurisdiction: null,
      entityType: 'batch',
      severity: 'medium',
      isBlocking: false,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'PESTICIDES_REQUIRED',
      title: 'Pesticide testing required',
      description: 'Missing pesticide testing should trigger a compliance alert for the batch.',
      jurisdiction: null,
      entityType: 'batch',
      severity: 'medium',
      isBlocking: false,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'MYCOTOXINS_REQUIRED',
      title: 'Mycotoxin testing required',
      description: 'Missing mycotoxin testing should trigger a compliance alert for the batch.',
      jurisdiction: null,
      entityType: 'batch',
      severity: 'medium',
      isBlocking: false,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'MICROBIOLOGY_REQUIRED',
      title: 'Microbiology testing required',
      description: 'Missing microbiology testing should trigger a compliance alert for the batch.',
      jurisdiction: null,
      entityType: 'batch',
      severity: 'medium',
      isBlocking: false,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'IMPORT_PERMIT_REQUIRED',
      title: 'Import permit evidence required where applicable',
      description: 'Czech-bound or EU-bound shipment readiness cannot advance without import permit evidence where applicable.',
      jurisdiction: 'Czech Republic / EU',
      entityType: 'shipment',
      severity: 'high',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'EXPORT_PERMIT_REQUIRED',
      title: 'Export permit evidence required where applicable',
      description: 'Export-readiness cannot advance without export permit evidence where applicable.',
      jurisdiction: 'Thailand',
      entityType: 'shipment',
      severity: 'high',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'HUMAN_LEGAL_REVIEW_REQUIRED',
      title: 'Human legal/compliance review required',
      description: 'Final export/import readiness requires qualified human legal or compliance review before any operational status advances beyond review-ready.',
      jurisdiction: null,
      entityType: 'document',
      severity: 'critical',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      ruleCode: 'PLATFORM_CLAIMS_HUMAN_APPROVAL',
      title: 'Pharmaceutical-facing claims require human approval',
      description: 'Claims such as pharmaceutical suitability, export-readiness, or certification must not display externally unless the exact supporting evidence and human approval exist.',
      jurisdiction: null,
      entityType: 'platform_claim',
      severity: 'critical',
      isBlocking: true,
      status: 'suggested',
      sourceLegalUpdateId: null,
      approvedBy: null,
      approvedAt: null,
    },
  ]

  return base.map(rule => ({
    ...rule,
    id: `baseline-${rule.ruleCode.toLowerCase().replace(/_/g, '-')}`,
    createdAt: now,
    updatedAt: now,
  }))
}

// ── REVIEW DECISIONS → STATUSES ──────────────────────────────────────────────
//
// These two mappings existed as four copies of a nested ternary, inline in
// DDPComplianceWatchtower.tsx: one pair on the Supabase path and an identical
// pair on the demo/localStorage path. The `decision` they switched on was typed
// `string`, so nothing forced a branch to exist for every decision — and one did
// not. `approve_rule` was never named, fell through to the `'reviewed'` default,
// and left the update in a WEAKER state than `create_rule` produced, while the
// rule it created was inserted as `active`. The strongest decision an operator
// could take looked like the mildest afterwards.
//
// Four copies is also why fixing it in one place would not have fixed it: the
// demo path would have kept the old behaviour, exactly the "half a gate" failure
// this repository has hit before.
//
// Both functions take the union rather than `string`, and switch exhaustively,
// so adding a decision to the union without deciding its statuses is a COMPILE
// error rather than a silent fall-through to 'reviewed'.

/** Every decision an administrator can record against a compliance review. */
export type ComplianceReviewDecision =
  | 'informational'
  | 'create_rule'
  | 'approve_rule'
  | 'send_to_legal'
  | 'reject'
  | 'archive'

export const REVIEW_DECISIONS: ComplianceReviewDecision[] = [
  'informational',
  'create_rule',
  'approve_rule',
  'send_to_legal',
  'reject',
  'archive',
]

export function isComplianceReviewDecision(value: string): value is ComplianceReviewDecision {
  return (REVIEW_DECISIONS as string[]).includes(value)
}

/**
 * The status the REVIEW row takes. Unchanged behaviour, extracted from two
 * identical inline ternaries.
 */
export function reviewStatusForDecision(
  decision: ComplianceReviewDecision,
): 'reviewed' | 'sent_to_legal' | 'rejected' | 'archived' {
  switch (decision) {
    case 'send_to_legal': return 'sent_to_legal'
    case 'reject':        return 'rejected'
    case 'archive':       return 'archived'
    case 'informational':
    case 'create_rule':
    case 'approve_rule':  return 'reviewed'
  }
}

/**
 * The status the LEGAL UPDATE takes.
 *
 * `approve_rule` maps to `rule_suggested`, alongside `create_rule`. Both produce
 * a rule from this update, so both must advance it past `reviewed`; before this
 * function existed only `create_rule` did. `rule_suggested` is the strongest
 * status the CHECK vocabulary offers for "a rule came out of this" — there is no
 * `rule_approved` — so approve and create share it rather than approve being
 * silently demoted below create.
 */
export function legalUpdateStatusForDecision(
  decision: ComplianceReviewDecision,
): LegalUpdateStatus {
  switch (decision) {
    case 'send_to_legal': return 'sent_to_legal'
    case 'reject':        return 'rejected'
    case 'archive':       return 'archived'
    case 'create_rule':
    case 'approve_rule':  return 'rule_suggested'
    case 'informational': return 'reviewed'
  }
}
