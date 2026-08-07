import type { ComplianceAlert, ComplianceRule, ComplianceRuleEntityType, ComplianceSeverity, FarmProfile, InventoryItem, TestStatus } from '../types'
import { isRuleEnforcedNow } from './complianceRuleEnforcement'
import { hasValue, hasFarmLicence, hasGacpOrGap, hasCoa, farmForItem } from './complianceEvidence'

function isPastDate(value?: string): boolean {
  if (!value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now()
}

function isMissingTest(status?: TestStatus): boolean {
  return !status || status === 'not_tested'
}

function enforcedRuleMap(rules: ComplianceRule[]): Map<string, ComplianceRule> {
  const map = new Map<string, ComplianceRule>()
  for (const rule of rules) {
    if (isRuleEnforcedNow(rule)) map.set(rule.ruleCode, rule)
  }
  return map
}

function buildAlert(
  rule: ComplianceRule,
  entityType: ComplianceRuleEntityType,
  entityId: string,
  title: string,
  detail: string,
  severity?: ComplianceSeverity,
): ComplianceAlert {
  return {
    id: `auto-${rule.ruleCode.toLowerCase()}-${entityType}-${entityId}`,
    entityType,
    entityId,
    ruleId: rule.id,
    legalUpdateId: rule.sourceLegalUpdateId ?? null,
    alertTitle: title,
    alertDetail: detail,
    severity: severity ?? rule.severity,
    status: rule.isBlocking ? 'blocked' : 'open',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolutionNotes: null,
  }
}

export function deriveRuleBasedComplianceAlerts(
  farms: FarmProfile[],
  inventory: InventoryItem[],
  rules: ComplianceRule[],
): ComplianceAlert[] {
  const activeRules = enforcedRuleMap(rules)
  const alerts: ComplianceAlert[] = []

  for (const farm of farms) {
    const farmName = farm.tradingName || farm.legalBusinessName || farm.id
    const farmLicenceRule = activeRules.get('FARM_LICENSE_REQUIRED')
    if (farmLicenceRule && !hasFarmLicence(farm)) {
      alerts.push(buildAlert(
        farmLicenceRule,
        'farm',
        farm.id,
        'Farm licence evidence missing',
        `${farmName} does not have recorded cultivation, medical cannabis, processing, manufacturing, import, or export licence evidence. This is an evidence gap, not a legal conclusion.`,
      ))
    }

    const gapRule = activeRules.get('GACP_GAP_REQUIRED')
    if (gapRule && !hasGacpOrGap(farm)) {
      alerts.push(buildAlert(
        gapRule,
        'farm',
        farm.id,
        'GACP/GAP evidence missing',
        `${farmName} does not have recorded GACP or GAP evidence. Pharmaceutical-style review should remain incomplete until evidence is received and reviewed.`,
      ))
    }
  }

  for (const item of inventory) {
    const batchLabel = item.batchNumber || item.productName || item.id
    const farm = farmForItem(item, farms)
    const farmLabel = farm?.tradingName || item.farmName || 'Unlinked farm'

    const coaRule = activeRules.get('BATCH_COA_REQUIRED')
    if (coaRule && !hasCoa(item)) {
      alerts.push(buildAlert(
        coaRule,
        'batch',
        item.id,
        'COA missing for batch',
        `Batch ${batchLabel} from ${farmLabel} has no recorded COA evidence. Do not describe it as buyer-ready; request COA evidence first.`,
      ))
    }

    const expiryRule = activeRules.get('COA_NOT_EXPIRED')
    if (expiryRule && isPastDate(item.expiryDate)) {
      alerts.push(buildAlert(
        expiryRule,
        'coa',
        item.id,
        'COA or batch expiry date has passed',
        `Batch ${batchLabel} has an expiry date in the past. Export-readiness should not advance without a fresh COA or qualified review.`,
      ))
    }

    const batchMatchRule = activeRules.get('COA_BATCH_NUMBER_MATCH')
    if (batchMatchRule && hasCoa(item) && !hasValue(item.batchNumber)) {
      alerts.push(buildAlert(
        batchMatchRule,
        'coa',
        item.id,
        'COA batch match cannot be confirmed',
        `The inventory record has COA evidence but no recorded inventory batch number. COA-to-inventory matching cannot be completed from available data.`,
      ))
    }

    const heavyMetalsRule = activeRules.get('HEAVY_METALS_REQUIRED')
    if (heavyMetalsRule && isMissingTest(item.heavyMetalsStatus)) {
      alerts.push(buildAlert(
        heavyMetalsRule,
        'batch',
        item.id,
        'Heavy metals result missing',
        `Batch ${batchLabel} has no recorded heavy-metals result.`,
      ))
    }

    const pesticidesRule = activeRules.get('PESTICIDES_REQUIRED')
    if (pesticidesRule && isMissingTest(item.pesticidesStatus)) {
      alerts.push(buildAlert(
        pesticidesRule,
        'batch',
        item.id,
        'Pesticide result missing',
        `Batch ${batchLabel} has no recorded pesticide result.`,
      ))
    }

    const mycotoxinsRule = activeRules.get('MYCOTOXINS_REQUIRED')
    if (mycotoxinsRule && isMissingTest(item.mycotoxinsStatus)) {
      alerts.push(buildAlert(
        mycotoxinsRule,
        'batch',
        item.id,
        'Mycotoxin result missing',
        `Batch ${batchLabel} has no recorded mycotoxin result.`,
      ))
    }

    const microbiologyRule = activeRules.get('MICROBIOLOGY_REQUIRED')
    if (microbiologyRule && isMissingTest(item.microbialStatus)) {
      alerts.push(buildAlert(
        microbiologyRule,
        'batch',
        item.id,
        'Microbiology result missing',
        `Batch ${batchLabel} has no recorded microbiology result.`,
      ))
    }
  }

  const buyerRule = activeRules.get('BUYER_LICENSE_REQUIRED')
  if (buyerRule) {
    alerts.push(buildAlert(
      buyerRule,
      'buyer',
      'buyer-evidence-pending',
      'Buyer licence evidence not modelled yet',
      'The current MVP does not contain buyer licence evidence records. Buyer eligibility must remain incomplete until this evidence is uploaded, reviewed, and linked to a buyer record.',
    ))
  }

  const importRule = activeRules.get('IMPORT_PERMIT_REQUIRED')
  if (importRule) {
    alerts.push(buildAlert(
      importRule,
      'shipment',
      'shipment-import-permit-pending',
      'Import permit evidence not linked',
      'No shipment/import-permit evidence model is active in this MVP. Czech/EU-bound export-readiness must remain incomplete until permit evidence is captured and reviewed.',
    ))
  }

  const exportRule = activeRules.get('EXPORT_PERMIT_REQUIRED')
  if (exportRule) {
    alerts.push(buildAlert(
      exportRule,
      'shipment',
      'shipment-export-permit-pending',
      'Export permit evidence not linked',
      'No shipment/export-permit evidence model is active in this MVP. Export-readiness must remain incomplete until permit evidence is captured and reviewed.',
    ))
  }

  const humanReviewRule = activeRules.get('HUMAN_LEGAL_REVIEW_REQUIRED')
  if (humanReviewRule) {
    alerts.push(buildAlert(
      humanReviewRule,
      'document',
      'human-legal-review-pending',
      'Human legal/compliance review required',
      'The system can prepare evidence and risk summaries, but a qualified human must review before final export/import readiness decisions.',
    ))
  }

  const claimsRule = activeRules.get('PLATFORM_CLAIMS_HUMAN_APPROVAL')
  if (claimsRule) {
    alerts.push(buildAlert(
      claimsRule,
      'platform_claim',
      'platform-claims-review',
      'External compliance claims require review',
      'Any external claim implying certification, export approval, or pharmaceutical suitability requires human approval and supporting evidence before display.',
    ))
  }

  return alerts
}

export function mergeComplianceAlerts(autoAlerts: ComplianceAlert[], storedAlerts: ComplianceAlert[]): ComplianceAlert[] {
  const byId = new Map<string, ComplianceAlert>()
  for (const alert of autoAlerts) byId.set(alert.id, alert)
  for (const alert of storedAlerts) byId.set(alert.id, alert)
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
