import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'

// ─── SYNTHETIC FIXTURE — expired certificate ────────────────────────────────
//
// Entirely fictional. A certificate whose expiry date is before the relevant
// evaluation date. Deterministic expiry detection requires an explicit asOf
// date (see EVIDENCE_ASOF_DATE) so results never depend on the wall clock.

export const EVIDENCE_ASOF_DATE = '2026-07-01'

export const syntheticExpiredCertificateRecord: EvidenceRecord = {
  id: 'ev-cert-expired-001',
  evidenceType: 'certificate',
  ownerType: 'certification_body',
  claimedEntity: 'Northwind Botanicals (fictional)',
  linkedEntity: 'Northwind Botanicals (fictional)',
  issueDate: '2024-03-01',
  expiryDate: '2026-03-01', // before EVIDENCE_ASOF_DATE → expired
}

// A certificate still valid as of EVIDENCE_ASOF_DATE — control, no finding.
export const syntheticValidCertificateRecord: EvidenceRecord = {
  id: 'ev-cert-valid-001',
  evidenceType: 'certificate',
  ownerType: 'certification_body',
  claimedEntity: 'Northwind Botanicals (fictional)',
  linkedEntity: 'Northwind Botanicals (fictional)',
  issueDate: '2025-09-01',
  expiryDate: '2027-09-01', // after EVIDENCE_ASOF_DATE → valid
}
