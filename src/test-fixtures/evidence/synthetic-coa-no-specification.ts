import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'
import type { EvidenceAnalysisInput } from '../../lib/evidenceAiProvider'

// ─── SYNTHETIC FIXTURE — CoA with no approved specification ─────────────────
//
// Entirely fictional. A laboratory result that has no approved specification
// attached: deterministic detection must flag it (no determination can be made
// until a reviewer attaches one), and completeness must read it as incomplete.

export const syntheticCoaNoSpecificationRecord: EvidenceRecord = {
  id: 'ev-coa-nospec-001',
  evidenceType: 'coa',
  ownerType: 'laboratory',
  claimedEntity: 'Southbrook Growers (fictional)',
  linkedEntity: 'Southbrook Growers (fictional)',
  batchIdentifier: 'BATCH-SYN-0002',
  cultivar: 'Harbor Fog (fictional)',
  reportNumber: 'RPT-SYN-1001',
  reportedValue: 'thc:12.1%;cbd:0.2%',
  checksum: '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
  harvestDate: '2026-01-06',
  sampleDate: '2026-01-11',
  reportDate: '2026-01-19',
  hasApprovedSpecification: false,
}

export const syntheticCoaNoSpecificationInput: EvidenceAnalysisInput = {
  evidenceId: 'ev-coa-nospec-001',
  declaredType: 'coa',
  content: [
    'CERTIFICATE OF ANALYSIS (SYNTHETIC / FICTIONAL)',
    'Batch: BATCH-SYN-0002   Cultivar: Harbor Fog (fictional)',
    'Result: THC 12.1%, CBD 0.2%.',
    'NOTE: No approved specification is attached to this report.',
  ].join('\n'),
  metadata: { filename: 'synthetic-coa-nospec.pdf', pageCount: 1 },
}
