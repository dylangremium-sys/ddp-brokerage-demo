import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'
import type { EvidenceAnalysisInput } from '../../lib/evidenceAiProvider'

// ─── SYNTHETIC FIXTURE — licence belonging to a third party ─────────────────
//
// Entirely fictional. A licence whose claimed holder differs from the entity it
// is linked to in the system of record — a deterministic ownership mismatch.

export const syntheticThirdPartyLicenceRecord: EvidenceRecord = {
  id: 'ev-licence-thirdparty-001',
  evidenceType: 'licence',
  ownerType: 'third_party',
  claimedEntity: 'Evergreen Holdings Ltd (fictional)',
  linkedEntity: 'Northwind Botanicals (fictional)',
  issueDate: '2025-06-01',
  expiryDate: '2027-06-01',
}

export const syntheticThirdPartyLicenceInput: EvidenceAnalysisInput = {
  evidenceId: 'ev-licence-thirdparty-001',
  declaredType: 'licence',
  declaredOwnerType: 'third_party',
  content: [
    'CULTIVATION LICENCE (SYNTHETIC / FICTIONAL)',
    'Licence holder: Evergreen Holdings Ltd (fictional)',
    'Licence number: SYN-LIC-0001',
    'Valid: 2025-06-01 to 2027-06-01',
    'NOTE: submitted in support of a different supplier, Northwind Botanicals (fictional).',
  ].join('\n'),
  metadata: { filename: 'synthetic-third-party-licence.pdf', pageCount: 1 },
}
