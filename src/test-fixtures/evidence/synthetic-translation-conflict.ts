import type { EvidenceRecord } from '../../lib/evidenceConflictDetection'
import type { EvidenceAnalysisInput } from '../../lib/evidenceAiProvider'

// ─── SYNTHETIC FIXTURE — translation with no source-language original ────────
//
// Entirely fictional. A translated certificate submitted with no linked
// source-language original — a deterministic conflict (the original cannot be
// checked). The untrusted content also models a translated TITLE that appears
// to disagree with the translated BODY; that discrepancy is for a human
// reviewer to weigh — the deterministic check here is purely "translation
// without original".

export const syntheticTranslationWithoutOriginalRecord: EvidenceRecord = {
  id: 'ev-translation-001',
  evidenceType: 'certificate',
  ownerType: 'certification_body',
  isTranslation: true,
  sourceLanguageEvidenceId: null, // no original linked or present
  claimedEntity: 'Northwind Botanicals (fictional)',
  linkedEntity: 'Northwind Botanicals (fictional)',
}

// Control: a translation WITH its original present in the record set.
export const syntheticTranslationWithOriginalRecords: EvidenceRecord[] = [
  {
    id: 'ev-translation-original-002',
    evidenceType: 'certificate',
    isTranslation: false,
  },
  {
    id: 'ev-translation-002',
    evidenceType: 'certificate',
    isTranslation: true,
    sourceLanguageEvidenceId: 'ev-translation-original-002',
  },
]

export const syntheticTranslationConflictInput: EvidenceAnalysisInput = {
  evidenceId: 'ev-translation-001',
  declaredType: 'certificate',
  content: [
    'CERTIFICATE (TRANSLATED — SYNTHETIC / FICTIONAL)',
    'Title (translated): "Organic Cultivation Certificate"',
    'Body (translated): describes a storage-handling attestation, not cultivation.',
    'NOTE: no source-language original was provided with this translation.',
  ].join('\n'),
  metadata: { filename: 'synthetic-translation.pdf', pageCount: 1 },
}
