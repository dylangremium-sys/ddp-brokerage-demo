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

/**
 * The single canonical definition of "counts as human-approved/active" for a
 * rule status. Draft/suggested/paused/retired/rejected are never enforced.
 * Exported separately from isRuleEnforced so call sites that only have a bare
 * status value (e.g. a pending Supabase write) don't need to re-derive the
 * same condition independently.
 */
export function isEnforcedRuleStatus(status: ComplianceRuleStatus): boolean {
  return status === 'approved' || status === 'active'
}

export function isRuleEnforced(rule: ComplianceRule): boolean {
  return isEnforcedRuleStatus(rule.status)
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
