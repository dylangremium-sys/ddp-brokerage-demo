import type { ComplianceAlert, ComplianceEntityStatus, ComplianceSeverity, ExportReadinessStatus, FarmProfile, InventoryItem, TestStatus } from '../types'
import { hasValue, hasFarmLicence, hasGacpOrGap, hasCoa, farmForItem } from './complianceEvidence'

export interface ExportReadinessChecklistItem {
  key: string
  label: string
  passed: boolean
  detail: string
}

export interface ExportReadinessRecord {
  id: string
  farm: FarmProfile | null
  item: InventoryItem
  checklist: ExportReadinessChecklistItem[]
  entityStatus: ComplianceEntityStatus
}

function expiryValid(item: InventoryItem): boolean {
  if (!item.expiryDate) return false
  const date = new Date(item.expiryDate)
  return !Number.isNaN(date.getTime()) && date.getTime() >= Date.now()
}

function testPresent(status?: TestStatus): boolean {
  return Boolean(status && status !== 'not_tested')
}

function riskFromStatus(status: ExportReadinessStatus, blockingAlertCount: number): ComplianceSeverity {
  if (status === 'blocked' || blockingAlertCount > 0) return 'critical'
  if (status === 'not_ready' || status === 'missing_documents') return 'high'
  if (status === 'needs_compliance_review' || status === 'export_readiness_incomplete') return 'medium'
  return 'low'
}

export function deriveExportReadiness(
  farms: FarmProfile[],
  inventory: InventoryItem[],
  alerts: ComplianceAlert[],
): ExportReadinessRecord[] {
  const now = new Date().toISOString()

  return inventory.map(item => {
    const farm = farmForItem(item, farms)
    const entityAlerts = alerts.filter(alert => alert.entityId === item.id || (farm && alert.entityId === farm.id))
    const blockingAlertCount = entityAlerts.filter(alert => alert.status === 'blocked').length

    const checklist: ExportReadinessChecklistItem[] = [
      {
        key: 'farm_profile_complete',
        label: 'Farm profile complete',
        passed: Boolean(farm && farm.completionPct >= 90),
        detail: farm ? `${farm.completionPct}% profile completion` : 'No linked farm profile',
      },
      {
        key: 'farm_licence_present',
        label: 'Farm licence present',
        passed: hasFarmLicence(farm),
        detail: 'Licence evidence must be reviewed before it is treated as verified.',
      },
      {
        key: 'gacp_gap_present',
        label: 'GACP/GAP evidence present',
        passed: hasGacpOrGap(farm),
        detail: 'Accepted evidence requires human document review.',
      },
      {
        key: 'coa_present',
        label: 'COA present',
        passed: hasCoa(item),
        detail: item.certFileName || (item.coaStoragePath ? 'COA stored in document storage' : 'No COA evidence recorded'),
      },
      {
        key: 'coa_expiry_valid',
        label: 'COA expiry valid',
        passed: expiryValid(item),
        detail: item.expiryDate ? `Expiry: ${item.expiryDate}` : 'No expiry date recorded',
      },
      {
        key: 'coa_batch_number_matches',
        label: 'COA batch number matches inventory batch',
        passed: hasCoa(item) && hasValue(item.batchNumber),
        detail: hasValue(item.batchNumber) ? `Inventory batch: ${item.batchNumber}` : 'Inventory batch number missing or not matchable',
      },
      {
        key: 'potency_values_present',
        label: 'Potency values present',
        passed: Number(item.thcPct) > 0 || Number(item.cbdPct) > 0,
        detail: `THC ${item.thcPct || 0}% / CBD ${item.cbdPct || 0}% as recorded`,
      },
      {
        key: 'heavy_metals_tested',
        label: 'Heavy metals tested',
        passed: testPresent(item.heavyMetalsStatus),
        detail: item.heavyMetalsStatus || 'Missing',
      },
      {
        key: 'pesticides_tested',
        label: 'Pesticides tested',
        passed: testPresent(item.pesticidesStatus),
        detail: item.pesticidesStatus || 'Missing',
      },
      {
        key: 'mycotoxins_tested',
        label: 'Mycotoxins tested',
        passed: testPresent(item.mycotoxinsStatus),
        detail: item.mycotoxinsStatus || 'Missing',
      },
      {
        key: 'microbiology_tested',
        label: 'Microbiology tested',
        passed: testPresent(item.microbialStatus),
        detail: item.microbialStatus || 'Missing',
      },
      {
        key: 'buyer_licence_present',
        label: 'Buyer licence present',
        passed: false,
        detail: 'Buyer evidence model not active in this MVP.',
      },
      {
        key: 'import_permit_present',
        label: 'Import permit evidence present if applicable',
        passed: false,
        detail: 'Shipment/import permit evidence model not active in this MVP.',
      },
      {
        key: 'export_permit_present',
        label: 'Export permit evidence present if applicable',
        passed: false,
        detail: 'Shipment/export permit evidence model not active in this MVP.',
      },
      {
        key: 'chain_of_custody_present',
        label: 'Chain-of-custody evidence present',
        passed: false,
        detail: 'Chain-of-custody evidence model not active in this MVP.',
      },
      {
        key: 'human_compliance_review',
        label: 'Human compliance review status',
        passed: false,
        detail: 'Human approval must be recorded before final readiness advances.',
      },
    ]

    const missingRequirements = checklist.filter(check => !check.passed).map(check => check.label)
    const hasFailedLab = [item.heavyMetalsStatus, item.pesticidesStatus, item.mycotoxinsStatus, item.microbialStatus].includes('fail')
    const coreEvidenceReady = hasFarmLicence(farm) && hasCoa(item) && hasValue(item.batchNumber)
    const labPanelPresent = testPresent(item.heavyMetalsStatus) && testPresent(item.pesticidesStatus) && testPresent(item.mycotoxinsStatus) && testPresent(item.microbialStatus)

    let readinessStatus: ExportReadinessStatus
    if (hasFailedLab || blockingAlertCount > 0) readinessStatus = 'blocked'
    else if (!coreEvidenceReady) readinessStatus = 'missing_documents'
    else if (!labPanelPresent) readinessStatus = 'needs_compliance_review'
    else if (missingRequirements.includes('Import permit evidence present if applicable') || missingRequirements.includes('Export permit evidence present if applicable')) readinessStatus = 'export_readiness_incomplete'
    else readinessStatus = 'buyer_ready_for_discussion'

    const entityStatus: ComplianceEntityStatus = {
      id: `status-batch-${item.id}`,
      entityType: 'batch',
      entityId: item.id,
      readinessStatus,
      riskLevel: riskFromStatus(readinessStatus, blockingAlertCount),
      missingRequirements,
      blockingAlertCount,
      lastEvaluatedAt: now,
      createdAt: now,
      updatedAt: now,
    }

    return {
      id: item.id,
      farm,
      item,
      checklist,
      entityStatus,
    }
  })
}
