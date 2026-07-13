import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'

// ─── SYNTHETIC FIXTURE — one batch identifier, several cultivars ────────────
//
// Entirely fictional. Two evidence items share a single batch identifier but
// name DIFFERENT cultivars — a deterministic conflict. A third item shares the
// same batch AND the same cultivar as the first, which must NOT create a false
// conflict.

export const syntheticSharedBatchRecords: EvidenceRecord[] = [
  {
    id: 'ev-batch-share-a',
    evidenceType: 'batch_record',
    batchIdentifier: 'BATCH-SYN-9000',
    cultivar: 'Auroria Mist (fictional)',
  },
  {
    id: 'ev-batch-share-b',
    evidenceType: 'batch_record',
    batchIdentifier: 'BATCH-SYN-9000',
    cultivar: 'Northern Ember (fictional)',
  },
]

// Control: same batch, same cultivar — no conflict expected.
export const syntheticSameBatchSameCultivarRecords: EvidenceRecord[] = [
  {
    id: 'ev-batch-same-a',
    evidenceType: 'batch_record',
    batchIdentifier: 'BATCH-SYN-9100',
    cultivar: 'Auroria Mist (fictional)',
  },
  {
    id: 'ev-batch-same-b',
    evidenceType: 'coa',
    batchIdentifier: 'BATCH-SYN-9100',
    cultivar: 'Auroria Mist (fictional)',
  },
]
