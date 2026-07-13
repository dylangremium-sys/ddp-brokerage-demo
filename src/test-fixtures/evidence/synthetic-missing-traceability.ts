import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'
import type { EvidenceRequirementDefinition } from '../../lib/evidenceCompleteness'

// ─── SYNTHETIC FIXTURE — a missing traceability stage ───────────────────────
//
// Entirely fictional. A record set that includes a CoA and a licence but is
// MISSING the required traceability record. Paired with a requirement set so a
// completeness assessment reports the traceability requirement as 'missing'.

export const syntheticMissingTraceabilityRecords: EvidenceRecord[] = [
  {
    id: 'ev-mt-coa-001',
    evidenceType: 'coa',
    batchIdentifier: 'BATCH-SYN-7000',
    cultivar: 'Auroria Mist (fictional)',
    hasApprovedSpecification: true,
  },
  {
    id: 'ev-mt-licence-001',
    evidenceType: 'licence',
    claimedEntity: 'Northwind Botanicals (fictional)',
    linkedEntity: 'Northwind Botanicals (fictional)',
    expiryDate: '2027-09-01',
  },
]

// Requirement set for a batch: traceability is expected but absent above.
export const syntheticBatchRequirements: EvidenceRequirementDefinition[] = [
  { key: 'req-coa', label: 'Certificate of Analysis', satisfiedBy: 'coa' },
  { key: 'req-licence', label: 'Cultivation Licence', satisfiedBy: 'licence' },
  { key: 'req-traceability', label: 'Traceability Record', satisfiedBy: 'traceability_record' },
  { key: 'req-transport', label: 'Transport Record', satisfiedBy: 'transport_record', applicable: false },
]
